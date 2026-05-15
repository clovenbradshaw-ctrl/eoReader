// queue.js — single job scheduler for all long-running operations.
// Owns: queue persistence, bounded concurrency, AbortController per job,
// mid-walk checkpointing, and the "process" status tab renderer.
//
// Kinds: 'walk' (per-article sentence-by-sentence) | 'dream' (per-pair) |
//        'summary' (single-call digest).
// Walks are capped at 1 concurrent because the rendered "walk" panel + the
// global walk pointer can only focus one. Dream/summary share the rest of
// MAX_CONCURRENCY so 8 dream candidates parallelize cleanly.

const QUEUE_MAX_CONCURRENCY = 3;
const QUEUE_WALK_MAX = 1;
const QUEUE_STORAGE_KEY = 'plaintext_job_queue';
const QUEUE_PAUSED_KEY = 'plaintext_queue_paused';
const QUEUE_DONE_KEEP = 20;

let jobQueue = [];
let queuePaused = false;
const activeWorkers = new Map(); // jobId -> { abortController, walkState? }
let focusedWalkJobId = null;
let queueElapsedTimer = null;

function queueNotify() {
  try { window.dispatchEvent(new CustomEvent('queue:changed')); } catch (e) {}
  updateProcessTabBadge();
}

function persistQueue() {
  try {
    // Strip non-serializable bits (workerId is fine, walkState lives in
    // activeWorkers only). Keep checkpoint so reload resumes mid-walk.
    const slim = jobQueue.map(j => ({
      id: j.id, kind: j.kind, target: j.target, status: j.status,
      checkpoint: j.checkpoint, error: j.error, enqueuedAt: j.enqueuedAt,
      startedAt: j.startedAt, completedAt: j.completedAt,
      title: j.title, opts: j.opts || null,
    }));
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(slim));
    localStorage.setItem(QUEUE_PAUSED_KEY, queuePaused ? '1' : '0');
  } catch (e) {
    console.warn('queue persist failed', e);
  }
}

function hydrateQueue() {
  try {
    const saved = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (saved) {
      jobQueue = JSON.parse(saved).map(j => ({
        ...j,
        // any job that was 'running' at shutdown is now 'pending' — its
        // checkpoint will let it resume mid-article.
        status: j.status === 'running' ? 'pending' : j.status,
      }));
    }
    const paused = localStorage.getItem(QUEUE_PAUSED_KEY);
    queuePaused = paused === '1';
  } catch (e) {
    console.warn('queue hydrate failed', e);
    jobQueue = [];
  }
}

function jobTitle(kind, target) {
  if (kind === 'walk') {
    // Walk targets carry articleIdx; resolve title from allItems if possible.
    if (target && target.title) return target.title;
    if (target && typeof target.articleIdx === 'number') {
      const it = allItems && allItems[target.articleIdx];
      if (it) return it.title || '(untitled article)';
    }
    if (target && target.sourceId) {
      const s = (sources || []).find(s => s.id === target.sourceId);
      if (s) return s.title || '(untitled article)';
    }
    return '(article)';
  }
  if (kind === 'dream') {
    const f = graph.entities[target.fromId];
    const t = graph.entities[target.toId];
    const fn = f ? f.canonical : target.fromId;
    const tn = t ? t.canonical : target.toId;
    return fn + '  ↔  ' + tn;
  }
  if (kind === 'summary') return target.title || 'summary';
  return kind;
}

function findExistingJob(kind, target) {
  return jobQueue.find(j => {
    if (j.kind !== kind) return false;
    if (j.status !== 'pending' && j.status !== 'running') return false;
    if (kind === 'walk') {
      // articleIdx changes across reloads; use sourceId or link if present.
      if (target.sourceId && j.target.sourceId) return target.sourceId === j.target.sourceId;
      return target.articleIdx === j.target.articleIdx;
    }
    if (kind === 'dream') {
      return (j.target.fromId === target.fromId && j.target.toId === target.toId)
          || (j.target.fromId === target.toId && j.target.toId === target.fromId);
    }
    if (kind === 'summary') return j.target.key === target.key;
    return false;
  });
}

