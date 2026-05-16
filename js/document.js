// document.js — the document-centric workspace. Opening a library row lands
// here: the document text with extracted sites highlighted inline, plus
// Read / Chat / Summary tabs scoped to the open doc (and any other docs
// toggled on in the source strip). Clicking an inline site opens a profile
// drawer. This view is the spine the app is built around.

let currentDocId = null;
let currentDocTab = 'read';

function currentDoc() {
  return sources.find(s => s.id === currentDocId) || null;
}

// Every walk/digest path keys off an allItems entry. Make sure the open
// source has one (uploaded files and walked feed items already do; older
// persisted sources may not).
function ensureItemForSource(s) {
  let i = allItems.findIndex(it =>
    (it._sourceId && it._sourceId === s.id) ||
    (s.url && it.link && it.link === s.url));
  if (i >= 0) { allItems[i]._sourceId = s.id; return i; }
  allItems.push({
    title: s.title,
    link: s.url || '',
    snippet: (s.body || '').slice(0, 600),
    body: s.body || '',
    date: s.date ? new Date(s.date) : new Date(),
    source: 'manual',
    sourceName: s.sourceName || 'manual',
    sourceHome: s.url || '',
    _sourceId: s.id,
    _processed: !!s.processed,
  });
  return allItems.length - 1;
}

// ---- entry point ----

function openDocument(id) {
  const s = sources.find(x => x.id === id);
  if (!s) return;
  currentDocId = id;
  currentDocTab = 'read';
  s.lastInteracted = Date.now();
  saveGraph();
  // Opening a doc adds it to the chat/summary scope; the user can still
  // toggle it back off from the source strip.
  const idx = ensureItemForSource(s);
  const key = summaryArticleKey(allItems[idx]);
  if (key) summaryPicks.articleIds.add(key);
  showView('document');
}

function docTab(tab) {
  currentDocTab = tab;
  renderDocument();
}

// ---- full workspace render ----

function renderDocument() {
  const root = document.getElementById('view-document');
  if (!root) return;
  const s = currentDoc();
  if (!s) {
    root.innerHTML = '<div class="lib-empty">no document open — pick one from the library.</div>';
    return;
  }
  const processed = !!s.processed;
  const enabledCount = summaryPicks.articleIds.size;
  const visibleSources = sources.filter(x => !x.hidden);

  let html = '';

  // header
  html += '<div class="doc-header"><div class="doc-header-main">';
  html += '<div class="doc-title">' + escapeAttr(s.title || '(untitled)') + '</div>';
  html += '<div class="doc-meta">' + escapeAttr(s.sourceName || '') + ' · ' +
    new Date(s.ingestedAt || s.date).toLocaleDateString() +
    (s.url ? ' · <a href="' + escapeAttr(s.url) + '" target="_blank" style="color:var(--text-dim);">link</a>' : '') +
    '</div></div>';
  html += '<div class="doc-header-actions">';
  html += '<button class="act-btn" onclick="showView(\'library\')"><i class="ph ph-arrow-left"></i> library</button>';
  html += '<button class="act-btn" onclick="location.href=\'editor.html\'" title="Write a minisite post"><i class="ph ph-pencil-simple"></i> draft post</button>';
  html += '<button class="act-btn" onclick="docProcess()"><i class="ph ' +
    (processed ? 'ph-arrows-clockwise' : 'ph-cpu') + '"></i> ' +
    (processed ? 'reprocess' : 'process') + '</button>';
  html += '<button class="act-btn" style="color:#c06060;border-color:#c06060;" onclick="docDelete()"><i class="ph ph-trash"></i></button>';
  html += '</div></div>';

  // tabs
  html += '<div class="doc-tabs">';
  ['read', 'chat', 'summary'].forEach(t => {
    html += '<button class="doc-tab' + (currentDocTab === t ? ' active' : '') +
      '" onclick="docTab(\'' + t + '\')">' + t + '</button>';
  });
  html += '<div style="flex:1;"></div>';
  html += '<span style="font-size:10px;color:var(--text-dim);">' + enabledCount +
    ' source' + (enabledCount === 1 ? '' : 's') + ' in chat/summary scope</span>';
  html += '</div>';

  // multi-document source scope — always visible chip bar (wireframe 4·V1)
  html += '<div class="doc-sources-bar">';
  html += '<span class="doc-sources-label"><i class="ph ph-stack"></i> in scope · ' +
    enabledCount + ' of ' + visibleSources.length + ' docs feed chat &amp; summary</span>';
  html += '<div class="doc-sources-body">' + renderDocSourceStrip(visibleSources) + '</div>';
  html += '</div>';

  // active tab pane
  html += '<div id="doc-pane"></div>';

  // site profile drawer (overlay)
  html += '<aside id="site-drawer" hidden>' +
    '<div class="drawer-head">' +
      '<span class="drawer-title lp-label" style="margin:0;">site</span>' +
      '<button class="act-btn" style="padding:2px 6px;" onclick="closeSiteDrawer()"><i class="ph ph-x"></i></button>' +
    '</div><div class="drawer-body"></div></aside>';

  root.innerHTML = html;
  renderDocPane();
}

