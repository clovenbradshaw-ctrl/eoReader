// state.js — core state + persistence + the event log (the fold substrate).
// Globals: graph, sources, allItems, walk, mx, customFeeds, currentView,
// selectedEntity, activeGraphTab, eventLog, scrubAt, dreamCandidates, librarianChat,
// loadSettings/getPrompt/getApiKey/saveSettings/resetPrompt/togglePrompt/toggleKeyVis/flash,
// toggleLpSection, loadCustomFeeds/saveCustomFeeds/addCustomFeed,
// loadGraph/saveGraph/updateGraphCount/toggleGraph/graphTab,
// addSource, downloadJson, escapeAttr, pushEvent, foldEvents, computeRoleProfile.

// ---- core stores ----
let graph = { entities: {}, connections: [] };
let sources = [];
let allItems = [];

let activeFilters = new Set();
let loadedCount = 0;
let errorCount = 0;

let customFeeds = [];

let selectedEntity = null;
let activeGraphTab = 'entities';
let currentView = 'feed';

// walk session
let walk = {
  active: false,
  paused: false,
  idx: null,
  sentences: [],
  current: 0,
  log: [],
};

// matrix client
let mx = {
  homeserver: null,
  accessToken: null,
  userId: null,
  roomId: null,
};

// time scrubber position: null = live (current state), number = unix-ms cutoff
let scrubAt = null;

// dream candidates pending review
let dreamCandidates = [];

// librarian chat transcript
let librarianChat = [];

// summary generator: explicit user picks at any granularity. UI-only state,
// not persisted. See js/summary.js for the renderer + generator.
let summaryPicks = {
  entityIds: new Set(),
  connectionIdxs: new Set(),
  spanRefs: new Set(),
  articleIds: new Set(),
  framing: '',
  includeSources: true,
  includeNotes: true,
  includeHypotheses: true,
  lpExpanded: new Set(),
};
let summaryOutput = null;
let summaryPickerTab = 'entities';

// ---- the event log (append-only, content-hashed, the fold substrate) ----
// Each event is one of: SIG, DEF, CON, EVA, REC, SEG, FEEDBACK, RENAME, DELETE.
// Every event carries provenance: 'source-attested' | 'system-inferred' | 'editor-authored'.
// Five-event .eo abstraction maps onto these: observation->SIG/DEF, anchor->CON,
// def->DEF/REC, rec->REC, horizon->snapshot.
let eventLog = [];

function provenanceLabel(p) {
  if (p === 'source-attested') return 'source';
  if (p === 'system-inferred') return 'system';
  if (p === 'editor-authored') return 'editor';
  return p || 'source';
}