function enqueueJob(kind, target, opts) {
  const existing = findExistingJob(kind, target);
  if (existing) return existing.id;

  const id = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const job = {
    id, kind, target,
    status: 'pending',
    checkpoint: null,
    error: null,
    enqueuedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    title: jobTitle(kind, target),
    opts: opts || null,
  };
  // Donepromise so callers can await completion (used by generateDigest).
  job.donePromise = new Promise(res => { job._resolveDone = res; });
  jobQueue.push(job);
  persistQueue();
  queueNotify();
  tickScheduler();
  return id;
}

function cancelJob(id) {
  const job = jobQueue.find(j => j.id === id);
  if (!job) return;
  const worker = activeWorkers.get(id);
  if (worker && worker.abortController) {
    try { worker.abortController.abort(); } catch (e) {}
  }
  job.status = 'cancelled';
  job.completedAt = Date.now();
  activeWorkers.delete(id);
  if (focusedWalkJobId === id) focusedWalkJobId = null;
  if (job._resolveDone) { job._resolveDone(); job._resolveDone = null; }
  persistQueue();
  queueNotify();
  tickScheduler();
}

function clearCompletedJobs() {
  jobQueue = jobQueue.filter(j => j.status !== 'done' && j.status !== 'cancelled');
  persistQueue();
  queueNotify();
}

function dismissJob(id) {
  const job = jobQueue.find(j => j.id === id);
  if (!job) return;
  if (job.status === 'running' || job.status === 'pending') return;
  jobQueue = jobQueue.filter(j => j.id !== id);
  persistQueue();
  queueNotify();
}

function retryJob(id) {
  const job = jobQueue.find(j => j.id === id);
  if (!job) return;
  if (job.status !== 'error' && job.status !== 'cancelled') return;
  job.status = 'pending';
  job.error = null;
  job.startedAt = null;
  job.completedAt = null;
  job.donePromise = new Promise(res => { job._resolveDone = res; });
  persistQueue();
  queueNotify();
  tickScheduler();
}

function setQueuePaused(paused) {
  queuePaused = !!paused;
  persistQueue();
  queueNotify();
  if (!queuePaused) tickScheduler();
}

function processAllUnprocessed() {
  if (!Array.isArray(allItems)) return 0;
  let added = 0;
  allItems.forEach((item, idx) => {
    if (item._processed) return;
    if (!item.body || item.body.length < 50) return;
    const id = enqueueJob('walk', {
      articleIdx: idx,
      sourceId: item._sourceId || null,
      link: item.link || null,
      title: item.title || '',
    });
    if (id) added++;
  });
  return added;
}

function jobCounts() {
  const c = { running: 0, pending: 0, error: 0, done: 0, cancelled: 0 };
  jobQueue.forEach(j => { c[j.status] = (c[j.status] || 0) + 1; });
  return c;
}

// Per-provider concurrency cap. Anthropic tolerates QUEUE_MAX_CONCURRENCY
// parallel requests; WebLLM serializes per engine; Ollama serializes by
// default. The current provider for a job's role caps how many of that
// role may run in parallel.
function _providerCapForRole(role) {
  try {
    if (!window.LLMProviders) return QUEUE_MAX_CONCURRENCY;
    const { provider } = window.LLMProviders.routeFor(role);
    if (!provider) return QUEUE_MAX_CONCURRENCY;
    return typeof provider.concurrency === 'number'
      ? provider.concurrency
      : QUEUE_MAX_CONCURRENCY;
  } catch {
    return QUEUE_MAX_CONCURRENCY;
  }
}

function tickScheduler() {
  if (queuePaused) return;

  const running = jobQueue.filter(j => j.status === 'running');
  if (running.length >= QUEUE_MAX_CONCURRENCY) return;

  const walkRunning = running.filter(j => j.kind === 'walk').length;

  for (const job of jobQueue) {
    if (job.status !== 'pending') continue;
    const totalRunning = jobQueue.filter(j => j.status === 'running').length;
    if (totalRunning >= QUEUE_MAX_CONCURRENCY) break;
    if (job.kind === 'walk' && walkRunning >= QUEUE_WALK_MAX) continue;

    // Provider-aware cap: count jobs of this kind already running and
    // gate against the provider's concurrency budget.
    const providerCap = _providerCapForRole(job.kind);
    const kindRunning = running.filter(j => j.kind === job.kind).length;
    if (kindRunning >= providerCap) continue;

    startJob(job);
    if (job.kind === 'walk') break; // only one walk per tick
  }
}