function renderDocPane() {
  const pane = document.getElementById('doc-pane');
  if (!pane) return;
  const s = currentDoc();
  if (!s) { pane.innerHTML = ''; return; }
  if (currentDocTab === 'chat') {
    pane.innerHTML = renderChatPane();
    const t = document.getElementById('summary-transcript');
    if (t) t.scrollTop = t.scrollHeight;
  } else if (currentDocTab === 'summary') {
    pane.innerHTML = renderDocSummaryTab(s);
  } else {
    pane.innerHTML = renderDocReadTab(s);
  }
}

// ---- source strip ----

// Each chip is two distinct controls: a padded checkbox that toggles whether
// the source feeds chat/summary, and the name which opens the document. They
// are siblings (the chip wrapper itself has no click handler) so a click can
// never be ambiguous between "toggle scope" and "open doc".
function renderDocSourceStrip(visibleSources) {
  if (!visibleSources.length) return '<div style="padding:6px 16px;font-size:10px;color:var(--text-dim);">no documents.</div>';
  // current doc anchored first, rest follow
  const ordered = visibleSources.slice().sort((a, b) =>
    (a.id === currentDocId ? -1 : 0) - (b.id === currentDocId ? -1 : 0));
  let html = '';
  ordered.forEach(s => {
    const idx = ensureItemForSource(s);
    const key = summaryArticleKey(allItems[idx]);
    const enabled = summaryPicks.articleIds.has(key);
    const isCurrent = s.id === currentDocId;
    const meta = s.processed ? countDocSites(s.url, s.title) + ' sites' : 'new';
    const toggleTitle = enabled
      ? 'in chat/summary scope — click to remove'
      : 'not in scope — click to add to chat/summary';
    html += '<span class="doc-src-chip' + (isCurrent ? ' current' : '') + (enabled ? ' on' : '') + '">';
    html += '<button type="button" class="dsc-toggle' + (enabled ? ' on' : '') +
      '" title="' + escapeAttr(toggleTitle) + '" onclick="docToggleSource(\'' +
      escapeAttr(s.id) + '\')"><i class="ph ' +
      (enabled ? 'ph-check-square' : 'ph-square') + '"></i></button>';
    html += '<span class="dsc-name" title="' + escapeAttr('open document · ' + meta) +
      '" onclick="openDocument(\'' + escapeAttr(s.id) + '\')">' +
      escapeAttr(s.title || '(untitled)') + '</span>';
    html += '</span>';
  });
  return html;
}

function docToggleSource(id) {
  const s = sources.find(x => x.id === id);
  if (!s) return;
  const idx = ensureItemForSource(s);
  const key = summaryArticleKey(allItems[idx]);
  if (summaryPicks.articleIds.has(key)) {
    summaryPicks.articleIds.delete(key);
  } else {
    summaryPicks.articleIds.add(key);
  }
  renderDocument();
}

// ---- read tab + inline site highlighting ----

