// dream.js — second-pass collisions: find semantically-near, graph-distant
// site pairs and ask Claude to verify whether the spans actually evidence a
// connection. Strict two-gate: textually grounded + graph-novel.

const DREAM_MAX_CANDIDATES = 8;
const DREAM_MIN_HOP_DISTANCE = 3; // must be at least this far apart in the graph

// token-overlap similarity over hypothesis + all spans
function entityCorpus(e) {
  const parts = [e.canonical || '', e.hypothesis || '', e.subtype || ''];
  (e.aliases || []).forEach(a => parts.push(a));
  (e.spans || []).forEach(sp => { if (sp && sp.text) parts.push(sp.text); });
  (e.defHistory || []).forEach(d => { if (d.hypothesis) parts.push(d.hypothesis); });
  return parts.join(' ').toLowerCase();
}

function tokenSet(text) {
  return new Set((text || '').split(/\W+/).filter(t => t.length > 4));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function graphHopDistance(idA, idB) {
  if (idA === idB) return 0;
  const adj = {};
  for (const c of graph.connections) {
    (adj[c.from] = adj[c.from] || []).push(c.to);
    (adj[c.to] = adj[c.to] || []).push(c.from);
  }
  const seen = new Set([idA]);
  let frontier = [idA];
  let d = 0;
  while (frontier.length) {
    d++;
    const next = [];
    for (const id of frontier) {
      for (const n of (adj[id] || [])) {
        if (n === idB) return d;
        if (!seen.has(n)) { seen.add(n); next.push(n); }
      }
    }
    frontier = next;
  }
  return Infinity;
}

function computeDreamCandidates() {
  const ids = Object.keys(graph.entities);
  if (ids.length < 4) return [];

  // pre-compute token sets
  const toks = {};
  ids.forEach(id => { toks[id] = tokenSet(entityCorpus(graph.entities[id])); });

  // pairs
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const sim = jaccard(toks[a], toks[b]);
      if (sim < 0.04) continue; // not similar enough
      const dist = graphHopDistance(a, b);
      if (dist < DREAM_MIN_HOP_DISTANCE) continue; // not graph-distant
      // skip pairs already pending/processed
      if (dreamCandidates.some(c => (c.from === a && c.to === b) || (c.from === b && c.to === a))) continue;
      pairs.push({ from: a, to: b, sim, dist });
    }
  }
  pairs.sort((x, y) => y.sim - x.sim);
  return pairs.slice(0, DREAM_MAX_CANDIDATES);
}

// Enqueue one dream job per candidate pair. The scheduler runs them in
// parallel up to QUEUE_MAX_CONCURRENCY. UI returns immediately; the
// process tab + the dream tab update as each job lands.
async function runDreamPass() {
  const apiKey = getApiKey();
  if (!apiKey) { await showAlert('Set your Anthropic API key first'); return; }

  const cands = computeDreamCandidates();
  if (!cands.length) {
    await showAlert('No new candidates — either the graph is too small, too dense, or all pairs already evaluated.');
    return;
  }

  cands.forEach(cand => {
    enqueueJob('dream', {
      fromId: cand.from,
      toId: cand.to,
      sim: cand.sim,
      dist: cand.dist,
    });
  });
}

// Single dream job runner — invoked by the queue scheduler. One API call,
// then push the verdict into dreamCandidates.
async function runDreamJob(job, signal) {
  const cand = job.target;
  const fromE = graph.entities[cand.fromId];
  const toE = graph.entities[cand.toId];
  if (!fromE || !toE) throw new Error('candidate entity missing from graph');

  const ctx = buildDreamContext(fromE, toE);
  try {
    const raw = await callClaude(DREAM_PROMPT, ctx, 700, null, { signal });
    const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const result = JSON.parse(clean);
    const record = {
      from: cand.fromId, to: cand.toId,
      sim: cand.sim, dist: cand.dist,
      ...result,
      status: result.verdict === 'novel' ? 'novel' : (result.verdict === 'restatement' ? 'rejected' : 'rejected'),
      ts: Date.now(),
    };
    dreamCandidates.push(record);
    saveDreamCandidates();
    if (activeGraphTab === 'dream') renderDreamView();
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    // Still record the failure so the user sees it in dream view
    dreamCandidates.push({
      from: cand.fromId, to: cand.toId,
      sim: cand.sim, dist: cand.dist,
      verdict: 'error', status: 'rejected', error: e.message,
      ts: Date.now(),
    });
    saveDreamCandidates();
    if (activeGraphTab === 'dream') renderDreamView();
    throw e;
  }
}