function startJob(job) {
  const ac = new AbortController();
  activeWorkers.set(job.id, { abortController: ac });
  job.status = 'running';
  job.startedAt = Date.now();
  job.error = null;
  persistQueue();
  queueNotify();

  let runner;
  if (job.kind === 'walk') runner = (typeof runWalkJob === 'function') ? runWalkJob(job, ac.signal) : Promise.reject(new Error('runWalkJob missing'));
  else if (job.kind === 'dream') runner = (typeof runDreamJob === 'function') ? runDreamJob(job, ac.signal) : Promise.reject(new Error('runDreamJob missing'));
  else if (job.kind === 'summary') runner = (typeof runSummaryJob === 'function') ? runSummaryJob(job, ac.signal) : Promise.reject(new Error('runSummaryJob missing'));
  else runner = Promise.reject(new Error('unknown job kind: ' + job.kind));

  runner.then(() => {
    if (job.status === 'cancelled') return;
    job.status = 'done';
    job.completedAt = Date.now();
    activeWorkers.delete(job.id);
    if (focusedWalkJobId === job.id) focusedWalkJobId = null;
    if (job._resolveDone) { job._resolveDone(); job._resolveDone = null; }
    persistQueue();
    queueNotify();
    tickScheduler();
  }).catch((err) => {
    if (job.status === 'cancelled' || (err && err.name === 'AbortError')) {
      activeWorkers.delete(job.id);
      if (focusedWalkJobId === job.id) focusedWalkJobId = null;
      if (job._resolveDone) { job._resolveDone(); job._resolveDone = null; }
      persistQueue();
      queueNotify();
      tickScheduler();
      return;
    }
    job.status = 'error';
    job.error = (err && err.message) || String(err);
    job.completedAt = Date.now();
    activeWorkers.delete(job.id);
    if (focusedWalkJobId === job.id) focusedWalkJobId = null;
    if (job._resolveDone) { job._resolveDone(); job._resolveDone = null; }
    persistQueue();
    queueNotify();
    tickScheduler();
  });
}

function checkpointJob(job, checkpoint) {
  job.checkpoint = checkpoint;
  persistQueue();
  queueNotify();
}

function focusWalkJob(id) {
  const job = jobQueue.find(j => j.id === id);
  if (!job || job.kind !== 'walk') return;
  const worker = activeWorkers.get(id);
  focusedWalkJobId = id;
  if (worker && worker.walkState) {
    // Mirror the focused job's state into the legacy `walk` global so the
    // existing per-sentence renderer keeps working.
    if (typeof setFocusedWalkFromState === 'function') setFocusedWalkFromState(worker.walkState);
  }
  queueNotify();
  if (activeGraphTab === 'walk') renderGraphPanel();
}

function getFocusedWalkJob() {
  if (!focusedWalkJobId) return null;
  return jobQueue.find(j => j.id === focusedWalkJobId) || null;
}

function awaitJob(id) {
  const job = jobQueue.find(j => j.id === id);
  if (!job) return Promise.resolve();
  return job.donePromise || Promise.resolve();
}

// ---- status tab renderer ----

function fmtElapsed(ms) {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + 'm ' + r + 's';
  const h = Math.floor(m / 60), mr = m % 60;
  return h + 'h ' + mr + 'm';
}

function kindIcon(kind) {
  if (kind === 'walk') return '<i class="ph ph-cpu"></i>';
  if (kind === 'dream') return '<i class="ph ph-moon-stars"></i>';
  if (kind === 'summary') return '<i class="ph ph-file-text"></i>';
  return '<i class="ph ph-circle"></i>';
}

function updateProcessTabBadge() {
  const tab = document.getElementById('tab-walk');
  if (!tab) return;
  const counts = jobCounts();
  const active = counts.running || 0;
  const pending = counts.pending || 0;
  let badge = '';
  if (active > 0 || pending > 0) {
    badge = ' <span style="color:#d4a84d;font-weight:600;">●' + (active + pending) + '</span>';
  }
  tab.innerHTML = '<i class="ph ph-cpu"></i> process' + badge;
}