// Map sentence index -> Set of entity ids extracted from that sentence.
// Spans anchor to a sentence via span.text (the sentence itself);
// span.sentenceIdx is only a tie-breaker for repeated text.
function docHighlightMap(source, sentences) {
  const norm = t => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const normSent = sentences.map(norm);
  const map = new Map();
  Object.entries(graph.entities).forEach(([id, e]) => {
    (e.spans || []).forEach(sp => {
      if (!sp || !sp.text) return;
      const matchUrl = source.url && sp.sourceUrl && sp.sourceUrl === source.url;
      const matchTitle = (!sp.sourceUrl || !source.url) && source.title && sp.sourceTitle === source.title;
      if (!matchUrl && !matchTitle) return;
      const nt = norm(sp.text);
      if (!nt) return;
      const cands = [];
      for (let i = 0; i < normSent.length; i++) {
        if (normSent[i] === nt || normSent[i].includes(nt) || nt.includes(normSent[i])) cands.push(i);
      }
      let chosen = -1;
      if (cands.length === 1) {
        chosen = cands[0];
      } else if (cands.length > 1) {
        const want = (sp.sentenceIdx != null) ? sp.sentenceIdx : cands[0];
        chosen = cands.reduce((b, c) => Math.abs(c - want) < Math.abs(b - want) ? c : b, cands[0]);
      } else if (sp.sentenceIdx != null && sp.sentenceIdx >= 0 && sp.sentenceIdx < sentences.length) {
        chosen = sp.sentenceIdx;
      }
      if (chosen >= 0) {
        if (!map.has(chosen)) map.set(chosen, new Set());
        map.get(chosen).add(id);
      }
    });
  });
  return map;
}

function renderDocReadBody(source) {
  const body = source.body || '';
  if (!body.trim()) return '<div class="doc-read-body" style="color:var(--text-dim);">(no content)</div>';
  const sentences = splitSentences(body);
  if (!sentences.length) {
    return '<div class="doc-read-body"><p>' + escapeAttr(body) + '</p></div>';
  }
  const map = docHighlightMap(source, sentences);
  let inner = '';
  let cursor = 0;
  sentences.forEach((sent, i) => {
    const probe = sent.slice(0, 40);
    const pos = body.indexOf(probe, cursor);
    if (pos > cursor) {
      const gap = body.slice(cursor, pos);
      if (/\n\s*\n/.test(gap)) inner += '</p><p style="margin:0 0 14px;">';
      else if (/\n/.test(gap)) inner += ' ';
    }
    if (pos >= 0) cursor = pos + sent.length;
    const ids = map.get(i);
    if (ids && ids.size) {
      const idArr = [...ids];
      const kind = (graph.entities[idArr[0]] || {}).kind || 'Entity';
      inner += '<mark class="doc-site-hl" data-kind="' + escapeAttr(kind) +
        '" onclick="openSiteDrawer(\'' + escapeAttr(idArr.join(',')) + '\')">' +
        escapeAttr(sent) + '</mark> ';
    } else {
      inner += escapeAttr(sent) + ' ';
    }
  });
  return '<div class="doc-read-body"><p style="margin:0 0 14px;">' + inner + '</p></div>';
}

function renderDocReadTab(s) {
  let html = '<div style="flex:1;overflow-y:auto;">';
  if (!s.processed) {
    html += '<div style="padding:12px 22px;color:var(--text-dim);font-size:11px;">' +
      '<i class="ph ph-info"></i> not yet processed — click <strong>process</strong> above to extract sites. ' +
      'Once processed, sites appear highlighted inline in the text.</div>';
  } else {
    const n = countDocSites(s.url, s.title);
    html += '<div style="padding:12px 22px;color:var(--text-dim);font-size:11px;">' +
      '<i class="ph ph-map-pin"></i> ' + n + ' site' + (n === 1 ? '' : 's') +
      ' extracted — click any underlined passage to open its profile.</div>';
  }
  html += renderDocReadBody(s);
  if (s.processed && typeof renderReprocessHistory === 'function') {
    const rh = renderReprocessHistory(s);
    if (rh) html += '<div style="padding:0 22px 22px;max-width:760px;">' + rh + '</div>';
  }
  html += '</div>';
  return html;
}

// ---- summary tab ----

