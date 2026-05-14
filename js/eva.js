// eva.js — convergence evaluator. Pure log-fold aggregation over the
// voices that have spoken about each site. No LLM. Emits EVA events with
// verdict {converging | diverging | single-voice}. Triggers: auto-fires
// at the end of each walk (restricted to sites the article touched) and
// can be run on-demand via the `evaluate` tab. Dedup-by-verdict-hash
// keeps the log readable across repeated runs.

// Returns distinct (voice, voiceRelation) pairs across an entity's spans.
function evaCollectVoices(id) {
  const e = graph.entities[id];
  if (!e || !e.spans) return [];
  const seen = new Set();
  const out = [];
  for (const sp of e.spans) {
    if (!sp) continue;
    const v = sp.voice || null;
    const rel = sp.voiceRelation || null;
    const key = (v || '') + '|' + (rel || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ voice: v, voiceRelation: rel, canonical: voiceCanonicalFor(v) });
  }
  return out;
}

// Verdict + verdict hash for an entity. Pure function of current spans.
function evaComputeVerdict(id) {
  const voices = evaCollectVoices(id);
  const distinctVoices = voices.filter(v => v.voice);
  const relSet = new Set(voices.map(v => v.voiceRelation).filter(Boolean));

  let verdict;
  if (distinctVoices.length <= 1) verdict = 'single-voice';
  else if (relSet.has('attested_by') && (relSet.has('asserted_by') || relSet.has('characterized_by'))) verdict = 'diverging';
  else verdict = 'converging';

  // hash = verdict + sorted (voice|relation) keys. Used for dedup.
  const keys = distinctVoices.map(v => v.voice + '|' + (v.voiceRelation || '')).sort();
  const verdictHash = verdict + '::' + keys.join(',');

  const note = distinctVoices.length
    ? distinctVoices.map(v => v.canonical + ' (' + (v.voiceRelation || '?') + ')').join('; ')
    : 'no attributed spans';

  return { verdict, verdictHash, note, voiceCount: distinctVoices.length, voices: distinctVoices };
}

// Last evaluator-emitted EVA hash for this site, if any.
function evaLastHashFor(id) {
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const e = eventLog[i];
    if (e.op === 'EVA' && e.id === id && e.bySite === 'evaluator' && e.verdictHash) return e.verdictHash;
  }
  return null;
}

// Evaluate one site. Emits an EVA event only if the verdict hash has
// changed since the last evaluator-emitted EVA for this site. Returns
// {emitted: bool, verdict, verdictHash, note}.
function evaluateSite(id) {
  const e = graph.entities[id];
  if (!e) return { emitted: false };
  const v = evaComputeVerdict(id);
  if (v.voiceCount < 2 && v.verdict === 'single-voice') {
    // Don't bother emitting single-voice EVAs — they're not useful.
    return { emitted: false, ...v };
  }
  const last = evaLastHashFor(id);
  if (last === v.verdictHash) return { emitted: false, ...v, dedup: true };

  pushEvent({
    op: 'EVA',
    id,
    verdict: v.verdict,
    note: v.note,
    span: { text: '(evaluator-aggregate)', sentenceIdx: -1 },
    voice: null,
    voiceRelation: null,
    bySite: 'evaluator',
    verdictHash: v.verdictHash,
    ts: Date.now(),
    provenance: 'system-inferred',
  });
  refoldLive();
  return { emitted: true, ...v };
}

// Iterate over every site with ≥2 voice-distinct spans.
function evaluateAllSites() {
  let count = 0, emitted = 0;
  for (const id of Object.keys(graph.entities)) {
    const r = evaluateSite(id);
    count++;
    if (r.emitted) emitted++;
  }
  saveGraph();
  return { count, emitted };
}

// Restrict to sites whose spans reference the given article id. Called
// at the end of runWalk for the article just processed.
function evaluateAllSitesForArticle(articleId) {
  let count = 0, emitted = 0;
  for (const [id, e] of Object.entries(graph.entities)) {
    const touches = (e.spans || []).some(sp => sp && (sp.sourceId === articleId || sp.sourceTitle === (graph.entities[articleId] && graph.entities[articleId].canonical)));
    if (!touches) continue;
    const r = evaluateSite(id);
    count++;
    if (r.emitted) emitted++;
  }
  saveGraph();
  return { count, emitted };
}

// --- view ---
function renderEvaView() {
  const main = document.getElementById('graph-main-content');
  if (!main) return;

  const recent = eventLog
    .filter(e => e.op === 'EVA' && e.bySite === 'evaluator')
    .slice(-50)
    .reverse();

  let html = '<div style="padding:14px;">';
  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">';
  html += '<button class="act-btn" style="background:var(--accent);color:#1a1a1a;border-color:var(--accent);font-weight:600;padding:5px 12px;" onclick="runEvaluateAll()"><i class="ph ph-scales"></i> evaluate all sites</button>';
  html += '<span style="color:var(--text-dim);font-size:11px;">aggregates voices across spans. dedup by verdict — re-running is cheap.</span>';
  html += '</div>';
  html += '<div id="eva-summary" style="margin-bottom:14px;color:var(--text-dim);font-size:11px;"></div>';

  html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--accent);margin-bottom:8px;"><i class="ph ph-list"></i> recent evaluator verdicts</div>';
  if (!recent.length) {
    html += '<div style="color:var(--text-dim);font-size:11px;">no evaluator EVAs yet. process a few articles, or press the button above.</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:6px;">';
    for (const ev of recent) {
      const e = graph.entities[ev.id];
      const name = e ? e.canonical : ev.id;
      const color = ev.verdict === 'diverging' ? '#c06060' : ev.verdict === 'converging' ? 'var(--accent)' : '#888';
      html += '<div style="padding:6px 8px;border:1px solid var(--border);border-radius:3px;font-size:11px;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">';
      html += '<strong>' + escapeAttr(name) + '</strong> <span style="color:' + color + ';text-transform:uppercase;font-size:9px;letter-spacing:0.5px;">' + escapeAttr(ev.verdict) + '</span>';
      html += '</div>';
      html += '<div style="color:var(--text-dim);font-size:10px;">' + escapeAttr(ev.note || '') + '</div>';
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  main.innerHTML = html;
}

function runEvaluateAll() {
  const r = evaluateAllSites();
  const summary = document.getElementById('eva-summary');
  if (summary) {
    summary.innerHTML = '<i class="ph ph-check-circle" style="color:var(--accent);"></i> scanned ' + r.count + ' sites, emitted ' + r.emitted + ' new EVA event' + (r.emitted === 1 ? '' : 's');
  }
  // Re-render to show fresh entries
  setTimeout(() => renderEvaView(), 80);
}
