// librarian-analyzer.js — mechanical graph traversal + token telemetry + DEF/EVA/REC
// suggestions for the librarian. The router decides which slice of the graph to
// load; the catalog answers meta-questions without spans; the analyzer scores each
// step and (on threshold breach) asks Claude for one EVA pass.
//
// Token counts are always mechanical: they come from the API's `usage` object,
// never from model self-report. Pre-call sizing uses a ~chars/4 estimator only
// to decide whether to gate a turn before we spend the round-trip.

const LIBRARIAN_BUDGET_INPUT_TOKENS = 4000;
const LIBRARIAN_LLM_EVA_THRESHOLD_INPUT_TOKENS = 6000;
const LIBRARIAN_MAX_ENTITIES_DEFAULT = 30;

let librarianTelemetryLog = [];
let librarianSuggestions = [];
let lastLibrarianCatalog = null;

// ---------- mechanical catalog ----------

function buildLibrarianCatalog() {
  const cat = {
    builtAt: Date.now(),
    totalEntities: 0,
    totalConnections: (graph.connections || []).length,
    byKind: {},
    bySubtype: {},
    bySource: {},
    byRelation: {},
    feedRegistry: (typeof SOURCES !== 'undefined' ? SOURCES.map(s => ({ key: s.key, name: s.name, home: s.home })) : []),
    topByDegree: [],
  };

  const degree = {};
  for (const c of (graph.connections || [])) {
    degree[c.from] = (degree[c.from] || 0) + 1;
    degree[c.to] = (degree[c.to] || 0) + 1;
    const r = c.relation || 'related_to';
    cat.byRelation[r] = (cat.byRelation[r] || 0) + 1;
  }

  for (const [id, e] of Object.entries(graph.entities || {})) {
    cat.totalEntities++;
    const k = e.kind || 'Entity';
    cat.byKind[k] = (cat.byKind[k] || 0) + 1;
    if (e.subtype) cat.bySubtype[e.subtype] = (cat.bySubtype[e.subtype] || 0) + 1;
    for (const sp of (e.spans || [])) {
      const src = sp.sourceTitle || 'unknown';
      if (!cat.bySource[src]) cat.bySource[src] = { spans: 0, entities: new Set() };
      cat.bySource[src].spans++;
      cat.bySource[src].entities.add(id);
    }
  }

  // flatten source entity sets to counts
  for (const src of Object.keys(cat.bySource)) {
    cat.bySource[src] = { spans: cat.bySource[src].spans, entities: cat.bySource[src].entities.size };
  }

  cat.topByDegree = Object.entries(degree)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([id, d]) => ({ id, degree: d, canonical: graph.entities[id]?.canonical || id }));

  cat._degree = degree;
  lastLibrarianCatalog = cat;
  return cat;
}

function formatCatalogForPrompt(cat) {
  const lines = ['INDEX CATALOG (mechanical aggregate, no spans):'];
  lines.push('Totals: ' + cat.totalEntities + ' sites, ' + cat.totalConnections + ' connections.');

  const kinds = Object.entries(cat.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length) lines.push('Sites by terrain: ' + kinds.map(([k, n]) => k + ' (' + n + ')').join(', ') + '.');

  const subs = Object.entries(cat.bySubtype).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (subs.length) lines.push('Top subtypes: ' + subs.map(([s, n]) => s + ' (' + n + ')').join(', ') + '.');

  const rels = Object.entries(cat.byRelation).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (rels.length) lines.push('Top relations: ' + rels.map(([r, n]) => r + ' (' + n + ')').join(', ') + '.');

  const srcs = Object.entries(cat.bySource).sort((a, b) => b[1].spans - a[1].spans).slice(0, 20);
  if (srcs.length) {
    lines.push('Sources observed (sourceTitle on spans):');
    srcs.forEach(([s, v]) => lines.push('  - ' + s + ': ' + v.spans + ' spans across ' + v.entities + ' sites'));
  }

  if (cat.feedRegistry.length) {
    lines.push('Feed registry (configured sources, not necessarily walked yet):');
    cat.feedRegistry.forEach(s => lines.push('  - ' + s.name + ' (' + s.key + ')'));
  }

  if (cat.topByDegree.length) {
    lines.push('Most-connected sites:');
    cat.topByDegree.slice(0, 10).forEach(t => lines.push('  - `' + t.id + '` (' + t.canonical + ') deg=' + t.degree));
  }

  return lines.join('\n');
}