function hashEvent(ev) {
  // small djb2-ish hash, sufficient for content-addressing within a session
  const str = JSON.stringify(ev, Object.keys(ev).sort());
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function pushEvent(ev) {
  const stamped = {
    ts: ev.ts || Date.now(),
    provenance: ev.provenance || 'source-attested',
    ...ev,
  };
  stamped.hash = hashEvent(stamped);
  eventLog.push(stamped);
  return stamped;
}

// ---- the fold ----
// Replay events up to ts (or all if ts is null) into a projected graph snapshot.
// This is THE central mechanism: every "current state" question is answered by
// folding, not by reading a cache. The live `graph` is just fold(eventLog, now).
function foldEvents(events, ts) {
  const entities = {};
  const connections = [];
  for (const e of events) {
    if (ts != null && e.ts > ts) break;
    if (e.op === 'SIG') {
      if (!entities[e.id]) {
        entities[e.id] = {
          canonical: e.canonical || e.id,
          displayName: e.displayName || e.canonical || e.id,
          nameGroup: e.nameGroup || null,
          kind: e.kind || 'Entity',
          subtype: e.subtype || '',
          aliases: e.aliases || [],
          hypothesis: e.hypothesis || '',
          sources: e.source ? [e.source] : [],
          firstSeen: new Date(e.ts).toISOString(),
          defHistory: [{ hypothesis: e.hypothesis || '', span: e.span, ts: e.ts, provenance: e.provenance }],
          spans: e.span ? [e.span] : [],
          evaHistory: [],
        };
      }
    } else if (e.op === 'DEF' && entities[e.id]) {
      const ent = entities[e.id];
      if (e.hypothesis) ent.hypothesis = e.hypothesis;
      if (e.subtype) ent.subtype = e.subtype;
      if (e.displayName) ent.displayName = e.displayName;
      if (e.nameGroup) ent.nameGroup = e.nameGroup;
      ent.defHistory = ent.defHistory || [];
      ent.defHistory.push({ hypothesis: e.hypothesis || '', span: e.span, ts: e.ts, provenance: e.provenance });
      if (e.span) (ent.spans = ent.spans || []).push(e.span);
      if (e.aliases) {
        const have = new Set((ent.aliases || []).map(a => a.toLowerCase()));
        e.aliases.forEach(a => { if (!have.has(a.toLowerCase())) (ent.aliases = ent.aliases || []).push(a); });
      }
      if (e.source) {
        const srcs = ent.sources || [];
        if (!srcs.some(s => s.url === e.source.url)) srcs.push(e.source);
        ent.sources = srcs;
      }
    } else if (e.op === 'CON' && e.from && e.to) {
      const exists = connections.some(c => c.from === e.from && c.to === e.to && c.relation === e.relation);
      if (!exists) {
        connections.push({
          from: e.from, to: e.to,
          relation: e.relation || 'related_to',
          evidence: e.evidence || '',
          confidence: e.confidence || 'medium',
          span: e.span || null,
          sourceUrl: e.source?.url || null,
          sourceTitle: e.source?.title || null,
          sourceId: e.source?.id || e.sourceId || null,
          voice: e.voice || null,
          voiceRelation: e.voiceRelation || null,
          feedback: null,
          provenance: e.provenance,
          ts: e.ts,
        });
      }
    } else if (e.op === 'EVA' && entities[e.id]) {
      const ent = entities[e.id];
      ent.evaHistory = ent.evaHistory || [];
      ent.evaHistory.push({
        verdict: e.verdict, note: e.note, span: e.span,
        ts: e.ts, provenance: e.provenance,
        voice: e.voice || null, voiceRelation: e.voiceRelation || null,
        bySite: e.bySite || 'walk',
        verdictHash: e.verdictHash || null,
      });
    } else if (e.op === 'REC' && entities[e.id]) {
      const ent = entities[e.id];
      if (e.rename && e.rename !== ent.canonical) {
        ent.renames = ent.renames || [];
        ent.renames.push({ from: ent.canonical, to: e.rename, reason: e.reason || '', ts: e.ts, provenance: e.provenance });
        // keep previous canonical as alias
        ent.aliases = ent.aliases || [];
        if (!ent.aliases.includes(ent.canonical)) ent.aliases.push(ent.canonical);
        ent.canonical = e.rename;
      }
    } else if (e.op === 'SEG' && entities[e.id] && Array.isArray(e.into)) {
      const original = entities[e.id];
      e.into.forEach(ns => {
        if (!ns.id || entities[ns.id]) return;
        entities[ns.id] = {
          canonical: ns.canonical || ns.id,
          displayName: ns.displayName || ns.canonical || ns.id,
          nameGroup: ns.nameGroup || null,
          kind: ns.site || ns.kind || original.kind,
          subtype: ns.subtype || '',
          aliases: ns.aliases || [],
          hypothesis: ns.hypothesis || '',
          sources: [...(original.sources || [])],
          firstSeen: new Date(e.ts).toISOString(),
          defHistory: [
            { hypothesis: 'SEG from ' + original.canonical + ': ' + (e.reason || ''), span: e.span, ts: e.ts, provenance: e.provenance },
            { hypothesis: ns.hypothesis || '', span: e.span, ts: e.ts, provenance: e.provenance },
          ],
          spans: [...(original.spans || []), e.span].filter(Boolean),
          segFrom: e.id,
          evaHistory: [],
        };
      });
      // remap connections referencing original to first segment (best-effort)
      if (e.into[0] && e.into[0].id) {
        const firstId = e.into[0].id;
        for (let i = 0; i < connections.length; i++) {
          const c = connections[i];
          if (c.from === e.id) c.from = firstId;
          if (c.to === e.id) c.to = firstId;
        }
      }
      delete entities[e.id];
      for (let i = connections.length - 1; i >= 0; i--) {
        if (connections[i].from === e.id || connections[i].to === e.id) connections.splice(i, 1);
      }
    } else if (e.op === 'FEEDBACK') {
      // editor confirms/corrects a connection
      const c = connections.find(c => c.from === e.from && c.to === e.to && c.relation === e.relation);
      if (c) {
        c.confidence = e.confidence || c.confidence;
        c.feedback = e.note || c.feedback;
      }
    } else if (e.op === 'DELETE') {
      if (e.target === 'entity' && entities[e.id]) {
        delete entities[e.id];
        for (let i = connections.length - 1; i >= 0; i--) {
          if (connections[i].from === e.id || connections[i].to === e.id) connections.splice(i, 1);
        }
      } else if (e.target === 'connection') {
        for (let i = connections.length - 1; i >= 0; i--) {
          const c = connections[i];
          if (c.from === e.from && c.to === e.to && c.relation === e.relation) { connections.splice(i, 1); break; }
        }
      }
    } else if (e.op === 'EDIT' && entities[e.id]) {
      // editor-authored direct field set
      entities[e.id][e.field] = e.value;
    }
  }
  return { entities, connections };
}

// Recompute live graph from log when needed (e.g., after import).
function refoldLive() {
  const snap = foldEvents(eventLog, null);
  graph.entities = snap.entities;
  graph.connections = snap.connections;
}

// Reconstruct an event log from legacy graph data so the scrubber/log view
// still work for indexes built before the rebuild.
function reconstructLogFromGraph() {
  if (eventLog.length || !graph || !graph.entities) return;
  const evs = [];
  for (const [id, e] of Object.entries(graph.entities)) {
    const baseTs = e.firstSeen ? new Date(e.firstSeen).getTime() : Date.now();
    evs.push({
      op: 'SIG', id,
      canonical: e.canonical, kind: e.kind, subtype: e.subtype || '',
      aliases: e.aliases || [], hypothesis: (e.defHistory && e.defHistory[0]?.hypothesis) || e.hypothesis || '',
      span: (e.spans && e.spans[0]) || null,
      source: (e.sources && e.sources[0]) || null,
      ts: baseTs,
      provenance: 'source-attested',
    });
    (e.defHistory || []).slice(1).forEach((d, i) => {
      evs.push({
        op: 'DEF', id,
        hypothesis: d.hypothesis || '',
        span: d.span || null,
        ts: d.ts ? new Date(d.ts).getTime() : baseTs + i + 1,
        provenance: 'source-attested',
      });
    });
  }
  (graph.connections || []).forEach((c, i) => {
    evs.push({
      op: 'CON',
      from: c.from, to: c.to, relation: c.relation,
      evidence: c.evidence || '', confidence: c.confidence || 'medium',
      span: c.span || null,
      source: { title: c.sourceTitle || null, url: c.sourceUrl || null },
      ts: c.ts || (c.span && c.span.ts) || Date.now() - (graph.connections.length - i) * 1000,
      provenance: 'source-attested',
    });
  });
  evs.sort((a, b) => a.ts - b.ts);
  for (const ev of evs) {
    ev.hash = hashEvent(ev);
    eventLog.push(ev);
  }
}

// Role profile: operator distribution per entity. The structural fingerprint —
// what kind of work the text does on this site.
function computeRoleProfile(id) {
  const counts = { SIG: 0, DEF: 0, CON: 0, EVA: 0, REC: 0, SEG: 0 };
  let total = 0;
  for (const ev of eventLog) {
    let touches = false;
    if (ev.id === id) touches = true;
    if ((ev.op === 'CON') && (ev.from === id || ev.to === id)) touches = true;
    if (!touches) continue;
    if (counts[ev.op] != null) { counts[ev.op]++; total++; }
  }
  const dist = {};
  for (const op of Object.keys(counts)) dist[op] = total ? counts[op] / total : 0;
  return { counts, total, dist };
}

// ---- settings ----
function loadSettings() {
  const savedPrompt = localStorage.getItem('plaintext_prompt');
  const savedKey = localStorage.getItem('plaintext_apikey');
  document.getElementById('system-prompt').value = savedPrompt || DEFAULT_PROMPT;
  if (savedKey) document.getElementById('api-key').value = savedKey;
}
function getPrompt() { return document.getElementById('system-prompt').value; }
function getApiKey() { return document.getElementById('api-key').value.trim(); }
function saveSettings() {
  localStorage.setItem('plaintext_prompt', getPrompt());
  const key = getApiKey();
  if (key) localStorage.setItem('plaintext_apikey', key);
  else localStorage.removeItem('plaintext_apikey');
  flash('prompt-saved', 'saved');
  flash('key-saved', 'saved');
}
function resetPrompt() {
  document.getElementById('system-prompt').value = DEFAULT_PROMPT;
  localStorage.removeItem('plaintext_prompt');
  flash('prompt-saved', 'reset');
}
function togglePrompt() { document.getElementById('prompt-editor').classList.toggle('open'); }
function toggleKeyVis(btn) {
  const inp = document.getElementById('api-key');
  if (inp.type === 'password') { inp.type = 'text'; btn.textContent = 'hide'; }
  else { inp.type = 'password'; btn.textContent = 'show'; }
}
function flash(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => { el.classList.remove('show'); el.textContent = 'saved'; }, 1500);
}
function toggleLpSection(name) {
  const section = document.getElementById('section-' + name);
  const caret = document.getElementById('caret-' + name);
  if (!section) return;
  const isHidden = getComputedStyle(section).display === 'none';
  section.style.display = isHidden ? '' : 'none';
  if (caret) caret.classList.toggle('collapsed', !isHidden);
}