function buildDreamContext(fromE, toE) {
  const lines = [];
  lines.push('Candidate A:');
  lines.push('  id: ' + fromE.canonical);
  lines.push('  kind: ' + fromE.kind);
  lines.push('  hypothesis: ' + (fromE.hypothesis || ''));
  lines.push('  spans:');
  (fromE.spans || []).slice(0, 5).forEach(sp => {
    lines.push('    - ' + formatSpanForPrompt(sp, { max: 280 }));
  });

  lines.push('');
  lines.push('Candidate B:');
  lines.push('  id: ' + toE.canonical);
  lines.push('  kind: ' + toE.kind);
  lines.push('  hypothesis: ' + (toE.hypothesis || ''));
  lines.push('  spans:');
  (toE.spans || []).slice(0, 5).forEach(sp => {
    lines.push('    - ' + formatSpanForPrompt(sp, { max: 280 }));
  });

  // existing connections each end has, so the gatekeeper can detect restatements
  const exConsA = graph.connections.filter(c => c.from === Object.keys(graph.entities).find(k => graph.entities[k] === fromE) || c.to === Object.keys(graph.entities).find(k => graph.entities[k] === fromE));
  const exConsB = graph.connections.filter(c => c.from === Object.keys(graph.entities).find(k => graph.entities[k] === toE) || c.to === Object.keys(graph.entities).find(k => graph.entities[k] === toE));
  lines.push('');
  lines.push('Existing connections involving A or B (for restatement check):');
  [...exConsA, ...exConsB].slice(0, 12).forEach(c => {
    const fn = graph.entities[c.from]?.canonical || c.from;
    const tn = graph.entities[c.to]?.canonical || c.to;
    lines.push('  ' + fn + ' --[' + c.relation + ']--> ' + tn);
  });

  lines.push('');
  lines.push('Use the candidate ids: from="' + getEntityId(fromE) + '", to="' + getEntityId(toE) + '".');
  return lines.join('\n');
}

function getEntityId(e) {
  return Object.keys(graph.entities).find(k => graph.entities[k] === e) || '?';
}

function acceptDream(idx) {
  const cand = dreamCandidates[idx];
  if (!cand) return;
  // emit a CON event flagged as system-inferred (will become editor-authored
  // when the editor accepts — provenance carries the lineage)
  pushEvent({
    op: 'CON',
    from: cand.from, to: cand.to,
    relation: cand.relation || 'related_to',
    evidence: cand.evidence || '',
    confidence: 'low',
    span: cand.cites && cand.cites[0] ? { text: cand.cites[0].spanText, sourceTitle: cand.cites[0].sourceTitle } : null,
    source: cand.cites && cand.cites[0] ? { title: cand.cites[0].sourceTitle, url: null } : null,
    ts: Date.now(),
    provenance: 'editor-authored',
  });
  cand.status = 'accepted';
  refoldLive();
  saveGraph();
  saveDreamCandidates();
  renderDreamView();
}

function rejectDream(idx) {
  const cand = dreamCandidates[idx];
  if (!cand) return;
  cand.status = 'rejected';
  saveDreamCandidates();
  renderDreamView();
}

function loadDreamCandidates() {
  try {
    const saved = localStorage.getItem('plaintext_dream_candidates');
    if (saved) dreamCandidates = JSON.parse(saved);
  } catch (e) {}
}
function saveDreamCandidates() {
  localStorage.setItem('plaintext_dream_candidates', JSON.stringify(dreamCandidates));
}