// ---------- mechanical router ----------

const META_PATTERNS = [
  /\bwhat\s+(kind|type|types|sort|sources?|info|information|topics?|themes?|categor(?:y|ies)|terrains?|subtypes?|do\s+(?:we|you)\s+have)\b/i,
  /\bhow\s+many\b/i,
  /\b(list|show|give\s+me|tell\s+me)\s+(?:the\s+)?(sources?|kinds?|types?|sites?|entities?|terrains?|subtypes?|relations?)\b/i,
  /\b(overview|summary|catalog|inventory)\b/i,
  /\bwhat'?s?\s+(in|covered|indexed)\b/i,
];

const CONNECTION_PATTERNS = [
  /\bconnect(s|ed|ion|ions)?\b/i,
  /\bbetween\b/i,
  /\brelate[ds]?\b/i,
  /\blink(s|ed)?\b/i,
  /\btie[sd]?\s+to\b/i,
  /\bpath\s+from\b/i,
];

const STOPWORDS = new Set([
  'a','an','the','of','to','in','on','for','and','or','but','is','are','was','were',
  'be','been','being','do','does','did','have','has','had','i','we','you','they','it',
  'this','that','these','those','what','which','who','whom','whose','where','when','why','how',
  'about','from','with','as','at','by','if','so','than','then','too','very','can','will','just',
  'one','two','three','some','any','all','more','most','other','such','no','not','only','own',
  'same','say','says','tell','tells','show','shows','give','gives','list','lists',
]);