// ---- custom feeds ----
function loadCustomFeeds() {
  try {
    const saved = localStorage.getItem('plaintext_custom_feeds');
    if (saved) customFeeds = JSON.parse(saved);
  } catch (e) {}
}
function saveCustomFeeds() {
  localStorage.setItem('plaintext_custom_feeds', JSON.stringify(customFeeds));
}
function addCustomFeed() {
  const urlInput = document.getElementById('add-feed-url');
  const nameInput = document.getElementById('add-feed-name');
  const url = urlInput.value.trim();
  const name = nameInput.value.trim();
  if (!url) return;

  const key = 'custom-' + Date.now();
  const feed = { key, name: name || new URL(url).hostname, url, home: url };
  customFeeds.push(feed);
  SOURCES.push(feed);
  saveCustomFeeds();

  urlInput.value = '';
  nameInput.value = '';

  fetchFeed(feed).then(items => {
    allItems = allItems.concat(items);
    renderItems();
    renderLibrary();
  });

  renderSourcesList();
}

// ---- graph persistence ----
function loadGraph() {
  try {
    const saved = localStorage.getItem('plaintext_graph');
    if (saved) graph = JSON.parse(saved);
    const savedSources = localStorage.getItem('plaintext_sources');
    if (savedSources) sources = JSON.parse(savedSources);
    const savedLog = localStorage.getItem('plaintext_eventlog');
    if (savedLog) eventLog = JSON.parse(savedLog);
  } catch (e) { console.warn('graph load failed', e); }
  if (!eventLog.length && Object.keys(graph.entities || {}).length) {
    reconstructLogFromGraph();
  }
  updateGraphCount();
}
function saveGraph() {
  localStorage.setItem('plaintext_graph', JSON.stringify(graph));
  localStorage.setItem('plaintext_sources', JSON.stringify(sources));
  try {
    localStorage.setItem('plaintext_eventlog', JSON.stringify(eventLog));
  } catch (e) {
    // log got too big — drop oldest 25%
    console.warn('Event log too large for localStorage, trimming');
    eventLog = eventLog.slice(Math.floor(eventLog.length * 0.25));
    localStorage.setItem('plaintext_eventlog', JSON.stringify(eventLog));
  }
  updateGraphCount();
  if (mx.accessToken && mx.roomId) scheduleMatrixSave();
}
function updateGraphCount() {
  const el = document.getElementById('graph-count');
  if (el) el.textContent = Object.keys(graph.entities).length;
}