function renderDocSummaryTab(s) {
  const idx = ensureItemForSource(s);
  const item = allItems[idx];
  let html = '<div style="flex:1;overflow-y:auto;padding:18px 22px;">';
  html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">';
  html += '<button class="act-btn" onclick="docGenerate(this)"><i class="ph ph-lightning"></i> ' +
    (item.generatedRaw ? 'regenerate' : 'generate') + ' formatted output</button>';
  if (summaryPicks.articleIds.size > 1) {
    html += '<button class="act-btn" onclick="generateSummaryFromPicks()"><i class="ph ph-files"></i> digest all ' +
      summaryPicks.articleIds.size + ' sources</button>';
  }
  html += '</div>';
  if (item.generatedRaw) {
    html += '<div class="claude-output visible" style="margin:0;max-width:760px;">' +
      '<div class="rendered-entry">' + mdToHtml(item.generatedRaw, { linkNodes: true }) + '</div></div>';
  } else {
    html += '<div style="color:var(--text-dim);font-size:12px;max-width:680px;line-height:1.6;">' +
      'No formatted output yet. Click <strong>generate</strong> to produce a digest of this document' +
      (s.processed ? '' : ' (it will be processed first)') + '. ' +
      'Use <em>digest all sources</em> to summarize across every document toggled on in the source strip above.</div>';
  }
  html += '</div>';
  return html;
}

// ---- actions ----

async function docProcess() {
  const s = currentDoc();
  if (!s) return;
  const idx = ensureItemForSource(s);
  try { await startWalk(idx); } catch (e) { console.warn('walk failed', e); }
  if (sources.find(x => x.id === s.id)) openDocument(s.id);
}

async function docGenerate(btn) {
  const s = currentDoc();
  if (!s) return;
  const idx = ensureItemForSource(s);
  try { await generateDigest(idx, btn); } catch (e) { console.warn('digest failed', e); }
  if (currentView === 'document' && currentDocTab === 'summary') renderDocPane();
}

async function docDelete() {
  const s = currentDoc();
  if (!s) return;
  const idx = sources.findIndex(x => x.id === s.id);
  if (idx < 0) return;
  if (!(await showConfirm('Delete this document?', { okLabel: 'Delete', title: 'Confirm delete' }))) return;
  sources.splice(idx, 1);
  saveGraph();
  currentDocId = null;
  renderLibrary();
  showView('library');
}

// ---- site profile drawer ----

function openSiteDrawer(idsStr) {
  const ids = String(idsStr).split(',').filter(Boolean);
  const drawer = document.getElementById('site-drawer');
  if (!drawer || !ids.length) return;
  drawer.hidden = false;
  const body = drawer.querySelector('.drawer-body');
  const title = drawer.querySelector('.drawer-title');
  if (ids.length === 1) {
    if (title) title.textContent = (graph.entities[ids[0]] || {}).canonical || 'site';
    renderEntityDetail(ids[0], body, 'openSiteDrawer');
  } else {
    if (title) title.textContent = ids.length + ' sites here';
    body.innerHTML = ids.map(id => {
      const e = graph.entities[id];
      if (!e) return '';
      return '<div class="lp-item" onclick="openSiteDrawer(\'' + escapeAttr(id) + '\')">' +
        '<div style="flex:1;min-width:0;"><div class="lp-title">' + escapeAttr(e.canonical) + '</div>' +
        '<div class="lp-meta">' + escapeAttr(e.kind || '') + '</div></div></div>';
    }).join('');
  }
}

function closeSiteDrawer() {
  const drawer = document.getElementById('site-drawer');
  if (drawer) drawer.hidden = true;
}

// ---- glue: re-host the chat renderer inside the workspace ----
// summary.js's chat machinery (summaryAsk, generateSummaryFromPicks,
// renderChatPane, ...) calls renderSummarize()/renderSummarizeMainIfActive()
// to refresh. Re-point those at the workspace's chat pane. These definitions
// load after summary.js, so they win.

function renderSummarize() {
  if (currentView === 'document') renderDocPane();
}
function renderSummarizeMainIfActive() {
  if (currentView === 'document') renderDocPane();
  if (typeof updateSummarizeCompPill === 'function') updateSummarizeCompPill();
}
function renderSummarizeMainView() { renderDocPane(); }

// The old standalone "chat with docs" entry point — route to the open
// document's Chat tab, or the library if nothing is open.
function switchToSummarizeView() {
  if (currentDocId) {
    currentDocTab = 'chat';
    showView('document');
  } else {
    showView('library');
  }
}

// Entity-detail "chat with docs" button.
function openSummaryWithEntity(id) {
  switchToSummarizeView();
}