function renderProcessTab() {
  const main = document.getElementById('graph-main-content');
  if (!main) return;

  const counts = jobCounts();
  const running = jobQueue.filter(j => j.status === 'running');
  const pending = jobQueue.filter(j => j.status === 'pending');
  const errored = jobQueue.filter(j => j.status === 'error');
  const done = jobQueue.filter(j => j.status === 'done' || j.status === 'cancelled')
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, QUEUE_DONE_KEEP);

  const totalUnprocessedItems = (allItems || []).filter(it => !it._processed && it.body && it.body.length >= 50).length;

  let html = '';

  // header
  html += '<div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border);">';
  html += '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:11px;margin-bottom:10px;">';
  html += '<span><i class="ph ph-play-circle"></i> <strong>' + (counts.running || 0) + '</strong> running</span>';
  html += '<span style="color:var(--text-dim);"><i class="ph ph-clock"></i> ' + (counts.pending || 0) + ' pending</span>';
  if (counts.error) html += '<span style="color:#c06060;"><i class="ph ph-warning"></i> ' + counts.error + ' errored</span>';
  html += '<span style="color:var(--text-dim);"><i class="ph ph-check-circle"></i> ' + (counts.done || 0) + ' done</span>';
  html += '<span style="color:var(--text-dim);margin-left:auto;">capacity ' + (counts.running || 0) + '/' + QUEUE_MAX_CONCURRENCY + '</span>';
  html += '</div>';

  html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
  if (queuePaused) {
    html += '<button class="act-btn" onclick="setQueuePaused(false)" style="border-color:var(--accent);color:var(--accent);"><i class="ph ph-play"></i> resume queue</button>';
  } else {
    html += '<button class="act-btn" onclick="setQueuePaused(true)"><i class="ph ph-pause"></i> pause queue</button>';
  }
  html += '<button class="act-btn" onclick="onProcessAllUnprocessed()" ' + (totalUnprocessedItems ? '' : 'disabled') + '>'
       + '<i class="ph ph-cpu"></i> process all unprocessed (' + totalUnprocessedItems + ')</button>';
  if (counts.done || counts.cancelled) {
    html += '<button class="act-btn" onclick="clearCompletedJobs()"><i class="ph ph-broom"></i> clear finished</button>';
  }
  html += '</div>';
  html += '</div>';

  // running
  if (running.length) {
    html += '<div style="font-size:10px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;"><i class="ph ph-play-circle"></i> running (' + running.length + ')</div>';
    running.forEach(job => { html += renderJobCard(job, 'running'); });
  }

  // pending
  if (pending.length) {
    html += '<div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 8px;"><i class="ph ph-clock"></i> pending (' + pending.length + ')</div>';
    pending.forEach(job => { html += renderJobCard(job, 'pending'); });
  }

  // errored
  if (errored.length) {
    html += '<div style="font-size:10px;color:#c06060;text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 8px;"><i class="ph ph-warning"></i> errored (' + errored.length + ')</div>';
    errored.forEach(job => { html += renderJobCard(job, 'error'); });
  }

  // done
  if (done.length) {
    html += '<div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin:14px 0 8px;"><i class="ph ph-check-circle"></i> recent (' + done.length + ')</div>';
    done.forEach(job => { html += renderJobCard(job, 'done'); });
  }

  if (!running.length && !pending.length && !errored.length && !done.length) {
    html += '<div style="color:var(--text-dim);padding:20px;font-size:11px;">'
         + 'no jobs in queue. click <strong>process</strong> on any article in the feed to enqueue a walk, '
         + 'or open <strong>dream</strong> to enqueue connection candidates. '
         + 'this view shows every running, pending, errored, and recently completed job across walks, dream, and summaries.'
         + '</div>';
  }

  // focused walk detail (only if a walk job is focused)
  const focused = getFocusedWalkJob();
  if (focused) {
    html += '<hr style="border:none;border-top:1px solid var(--border);margin:16px 0;">';
    html += '<div style="font-size:10px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">focused walk detail</div>';
    html += '<div id="focused-walk-detail"></div>';
  }

  main.innerHTML = html;

  // Inline the focused walk's per-sentence detail under the dashboard.
  if (focused) {
    const slot = document.getElementById('focused-walk-detail');
    if (slot) slot.innerHTML = renderFocusedWalkDetailHtml();
  }

  ensureElapsedTimer(running.length > 0);
}