function showView(view) {
  if (view === 'index' && currentView !== 'index') lastNonIndexView = currentView;
  currentView = view;
  document.getElementById('view-feed').style.display = view === 'feed' ? '' : 'none';
  document.getElementById('view-index').style.display = view === 'index' ? 'flex' : 'none';
  const disc = document.getElementById('view-discover');
  if (disc) disc.style.display = view === 'discover' ? 'flex' : 'none';
  const sum = document.getElementById('view-summarize');
  if (sum) sum.style.display = view === 'summarize' ? 'flex' : 'none';
  const btn = document.getElementById('graph-toggle');
  if (btn) btn.classList.toggle('active', view === 'index');
  const lbl = document.getElementById('graph-toggle-label');
  if (lbl) lbl.textContent = view === 'index' ? 'back' : 'all entities';
  if (view === 'index') renderGraphPanel();
  if (view === 'discover' && typeof renderDiscover === 'function') renderDiscover();
  if (view === 'summarize' && typeof renderSummarizeMainView === 'function') renderSummarizeMainView();
}

function toggleGraph() {
  if (currentView === 'index') {
    showView(lastNonIndexView === 'index' ? 'feed' : lastNonIndexView);
  } else {
    showView('index');
  }
}

let lastNonIndexView = 'feed';
let lastNonDiscoverView = 'feed';
function openDiscover() {
  if (currentView !== 'discover') lastNonDiscoverView = currentView;
  showView('discover');
}
function closeDiscover() {
  showView(lastNonDiscoverView === 'discover' ? 'feed' : lastNonDiscoverView);
}