function routeLibrarianQuestion(question) {
  const q = (question || '').trim();
  const lower = q.toLowerCase();

  let metaScore = 0;
  for (const p of META_PATTERNS) if (p.test(q)) metaScore++;

  let connectionScore = 0;
  for (const p of CONNECTION_PATTERNS) if (p.test(q)) connectionScore++;

  // mechanical entity match — word-boundary, length-gated, stopword-filtered
  const matched = new Set();
  const ents = graph.entities || {};
  for (const [id, e] of Object.entries(ents)) {
    const names = [e.canonical, ...(e.aliases || [])].filter(Boolean);
    for (const n of names) {
      const nl = n.toLowerCase();
      if (nl.length < 3) continue;
      if (STOPWORDS.has(nl)) continue;
      const re = new RegExp('\\b' + nl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (re.test(q)) { matched.add(id); break; }
    }
  }

  let route;
  if (metaScore > 0 && matched.size === 0) route = 'meta';
  else if (connectionScore > 0 && matched.size >= 1) route = 'connection';
  else if (matched.size >= 1) route = 'entity';
  else if (metaScore > 0) route = 'meta';
  else route = 'broad';

  return {
    route,
    matchedEntities: [...matched],
    signals: { metaScore, connectionScore, namedHits: matched.size, tokens: lower.split(/\s+/).filter(Boolean).length },
  };
}

// ---------- mechanical context builder ----------

function buildLibrarianContextMechanical(question, routeInfo) {
  const cat = buildLibrarianCatalog();
  const composition = { route: routeInfo.route, entities: 0, connections: 0, spans: 0, catalogBytes: 0, conversationTurns: 0 };
  const lines = [];

  if (routeInfo.route === 'meta') {
    lines.push(formatCatalogForPrompt(cat));
    composition.catalogBytes = lines.join('\n').length;
    return { context: lines.join('\n'), composition, focused: [] };
  }

  const focused = new Set(routeInfo.matchedEntities);
  if (routeInfo.route === 'connection' || routeInfo.route === 'entity') {
    for (const id of [...focused]) {
      (graph.connections || []).forEach(c => {
        if (c.from === id || c.to === id) { focused.add(c.from); focused.add(c.to); }
      });
    }
  }

  if (routeInfo.route === 'broad' || focused.size === 0) {
    // mechanical fallback: top-degree from the precomputed map (no rescan)
    const topIds = cat.topByDegree.slice(0, LIBRARIAN_MAX_ENTITIES_DEFAULT).map(t => t.id);
    topIds.forEach(id => focused.add(id));
    // also include the bare catalog so meta-questions in fallback still answer well
    lines.push(formatCatalogForPrompt(cat));
    composition.catalogBytes = lines.join('\n').length;
    lines.push('');
  }

  const includeSpans = routeInfo.route === 'entity' || routeInfo.route === 'connection';
  const wantsEvidence = /\b(quote|evidence|say|said|wrote|source|cite|excerpt|span)\b/i.test(question);

  lines.push('FOCUSED SITES:');
  for (const id of focused) {
    const e = graph.entities[id];
    if (!e) continue;
    composition.entities++;
    lines.push('Site `' + id + '` — ' + e.canonical + ' (' + e.kind + (e.subtype ? ', ' + e.subtype : '') + ')');
    if (e.hypothesis) lines.push('  hypothesis: ' + e.hypothesis);
    if (e.aliases && e.aliases.length) lines.push('  aliases: ' + e.aliases.join(', '));
    const evs = e.evaHistory || [];
    if (evs.length && (routeInfo.route === 'entity' || wantsEvidence)) {
      lines.push('  evaluations: ' + evs.map(v => v.verdict + (v.note ? ' (' + v.note + ')' : '')).join('; '));
    }
    if (includeSpans && wantsEvidence) {
      const spans = (e.spans || []).slice(0, 2);
      spans.forEach(sp => { lines.push('  span: "' + (sp.text || '').slice(0, 200) + '" — ' + (sp.sourceTitle || '')); composition.spans++; });
    } else if (includeSpans && routeInfo.route === 'entity' && (e.spans || []).length) {
      const sp = e.spans[0];
      lines.push('  example span: "' + (sp.text || '').slice(0, 160) + '" — ' + (sp.sourceTitle || ''));
      composition.spans++;
    }
  }

  const focusedCons = (graph.connections || []).filter(c => focused.has(c.from) && focused.has(c.to));
  if (focusedCons.length) {
    lines.push('');
    lines.push('CONNECTIONS:');
    const cap = routeInfo.route === 'connection' ? 80 : 40;
    focusedCons.slice(0, cap).forEach(c => {
      const fn = graph.entities[c.from]?.canonical || c.from;
      const tn = graph.entities[c.to]?.canonical || c.to;
      lines.push('  `' + c.from + '` (' + fn + ') --[' + c.relation + ', ' + (c.confidence || '?') + ']--> `' + c.to + '` (' + tn + ')' + (c.evidence ? ' — ' + c.evidence : ''));
      composition.connections++;
    });
  }

  return { context: lines.join('\n'), composition, focused: [...focused] };
}

// ---------- token estimator (pre-call only) ----------

function estimateTokens(s) {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

// ---------- local rules analyzer (DEF / EVA / REC) ----------

function analyzeLibrarianStep(step) {
  const suggestions = [];
  const cost = step.usage ? (step.usage.input_tokens || 0) : 0;
  const route = step.routeInfo?.route;
  const comp = step.composition || {};

  // DEF — describe what this step is doing, mechanically
  suggestions.push({
    op: 'DEF',
    note: 'librarian turn: route=' + route +
      ', named=' + (step.routeInfo?.signals?.namedHits || 0) +
      ', entities=' + comp.entities + ', connections=' + comp.connections + ', spans=' + comp.spans +
      ', input_tokens=' + cost + ', output_tokens=' + (step.usage?.output_tokens || 0) +
      ', ms=' + (step.ms || '?'),
  });

  // EVA — judge cost vs verdict
  if (cost > LIBRARIAN_BUDGET_INPUT_TOKENS) {
    suggestions.push({ op: 'EVA', verdict: 'tension', note: 'input tokens ' + cost + ' exceeded budget ' + LIBRARIAN_BUDGET_INPUT_TOKENS });
  } else if (cost > 0) {
    suggestions.push({ op: 'EVA', verdict: 'holds', note: 'input tokens ' + cost + ' under budget ' + LIBRARIAN_BUDGET_INPUT_TOKENS });
  }

  // REC — mechanical inefficiency detectors
  if (route === 'meta' && (comp.spans > 0 || comp.connections > 0)) {
    suggestions.push({ op: 'REC', target: 'librarian-analyzer.js:buildLibrarianContextMechanical', rec: 'meta route should be catalog-only; spans/connections leaked in', reason: 'meta questions answer from aggregates' });
  }
  if (route === 'broad' && comp.spans > 0) {
    suggestions.push({ op: 'REC', target: 'librarian-analyzer.js:buildLibrarianContextMechanical', rec: 'broad fallback should not include spans', reason: 'spans dominate prompt for un-grounded questions' });
  }
  if (comp.entities > LIBRARIAN_MAX_ENTITIES_DEFAULT) {
    suggestions.push({ op: 'REC', target: 'librarian-analyzer.js:LIBRARIAN_MAX_ENTITIES_DEFAULT', rec: 'tighten focus set, currently ' + comp.entities, reason: 'cap focused entities or stratify by degree' });
  }
  if (route === 'broad' && step.routeInfo?.signals?.metaScore === 0) {
    suggestions.push({ op: 'REC', target: 'librarian-analyzer.js:META_PATTERNS', rec: 'question slipped to broad — extend META/CONNECTION patterns', reason: 'unrouted question: ' + JSON.stringify(step.question).slice(0, 120) });
  }
  if (comp.connections > 0 && route === 'entity' && step.routeInfo?.signals?.namedHits === 1 && comp.connections > 20) {
    suggestions.push({ op: 'REC', target: 'librarian.js context', rec: 'single-entity question pulled ' + comp.connections + ' connections; cap at 1-hop top-N by confidence', reason: 'connection cap too generous for single-entity questions' });
  }
  if (cost === 0 && step.usage) {
    suggestions.push({ op: 'REC', target: 'api.js usage', rec: 'usage.input_tokens was 0 — verify Anthropic response shape did not change', reason: 'mechanical-count guarantee depends on this field' });
  }

  return suggestions;
}

// ---------- threshold LLM EVA pass ----------

const LIBRARIAN_EVA_PROMPT = `You are an efficiency analyzer for a knowledge-index librarian. You receive one turn's telemetry: the user question, the route the system chose, the composition of the prompt (counts of entities/connections/spans), and the mechanical token usage from the API. Identify whether prompt content was wasted on the question, and propose specific mechanical changes (router rules, context-shape changes, catalog additions) that would have answered the same question cheaper.

Return ONLY a JSON array of EO ops:
[
  {"op": "EVA", "verdict": "holds|tension|contradiction", "note": "..."},
  {"op": "REC", "target": "file or function name", "rec": "specific change", "reason": "why"}
]
Do not include DEF; the local analyzer emits DEF mechanically. No prose outside the JSON.`;

async function maybeRunLLMEva(step) {
  const cost = step.usage?.input_tokens || 0;
  const hasTension = (step.suggestions || []).some(s => s.op === 'EVA' && s.verdict === 'tension');
  if (cost < LIBRARIAN_LLM_EVA_THRESHOLD_INPUT_TOKENS && !hasTension) return;
  if (!getApiKey()) return;

  const payload = {
    question: step.question,
    route: step.routeInfo?.route,
    signals: step.routeInfo?.signals,
    composition: step.composition,
    usage: step.usage,
    ms: step.ms,
    promptPreview: (step.contextPreview || '').slice(0, 1200),
  };

  try {
    const r = await callClaudeRaw(LIBRARIAN_EVA_PROMPT, JSON.stringify(payload, null, 2), 600);
    const m = r.text.match(/\[[\s\S]*\]/);
    if (!m) return;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return;
    step.suggestions = (step.suggestions || []).concat(arr.map(s => ({ ...s, source: 'llm' })));
    step.evaPassUsage = r.usage;
    librarianSuggestions.push({ ts: Date.now(), turnTs: step.ts, fromLLM: true, items: arr });
    if (typeof renderLibrarianView === 'function') renderLibrarianView();
  } catch (e) {
    // analyzer failures must not break the librarian
    console.warn('librarian llm eva failed', e);
  }
}

// ---------- panel rendering ----------

function librarianTelemetryPanelHtml(step) {
  if (!step) return '';
  const u = step.usage || {};
  const comp = step.composition || {};
  const sugg = step.suggestions || [];
  const badge = (label, val) => '<span style="display:inline-block;padding:1px 6px;background:var(--surface);border:1px solid var(--border);border-radius:3px;margin-right:4px;font-size:10px;color:var(--text);">' + label + ': <b style="color:var(--text-bright);">' + val + '</b></span>';

  let html = '<details style="margin-top:6px;font-size:10px;color:var(--text-dim);">';
  html += '<summary style="cursor:pointer;user-select:none;">efficiency · ' +
    (u.input_tokens != null ? u.input_tokens + ' in' : '?') + ' / ' +
    (u.output_tokens != null ? u.output_tokens + ' out' : '?') + ' · ' +
    (step.routeInfo?.route || '?') + ' · ' + (step.ms || '?') + 'ms' +
    '</summary>';
  html += '<div style="padding:8px;margin-top:4px;border:1px solid var(--border);border-radius:3px;background:var(--surface);">';

  html += '<div style="margin-bottom:6px;">' +
    badge('route', step.routeInfo?.route || '?') +
    badge('named', step.routeInfo?.signals?.namedHits ?? 0) +
    badge('entities', comp.entities || 0) +
    badge('connections', comp.connections || 0) +
    badge('spans', comp.spans || 0) +
    badge('in_tok', u.input_tokens ?? '?') +
    badge('out_tok', u.output_tokens ?? '?') +
    badge('ms', step.ms || '?') +
    '</div>';

  if (sugg.length) {
    html += '<div style="margin-top:6px;"><div style="color:var(--text);font-weight:600;margin-bottom:3px;">suggestions (mechanical):</div>';
    sugg.forEach(s => {
      const tag = s.op === 'EVA' ? (s.verdict === 'tension' ? '⚠ EVA' : (s.verdict === 'contradiction' ? '✗ EVA' : '✓ EVA')) : s.op;
      const body = s.op === 'REC' ? (s.target ? '<code style="color:var(--text-bright);">' + escapeAttr(s.target) + '</code> — ' : '') + escapeAttr(s.rec || '') + (s.reason ? ' <i style="color:var(--text-dim);">(' + escapeAttr(s.reason) + ')</i>' : '') :
                 s.op === 'EVA' ? escapeAttr(s.note || '') :
                 escapeAttr(s.note || s.rec || '');
      const colour = s.op === 'EVA' && s.verdict === 'tension' ? '#c08040' : s.op === 'REC' ? '#60a060' : 'var(--text-dim)';
      html += '<div style="margin:2px 0;color:' + colour + ';">' + tag + (s.source === 'llm' ? ' <span style="color:var(--text-dim);">(llm)</span>' : '') + ': ' + body + '</div>';
    });
    html += '</div>';
  }

  html += '<div style="margin-top:6px;text-align:right;"><button class="act-btn" style="font-size:9px;padding:2px 6px;" onclick="exportLibrarianSuggestions()"><i class="ph ph-download-simple"></i> export suggestions</button></div>';
  html += '</div></details>';
  return html;
}

function exportLibrarianSuggestions() {
  const blob = {
    exportedAt: Date.now(),
    turns: librarianTelemetryLog.map(s => ({
      ts: s.ts,
      question: s.question,
      route: s.routeInfo?.route,
      signals: s.routeInfo?.signals,
      composition: s.composition,
      usage: s.usage,
      ms: s.ms,
      model: s.model,
      suggestions: s.suggestions,
      evaPassUsage: s.evaPassUsage || null,
    })),
  };
  if (typeof downloadJson === 'function') {
    downloadJson(blob, 'librarian-suggestions.json');
  } else {
    const url = URL.createObjectURL(new Blob([JSON.stringify(blob, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'librarian-suggestions.json'; a.click(); URL.revokeObjectURL(url);
  }
}