function renderFocusedWalkDetailHtml() {
  // Mirrors the body of renderWalkStep but emits HTML string instead of
  // writing to #graph-main-content directly. Reads from the legacy `walk`
  // global which points at the focused job's state.
  const item = walk.idx != null ? allItems[walk.idx] : null;
  let html = '';
  if (item) {
    const pct = walk.sentences.length ? Math.round(((walk.current) / walk.sentences.length) * 100) : 0;
    html += '<div class="walk-progress"><i class="ph ph-article"></i> ' + escapeAttr(item.title) + ' — ' +
      (walk.active ? 'sentence ' + (walk.current + 1) + '/' + walk.sentences.length + ' (' + pct + '%)' : '<i class="ph ph-check-circle"></i> complete') +
      '</div>';
    html += '<div style="background:var(--border);height:3px;border-radius:2px;margin-bottom:12px;">' +
      '<div style="background:var(--accent);height:3px;border-radius:2px;width:' + pct + '%;transition:width 0.3s;"></div></div>';
  }
  if (walk.active && walk.sentences[walk.current]) {
    html += '<div class="walk-sentence">' + escapeAttr(walk.sentences[walk.current]) + '</div>';
  }
  if (walk.log && walk.log.length) {
    html += '<div style="margin-top:12px;max-height:300px;overflow-y:auto;">';
    for (let i = walk.log.length - 1; i >= 0; i--) {
      const l = walk.log[i];
      let line = '';
      if (l.op === 'SIG') line = '<span class="walk-prop-op">SIG</span> <strong>' + escapeAttr(l.text) + '</strong> <span class="eo-kind">' + (l.kind || '') + '</span>';
      else if (l.op === 'DEF') line = '<span class="walk-prop-op">DEF</span> <strong>' + escapeAttr(l.text) + '</strong>: <span style="color:var(--text-dim);font-size:10px;">' + escapeAttr((l.hyp || l.def || '').slice(0, 100)) + '</span>';
      else if (l.op === 'CON') line = '<span class="walk-prop-op">CON</span> ' + escapeAttr(l.from) + ' <span style="color:var(--accent);">' + escapeAttr(l.rel || '') + '</span> ' + escapeAttr(l.to);
      else if (l.op === 'EVA') {
        const color = l.verdict === 'contradiction' ? '#c06060' : l.verdict === 'tension' ? '#d4a84d' : 'var(--accent)';
        line = '<span class="walk-prop-op" style="color:' + color + ';">EVA</span> <strong>' + escapeAttr(l.text) + '</strong> <span style="color:' + color + ';">' + escapeAttr(l.verdict || '') + '</span>';
      }
      else if (l.op === 'REC') line = '<span class="walk-prop-op" style="color:#9a55cc;">REC</span> <strong>' + escapeAttr(l.text) + '</strong> → ' + escapeAttr(l.rename);
      else if (l.op === 'SEG') line = '<span class="walk-prop-op" style="color:#d4a84d;">SEG</span> <i class="ph ph-scissors"></i> <strong>' + escapeAttr(l.text) + '</strong> → ' + escapeAttr(l.into || '');
      else if (l.op === 'ERR') line = '<span style="color:#c06060;">ERR</span> ' + escapeAttr(l.text || '');
      html += '<div style="padding:2px 0;font-size:11px;border-bottom:1px solid var(--border);">' +
        '<span style="color:var(--text-dim);font-size:9px;margin-right:6px;">s' + l.sentence + '</span>' + line + '</div>';
    }
    html += '</div>';
  }
  return html || '<div style="color:var(--text-dim);font-size:11px;">no entries yet</div>';
}