function graphTab(tab) {
  activeGraphTab = tab;
  document.querySelectorAll('.index-toolbar .graph-tab').forEach(t => t.classList.remove('active'));
  const tabEl = document.getElementById('tab-' + tab);
  if (tabEl) tabEl.classList.add('active');
  renderGraphPanel();
}

// ---- source management ----
function addSource(title, url, sourceName, body, date) {
  const id = 'src-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const src = {
    id,
    title: title || '(untitled)',
    url: url || null,
    sourceName: sourceName || 'manual',
    body: body,
    date: date || new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    sitesFound: [],
    processed: false,
  };
  sources.unshift(src);
  saveGraph();

  allItems.unshift({
    title: src.title,
    link: src.url || '',
    snippet: body.slice(0, 600),
    body: body,
    date: new Date(src.date),
    source: 'manual',
    sourceName: src.sourceName,
    sourceHome: src.url || '',
    _sourceId: id,
  });
  renderItems();
  renderLibrary();
  return id;
}

// Pair freshly-fetched RSS items with their saved sources so runtime flags
// like _processed survive page reload.
function hydrateProcessedFlags() {
  if (!Array.isArray(allItems) || !Array.isArray(sources)) return;
  allItems.forEach(it => {
    const src = sources.find(s =>
      (it._sourceId && s.id === it._sourceId) ||
      (s.url && it.link && s.url === it.link)
    );
    if (!src) return;
    if (!it._sourceId) it._sourceId = src.id;
    if (src.processed) it._processed = true;
  });
}

// ---- voice/provenance prompt helpers ----
// Single source of truth for how a span or a connection is rendered into
// LLM-bound context. Every prompt builder (walk targeted context, digest,
// summary, librarian, dream) routes spans/cons through these so voice
// attribution travels with the text, not silently stripped off.
function voiceCanonicalFor(id) {
  if (!id) return null;
  const e = graph.entities[id];
  return e ? (e.canonical || id) : id;
}

function formatSpanForPrompt(sp, opts) {
  if (!sp) return '';
  opts = opts || {};
  const max = opts.max || 220;
  const v = voiceCanonicalFor(sp.voice);
  const rel = sp.voiceRelation;
  const pub = sp.sourceTitle || '';
  const attrib = v
    ? 'according to ' + v + (rel ? ' (' + rel + ')' : '') + (pub ? ' in ' + pub : '')
    : (pub ? 'in ' + pub : 'unattributed');
  return '"' + (sp.text || '').slice(0, max) + '" — ' + attrib;
}

function formatConnectionForPrompt(c, opts) {
  if (!c) return '';
  opts = opts || {};
  const fn = voiceCanonicalFor(c.from) || c.from;
  const tn = voiceCanonicalFor(c.to) || c.to;
  const v = voiceCanonicalFor(c.voice);
  const rel = c.voiceRelation;
  const attrib = v ? ' [according to ' + v + (rel ? ' (' + rel + ')' : '') + ']' : '';
  const evMax = opts.evidenceMax || 180;
  const ev = c.evidence ? ' — "' + c.evidence.slice(0, evMax) + '"' : '';
  return '`' + c.from + '` (' + fn + ') --[' + c.relation
       + (c.confidence ? ', ' + c.confidence : '') + ']--> `' + c.to + '` (' + tn + ')'
       + attrib + ev;
}

// Returns distinct (voiceId, voiceRelation) pairs across an entity's spans.
// Used by buildSentenceContext to surface "Voices on record" so the walk's
// DEF/EVA decisions weigh attribution, not just text.
function voicesOnRecord(e) {
  if (!e || !e.spans) return [];
  const seen = new Set();
  const out = [];
  for (const sp of e.spans) {
    if (!sp || !sp.voice) continue;
    const key = sp.voice + '|' + (sp.voiceRelation || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ voice: sp.voice, voiceRelation: sp.voiceRelation || null, canonical: voiceCanonicalFor(sp.voice) });
  }
  return out;
}

// ---- utilities ----
function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