function renderJobCard(job, kind) {
  const elapsed = job.startedAt
    ? fmtElapsed((job.completedAt || Date.now()) - job.startedAt)
    : '';
  const isFocused = job.id === focusedWalkJobId;
  const border = kind === 'error' ? '#c06060'
              : kind === 'running' ? 'var(--accent)'
              : 'var(--border)';
  const opacity = kind === 'done' ? '0.7' : '1';
  let html = '<div class="queue-job-card" data-job-id="' + job.id + '" '
    + 'style="padding:8px 10px;margin-bottom:6px;border:1px solid ' + border + ';'
    + 'border-radius:3px;font-size:11px;opacity:' + opacity + ';'
    + (isFocused ? 'background:rgba(212,168,77,0.08);' : '') + '">';

  html += '<div style="display:flex;align-items:center;gap:8px;">';
  html += '<span style="color:var(--text-dim);">' + kindIcon(job.kind) + '</span>';
  html += '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeAttr(job.title || '(untitled)') + '</span>';

  if (kind === 'running') {
    if (job.kind === 'walk' && job.checkpoint) {
      const cp = job.checkpoint;
      html += '<span style="color:var(--text-dim);font-size:10px;">'
           + (cp.current || 0) + '/' + (cp.total || '?') + '</span>';
    }
    html += '<span style="color:var(--text-dim);font-size:10px;" data-elapsed="' + (job.startedAt || 0) + '">' + elapsed + '</span>';
    if (job.kind === 'walk') {
      html += '<button class="act-btn" style="font-size:10px;padding:1px 6px;" onclick="focusWalkJob(\'' + job.id + '\')">' + (isFocused ? 'focused' : 'focus') + '</button>';
    }
    html += '<button class="act-btn" style="font-size:10px;padding:1px 6px;border-color:#c06060;color:#c06060;" onclick="cancelJob(\'' + job.id + '\')"><i class="ph ph-stop"></i></button>';
  } else if (kind === 'pending') {
    if (job.kind === 'walk' && job.checkpoint) {
      const cp = job.checkpoint;
      html += '<span style="color:var(--text-dim);font-size:10px;">resume@' + (cp.current || 0) + '/' + (cp.total || '?') + '</span>';
    }
    html += '<button class="act-btn" style="font-size:10px;padding:1px 6px;" onclick="cancelJob(\'' + job.id + '\')"><i class="ph ph-x"></i></button>';
  } else if (kind === 'error') {
    html += '<span style="color:#c06060;font-size:10px;">' + escapeAttr((job.error || '').slice(0, 80)) + '</span>';
    html += '<button class="act-btn" style="font-size:10px;padding:1px 6px;" onclick="retryJob(\'' + job.id + '\')"><i class="ph ph-arrow-clockwise"></i> retry</button>';
    html += '<button class="act-btn" style="font-size:10px;padding:1px 6px;" onclick="dismissJob(\'' + job.id + '\')"><i class="ph ph-x"></i></button>';
  } else if (kind === 'done') {
    const label = job.status === 'cancelled' ? 'cancelled' : ('done · ' + elapsed);
    html += '<span style="color:var(--text-dim);font-size:10px;">' + label + '</span>';
  }
  html += '</div>';

  // walk progress bar
  if (kind === 'running' && job.kind === 'walk' && job.checkpoint && job.checkpoint.total) {
    const pct = Math.round(((job.checkpoint.current || 0) / job.checkpoint.total) * 100);
    html += '<div style="background:var(--border);height:2px;border-radius:1px;margin-top:6px;overflow:hidden;">'
         + '<div style="background:var(--accent);height:2px;width:' + pct + '%;transition:width 0.3s;"></div></div>';
  }
  html += '</div>';
  return html;
}

function ensureElapsedTimer(shouldRun) {
  if (shouldRun && !queueElapsedTimer) {
    queueElapsedTimer = setInterval(() => {
      if (activeGraphTab !== 'walk') return;
      document.querySelectorAll('[data-elapsed]').forEach(el => {
        const startedAt = parseInt(el.getAttribute('data-elapsed'), 10);
        if (startedAt) el.textContent = fmtElapsed(Date.now() - startedAt);
      });
    }, 1000);
  } else if (!shouldRun && queueElapsedTimer) {
    clearInterval(queueElapsedTimer);
    queueElapsedTimer = null;
  }
}

async function onProcessAllUnprocessed() {
  const n = processAllUnprocessed();
  if (typeof showAlert === 'function' && n > 0) {
    // brief feedback only — don't block the user
  }
}

// rerender the tab whenever queue state changes (if it's the active tab)
window.addEventListener('queue:changed', () => {
  if (activeGraphTab === 'walk') renderProcessTab();
});

// warn before reload if jobs are in flight or pending
window.addEventListener('beforeunload', (e) => {
  const counts = jobCounts();
  if ((counts.running || 0) + (counts.pending || 0) > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});
