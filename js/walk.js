// walk.js — the central operator dispatch. processes a source clause by clause,
// pushes provenance-tagged events onto the eventLog, and folds them into graph.
// generateDigest also lives here since it's the "publishing" half of the walk.

function splitSentences(text) {
  return (text || '')
    .replace(/\n{2,}/g, '\n')
    .split(/(?<=[.!?])\s+(?=[A-Z"'"])/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Promote an article's publication + article + journalist-voice into the
// graph as Entity sites. Idempotent — each id is only SIG'd once. Returns
// {articleId, pubId, journalistVoiceId} for the walk loop to attach to
// every span.
function ensureSourceSites(item) {
  const ts = Date.now();
  const provenance = 'system-inferred';

  // 1. Publication site
  const pubKey = (SOURCES.find(s => s.name === item.sourceName) || {}).key;
  const pubId = 'pub-' + (pubKey || slugify(item.sourceName || 'unknown'));
  const pubCanonical = item.sourceName || 'Unknown publication';
  if (!graph.entities[pubId]) {
    pushEvent({
      op: 'SIG', id: pubId,
      canonical: pubCanonical,
      kind: 'Entity', subtype: 'publication',
      hypothesis: 'Publication producing journalism. Source of attested_by voices.',
      aliases: [],
      ts, provenance,
    });
  }

  // 2. Article site
  const articleId = 'art-' + slugify((item.title || '') + '-' + (item.link || ''));
  if (!graph.entities[articleId]) {
    pushEvent({
      op: 'SIG', id: articleId,
      canonical: item.title || '(untitled)',
      kind: 'Entity', subtype: 'article',
      hypothesis: 'Article published in ' + pubCanonical + '. Source spans flow from this artifact.',
      aliases: [],
      source: { title: item.title, url: item.link, id: articleId },
      ts: ts + 1, provenance,
    });
    pushEvent({
      op: 'CON',
      from: articleId, to: pubId,
      relation: 'published_in',
      evidence: '',
      confidence: 'high',
      provenance,
      ts: ts + 2,
    });
  }

  // 3. Journalist voice site (one per article — the reporting voice)
  const journalistVoiceId = articleId + '-journalist';
  if (!graph.entities[journalistVoiceId]) {
    pushEvent({
      op: 'SIG', id: journalistVoiceId,
      canonical: pubCanonical + ' reporter',
      kind: 'Entity', subtype: 'voice',
      hypothesis: 'Reporting voice for the article. attested_by relation to its claims.',
      aliases: [],
      voiceRelation: 'attested_by',
      ts: ts + 3, provenance,
    });
    pushEvent({
      op: 'CON',
      from: journalistVoiceId, to: articleId,
      relation: 'voice_in',
      evidence: '',
      confidence: 'high',
      provenance,
      ts: ts + 4,
    });
  }

  refoldLive();
  saveGraph();

  return { articleId, pubId, journalistVoiceId };
}

// Resolve a voice descriptor from the walk LLM into a site id. Reuses
// existing person ids when the voice name matches a known canonical/alias
// (per user decision: people speak through their own voice). Lazy-SIGs a
// new voice site otherwise. Returns the resolved id. Takes ws (per-job walk
// state) so parallel walks don't share a journalist-voice fallback.
function resolveVoice(voiceDesc, articleId, ts, ws) {
  ws = ws || walk;
  if (!voiceDesc || !voiceDesc.kind) {
    return ws.context && ws.context.journalistVoiceId;
  }
  if (voiceDesc.kind === 'journalist') {
    return ws.context.journalistVoiceId;
  }
  const name = (voiceDesc.name || '').trim();
  if (!name) return ws.context.journalistVoiceId;

  // Match existing entity by canonical/alias
  const lower = name.toLowerCase();
  for (const [id, e] of Object.entries(graph.entities)) {
    if ((e.canonical || '').toLowerCase() === lower) return id;
    if ((e.aliases || []).some(a => (a || '').toLowerCase() === lower)) return id;
  }

  // Otherwise SIG a new voice site
  const subtype = voiceDesc.kind === 'document' ? 'document'
                : voiceDesc.kind === 'characterization' ? 'frame'
                : 'voice';
  const slug = slugify(name) || ('voice-' + ts);
  pushEvent({
    op: 'SIG', id: slug,
    canonical: name,
    kind: 'Entity', subtype,
    hypothesis: 'Voice introduced by walk: ' + voiceDesc.kind + ' (' + (voiceDesc.relation || '') + ').',
    aliases: [],
    voiceRelation: voiceDesc.relation || null,
    ts, provenance: 'source-attested',
  });
  pushEvent({
    op: 'CON',
    from: slug, to: articleId,
    relation: 'voice_in',
    evidence: '',
    confidence: 'high',
    provenance: 'source-attested',
    ts: ts + 1,
  });
  return slug;
}

// Public entry point — now a thin wrapper around the queue. Each call
// enqueues a walk job (deduped by article) and returns a promise that
// resolves when that job finishes (or is cancelled/errors).
async function startWalk(idx) {
  const item = allItems[idx];
  if (!item) { console.error('No item at index', idx); return; }

  const apiKey = getApiKey();
  if (!apiKey) {
    await showAlert('Set your Anthropic API key in settings first');
    document.getElementById('prompt-editor').classList.add('open');
    return;
  }

  if (!item.body || item.body.length < 50) {
    await showAlert('Article body too short to process');
    return;
  }

  if (currentView !== 'index') toggleGraph();
  graphTab('walk');

  const id = enqueueJob('walk', {
    articleIdx: idx,
    sourceId: item._sourceId || null,
    link: item.link || null,
    title: item.title || '',
  });
  return awaitJob(id);
}

// Confirms before re-walking an already-indexed article. Called from the
// "reprocess" button in the feed (see render.js).
async function confirmReprocess(idx) {
  const item = allItems[idx];
  if (!item) return;
  const ok = await showConfirm(
    'This article is already indexed. Re-walking will create a new diff entry in its reprocess history. Continue?',
    { title: 'Reprocess article', okLabel: 'Reprocess', cancelLabel: 'Cancel' }
  );
  if (!ok) return;
  return startWalk(idx);
}

// Resolve a walk job to its current articleIdx, accounting for the fact
// that allItems is re-sorted on each fetch. Falls back to sourceId/link.
function resolveWalkArticleIdx(job) {
  const t = job.target || {};
  if (typeof t.articleIdx === 'number' && allItems[t.articleIdx]) {
    const it = allItems[t.articleIdx];
    if ((t.sourceId && it._sourceId === t.sourceId) || (t.link && it.link === t.link)) {
      return t.articleIdx;
    }
  }
  if (t.sourceId) {
    const i = allItems.findIndex(it => it._sourceId === t.sourceId);
    if (i >= 0) return i;
  }
  if (t.link) {
    const i = allItems.findIndex(it => it.link === t.link);
    if (i >= 0) return i;
  }
  return -1;
}

// Mirror the focused job's walk state into the legacy `walk` global so
// renderWalkStep + UI controls keep working unchanged.
function setFocusedWalkFromState(ws) {
  walk.active = ws.active;
  walk.paused = ws.paused;
  walk.idx = ws.idx;
  walk.sentences = ws.sentences;
  walk.current = ws.current;
  walk.log = ws.log;
  walk.context = ws.context;
  walk._priorSnapshot = ws._priorSnapshot;
}

// runWalkJob — invoked by the queue scheduler. Owns its own walk state
// (ws) so multiple walks can be interleaved at await boundaries without
// clobbering each other. Mirrors into the legacy `walk` global only when
// this job is the focused one (so renderWalkStep displays it).
async function runWalkJob(job, signal) {
  const idx = resolveWalkArticleIdx(job);
  if (idx < 0) throw new Error('article not found (was it removed?)');
  const item = allItems[idx];
  if (!item || !item.body) throw new Error('article body missing');

  const srcIdxPre = sources.findIndex(s =>
    (item._sourceId && s.id === item._sourceId) ||
    (item.link && s.url === item.link)
  );

  const sentences = splitSentences(item.body);
  const resumeAt = (job.checkpoint && typeof job.checkpoint.current === 'number')
    ? Math.min(job.checkpoint.current, sentences.length)
    : 0;

  const ws = {
    jobId: job.id,
    active: true,
    paused: false,
    idx,
    sentences,
    current: resumeAt,
    log: [],
    context: ensureSourceSites(item),
    _priorSnapshot: (srcIdxPre >= 0 && sources[srcIdxPre].processed && resumeAt === 0)
      ? snapshotSourceEo(srcIdxPre) : null,
  };

  // record worker reference so cancelJob can find walkState if needed
  const worker = activeWorkers.get(job.id);
  if (worker) worker.walkState = ws;

  // auto-focus this job if no walk is currently focused
  if (!focusedWalkJobId) {
    focusedWalkJobId = job.id;
    setFocusedWalkFromState(ws);
  } else if (focusedWalkJobId === job.id) {
    setFocusedWalkFromState(ws);
  }

  // initial render + checkpoint
  job.checkpoint = { current: ws.current, total: sentences.length, logLen: 0 };
  if (activeGraphTab === 'walk') renderProcessTab();

  while (ws.active && ws.current < ws.sentences.length) {
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (ws.paused) { await new Promise(r => setTimeout(r, 200)); continue; }

    const pct = Math.round(((ws.current + 1) / ws.sentences.length) * 100);
    updateItemProgress(ws.idx, pct);

    await processAndAccept(ws, signal);
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    ws.current++;

    // checkpoint after each sentence so a reload mid-walk resumes here
    job.checkpoint = { current: ws.current, total: sentences.length, logLen: ws.log.length };
    checkpointJob(job, job.checkpoint);

    if (focusedWalkJobId === job.id) {
      setFocusedWalkFromState(ws);
      if (activeGraphTab === 'walk') renderProcessTab();
    }
    renderEntityList();
  }

  if (ws.current >= ws.sentences.length) {
    ws.active = false;
    if (ws.idx != null && allItems[ws.idx]) {
      allItems[ws.idx]._walkLog = [...ws.log];
    }
    markItemProcessed(ws.idx);
    if (ws.context && ws.context.articleId && typeof evaluateAllSitesForArticle === 'function') {
      try { evaluateAllSitesForArticle(ws.context.articleId); } catch (e) { console.warn('auto-EVA failed', e); }
    }
    storeWalkToMatrix(ws);
    finalizeWalkSource(ws);
    if (focusedWalkJobId === job.id) {
      setFocusedWalkFromState(ws);
      if (activeGraphTab === 'walk') renderProcessTab();
    }
  }
}

async function processAndAccept(ws, signal) {
  ws = ws || walk;
  const item = allItems[ws.idx];
  const sentence = ws.sentences[ws.current];
  const siteContext = buildSentenceContext(sentence);

  const totalEntities = Object.keys(graph.entities).length;
  let siteIndex = '';
  if (totalEntities) {
    const candidates = rankCandidates(sentence, { limit: 30, threshold: 0.2 });
    if (candidates.length >= 5) {
      siteIndex = 'Likely-relevant indexed sites:\n' + candidates.map(({ id, e }) => {
        const grp = e.nameGroup ? ' [group:' + e.nameGroup + ']' : '';
        return id + '=' + e.canonical + grp;
      }).join('\n');
    } else {
      siteIndex = 'All indexed sites: ' + Object.keys(graph.entities).map(id => {
        const e = graph.entities[id];
        const grp = e.nameGroup ? ' [group:' + e.nameGroup + ']' : '';
        return id + '=' + e.canonical + grp;
      }).join(', ');
    }
  }

  // Two-block split for Anthropic prompt caching:
  //   stable = article header + entity index (changes only when a SIG lands)
  //   varying = per-sentence context + the sentence itself
  // The cached prefix (system + stable) clears the 1024-token floor for any
  // non-trivial entity index; subsequent sentences in the same walk hit cache.
  const stableBlock = [
    'Article: ' + item.title + ' (' + item.sourceName + ')',
    '',
    siteIndex,
  ].filter(Boolean).join('\n');

  const varyingBlock = [
    siteContext ? 'Relevant sites for this sentence:\n' + siteContext : '',
    '\nSentence to process:',
    sentence,
  ].filter(Boolean).join('\n');

  // Only mark stableBlock cacheable when it's substantial — an empty/tiny
  // index won't reach the 1024-token floor and just costs a write penalty.
  const useCache = stableBlock.length > 600;
  const userContent = useCache
    ? [cacheBlock(stableBlock), textBlock('\n' + varyingBlock)]
    : (stableBlock + '\n' + varyingBlock);
  const systemField = useCache ? [cacheBlock(WALK_PROMPT)] : WALK_PROMPT;

  try {
    const r = await callLLM({
      system: systemField,
      user: userContent,
      maxTokens: 1500,
      role: 'walk',
      responseFormat: 'json',
      signal,
    });
    const raw = r.text;
    const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);

    // Accept both shapes: legacy array OR new wrapper {voice, events}.
    let proposals, voiceDesc;
    if (Array.isArray(parsed)) { proposals = parsed; voiceDesc = null; }
    else { proposals = parsed.events || []; voiceDesc = parsed.voice || null; }
    if (!Array.isArray(proposals)) return;

    const baseTs = Date.now();
    const provenance = 'source-attested';

    // Resolve the sentence's voice to a site id. Lazy-SIGs a new voice
    // site if the speaker is new. Returns the journalist voice when no
    // wrapper provided.
    const voiceId = resolveVoice(voiceDesc, ws.context.articleId, baseTs, ws);
    const voiceRelation = (voiceDesc && voiceDesc.relation)
      || (voiceDesc && voiceDesc.kind === 'document' ? 'documented_in'
          : voiceDesc && voiceDesc.kind === 'characterization' ? 'characterized_by'
          : voiceDesc && voiceDesc.kind === 'quoted-person' ? 'asserted_by'
          : 'attested_by');

    const span = sentence;
    const spanMeta = {
      text: span, sentenceIdx: ws.current,
      sourceUrl: item.link, sourceTitle: item.title,
      sourceId: ws.context.articleId,
      voice: voiceId, voiceRelation,
    };
    const sourceMeta = { title: item.title, url: item.link, id: ws.context.articleId };

    for (const p of proposals) {
      const ts = baseTs + Math.floor(Math.random() * 100);
      if (p.op === 'SIG' && p.id && !graph.entities[p.id]) {
        pushEvent({
          op: 'SIG', id: p.id,
          canonical: p.canonical || p.id,
          displayName: p.displayName || p.canonical || p.id,
          nameGroup: p.nameGroup || null,
          kind: p.site || p.kind || 'Entity',
          subtype: p.subtype || '',
          aliases: p.aliases || [],
          hypothesis: p.hypothesis || '',
          span: spanMeta, source: sourceMeta,
          voice: voiceId, voiceRelation,
          ts, provenance,
        });
        ws.log.push({ op: 'SIG', text: p.canonical || p.id, kind: p.site || p.kind, sentence: ws.current, span: span, provenance, voice: voiceId, voiceRelation });
      } else if (p.op === 'DEF' && p.id && graph.entities[p.id]) {
        pushEvent({
          op: 'DEF', id: p.id,
          hypothesis: p.hypothesis || '',
          subtype: p.subtype || null,
          aliases: p.aliases || null,
          displayName: p.displayName || null,
          nameGroup: p.nameGroup || null,
          span: spanMeta, source: sourceMeta,
          voice: voiceId, voiceRelation,
          ts, provenance,
        });
        ws.log.push({ op: 'DEF', text: graph.entities[p.id].canonical, hyp: p.hypothesis, sentence: ws.current, span: span, provenance, voice: voiceId, voiceRelation });
      } else if (p.op === 'CON' && p.from && p.to) {
        pushEvent({
          op: 'CON',
          from: p.from, to: p.to,
          relation: p.relation || 'related_to',
          evidence: p.evidence || '',
          confidence: p.confidence || 'medium',
          span: spanMeta, source: sourceMeta,
          voice: voiceId, voiceRelation,
          ts, provenance,
        });
        ws.log.push({ op: 'CON', from: p.from, to: p.to, rel: p.relation, sentence: ws.current, span: span, provenance, voice: voiceId, voiceRelation });
      } else if (p.op === 'EVA' && p.id && graph.entities[p.id]) {
        pushEvent({
          op: 'EVA', id: p.id,
          verdict: p.verdict || 'holds',
          note: p.note || '',
          span: spanMeta, source: sourceMeta,
          voice: voiceId, voiceRelation,
          bySite: 'walk',
          ts, provenance,
        });
        ws.log.push({ op: 'EVA', text: graph.entities[p.id].canonical, verdict: p.verdict, note: p.note, sentence: ws.current, span: span, provenance, voice: voiceId, voiceRelation });
      } else if (p.op === 'REC' && p.id && graph.entities[p.id] && p.rename) {
        pushEvent({
          op: 'REC', id: p.id,
          rename: p.rename,
          reason: p.reason || '',
          span: spanMeta, source: sourceMeta,
          voice: voiceId, voiceRelation,
          ts, provenance,
        });
        ws.log.push({ op: 'REC', text: graph.entities[p.id].canonical, rename: p.rename, sentence: ws.current, span: span, provenance, voice: voiceId, voiceRelation });
      } else if (p.op === 'SEG' && p.id && p.into && Array.isArray(p.into) && graph.entities[p.id]) {
        pushEvent({
          op: 'SEG', id: p.id,
          into: p.into.map(ns => ({
            id: ns.id, canonical: ns.canonical, site: ns.site || ns.kind,
            displayName: ns.displayName || ns.canonical || ns.id,
            nameGroup: ns.nameGroup || null,
            subtype: ns.subtype || '', aliases: ns.aliases || [], hypothesis: ns.hypothesis || '',
          })),
          reason: p.reason || '',
          span: spanMeta, source: sourceMeta,
          voice: voiceId, voiceRelation,
          ts, provenance,
        });
        ws.log.push({ op: 'SEG', text: graph.entities[p.id].canonical, into: p.into.map(s => s.canonical).join(', '), sentence: ws.current });
      }
    }

    // refold to keep live graph aligned with log
    refoldLive();
    saveGraph();

  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    console.warn('Walk sentence error:', e);
    ws.log.push({ op: 'ERR', text: e.message, sentence: ws.current });
  }
}

function storeWalkToMatrix(ws) {
  ws = ws || walk;
  if (!mx.accessToken || !mx.roomId) return;
  const item = allItems[ws.idx];
  if (!item) return;

  const events = ws.log
    .filter(l => l.op !== 'ERR')
    .map(l => {
      const voiceMeta = l.voice ? { voice: l.voice, voiceRelation: l.voiceRelation || null } : {};
      if (l.op === 'SIG') return { op: 'SIG', site: 'entity:' + l.text, resolution: { kind: l.kind, ...voiceMeta } };
      if (l.op === 'DEF') return { op: 'DEF', site: 'entity:' + l.text, resolution: { hypothesis: l.hyp || l.def, ...voiceMeta } };
      if (l.op === 'CON') return { op: 'CON', site: 'entity:' + l.from, resolution: { joined: 'entity:' + l.to, relation: l.rel, ...voiceMeta } };
      if (l.op === 'EVA') return { op: 'EVA', site: 'entity:' + l.text, resolution: { verdict: l.verdict, note: l.note, ...voiceMeta } };
      if (l.op === 'REC') return { op: 'REC', site: 'entity:' + l.text, resolution: { rename: l.rename, ...voiceMeta } };
      if (l.op === 'SEG') return { op: 'SEG', site: 'entity:' + l.text, resolution: { into: l.into, ...voiceMeta } };
      return null;
    })
    .filter(Boolean);

  if (events.length) {
    matrixSendEoBatch(events, {
      title: item.title,
      url: item.link,
      source: item.sourceName,
      walkSentences: ws.sentences.length,
    }).catch(e => console.warn('matrix batch store failed', e));
  }
}

// Stable snapshot of a source's EO extraction state — used as the "before"
// side of a reprocess diff.
function snapshotSourceEo(srcIdx) {
  const s = sources[srcIdx];
  if (!s) return null;
  const ents = Object.entries(graph.entities)
    .filter(([, e]) => (e.sources || []).some(src => src.url === s.url || src.title === s.title))
    .map(([id, e]) => ({ id, kind: e.kind, subtype: e.subtype || null, canonical: e.canonical }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const sites = [...(s.sitesFound || [])].sort();
  return { ts: Date.now(), ents, sites };
}

function finalizeWalkSource(ws) {
  ws = ws || walk;
  const item = ws.idx != null ? allItems[ws.idx] : null;
  if (!item) return;

  let srcIdx = sources.findIndex(s =>
    (item._sourceId && s.id === item._sourceId) ||
    (item.link && s.url === item.link)
  );
  const sitesFound = ws.log.filter(l => l.op === 'SIG').map(l => l.text);

  if (srcIdx < 0 && item.link) {
    sources.unshift({
      id: 'src-' + Date.now(),
      title: item.title,
      url: item.link,
      sourceName: item.sourceName,
      body: (item.body || '').slice(0, 10000),
      date: item.date ? item.date.toISOString() : new Date().toISOString(),
      ingestedAt: new Date().toISOString(),
      sitesFound,
      processed: true,
    });
    srcIdx = 0;
    item._sourceId = sources[0].id;
  } else if (srcIdx >= 0) {
    sources[srcIdx].processed = true;
    sources[srcIdx].sitesFound = sitesFound;
  }

  if (ws._priorSnapshot && srcIdx >= 0) {
    const next = snapshotSourceEo(srcIdx);
    const before = new Set(ws._priorSnapshot.ents.map(e => e.id));
    const after = new Set(next.ents.map(e => e.id));
    const added = next.ents.filter(e => !before.has(e.id));
    const removed = ws._priorSnapshot.ents.filter(e => !after.has(e.id));
    const sitesB = new Set(ws._priorSnapshot.sites);
    const sitesA = new Set(next.sites);
    const sitesAdded = [...sitesA].filter(x => !sitesB.has(x));
    const sitesRemoved = [...sitesB].filter(x => !sitesA.has(x));
    const isNul = !added.length && !removed.length && !sitesAdded.length && !sitesRemoved.length;
    sources[srcIdx].reprocessHistory = sources[srcIdx].reprocessHistory || [];
    sources[srcIdx].reprocessHistory.push({
      at: Date.now(),
      prevAt: ws._priorSnapshot.ts,
      op: isNul ? 'NUL' : 'DIFF',
      added, removed, sitesAdded, sitesRemoved,
    });
  }
  ws._priorSnapshot = null;
  saveGraph();
}

// endWalk now cancels the currently-focused walk job via the queue.
function endWalk() {
  const focused = (typeof getFocusedWalkJob === 'function') ? getFocusedWalkJob() : null;
  if (focused) {
    cancelJob(focused.id);
  }
  walk.active = false;
  walk.paused = false;
}

function pauseFocusedWalk() {
  const focused = (typeof getFocusedWalkJob === 'function') ? getFocusedWalkJob() : null;
  if (!focused) return;
  const worker = activeWorkers.get(focused.id);
  if (worker && worker.walkState) {
    worker.walkState.paused = true;
    walk.paused = true;
    if (activeGraphTab === 'walk') renderProcessTab();
  }
}

function resumeFocusedWalk() {
  const focused = (typeof getFocusedWalkJob === 'function') ? getFocusedWalkJob() : null;
  if (!focused) return;
  const worker = activeWorkers.get(focused.id);
  if (worker && worker.walkState) {
    worker.walkState.paused = false;
    walk.paused = false;
    if (activeGraphTab === 'walk') renderProcessTab();
  }
}

function renderWalkStep() {
  const main = document.getElementById('graph-main-content');
  const item = walk.idx != null ? allItems[walk.idx] : null;

  if (!walk.active && !walk.log.length) {
    main.innerHTML = '<div style="color:var(--text-dim);padding:20px;"><i class="ph ph-cpu" style="font-size:16px;"></i> click <strong>process</strong> on any article to begin clause-by-clause indexing</div>';
    return;
  }

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

  html += '<div class="walk-controls">';
  if (walk.active) {
    if (walk.paused) {
      html += '<button onclick="resumeFocusedWalk()"><i class="ph ph-play"></i> resume</button>';
    } else {
      html += '<button onclick="pauseFocusedWalk()" style="border-color:#d4a84d;color:#d4a84d;"><i class="ph ph-pause"></i> pause</button>';
    }
    html += '<button onclick="endWalk()" style="border-color:var(--text-dim);color:var(--text-dim);"><i class="ph ph-stop"></i> stop</button>';
  } else if (walk.log.length) {
    html += '<button onclick="graphTab(\'entities\')"><i class="ph ph-map-pin"></i> review sites</button>';
  }
  html += '</div>';

  if (walk.log.length) {
    html += '<div style="margin-top:12px;max-height:300px;overflow-y:auto;">';
    for (let i = walk.log.length - 1; i >= 0; i--) {
      const l = walk.log[i];
      let line = '';
      if (l.op === 'SIG') {
        line = '<span class="walk-prop-op">SIG</span> <strong>' + escapeAttr(l.text) + '</strong> <span class="eo-kind">' + (l.kind || '') + '</span>';
      } else if (l.op === 'DEF') {
        line = '<span class="walk-prop-op">DEF</span> <strong>' + escapeAttr(l.text) + '</strong>: <span style="color:var(--text-dim);font-size:10px;">' + escapeAttr((l.hyp || l.def || '').slice(0, 100)) + '</span>';
      } else if (l.op === 'CON') {
        line = '<span class="walk-prop-op">CON</span> ' + escapeAttr(l.from) + ' <span style="color:var(--accent);">' + escapeAttr(l.rel || '') + '</span> ' + escapeAttr(l.to);
      } else if (l.op === 'EVA') {
        const color = l.verdict === 'contradiction' ? '#c06060' : l.verdict === 'tension' ? '#d4a84d' : 'var(--accent)';
        line = '<span class="walk-prop-op" style="color:' + color + ';">EVA</span> <strong>' + escapeAttr(l.text) + '</strong> <span style="color:' + color + ';">' + escapeAttr(l.verdict || '') + '</span> <span style="color:var(--text-dim);font-size:10px;">' + escapeAttr((l.note || '').slice(0, 90)) + '</span>';
      } else if (l.op === 'REC') {
        line = '<span class="walk-prop-op" style="color:#9a55cc;">REC</span> <strong>' + escapeAttr(l.text) + '</strong> → ' + escapeAttr(l.rename);
      } else if (l.op === 'SEG') {
        line = '<span class="walk-prop-op" style="color:#d4a84d;">SEG</span> <i class="ph ph-scissors"></i> <strong>' + escapeAttr(l.text) + '</strong> → ' + escapeAttr(l.into || '');
      } else if (l.op === 'ERR') {
        line = '<span style="color:#c06060;">ERR</span> ' + escapeAttr(l.text || '');
      }
      html += '<div style="padding:2px 0;font-size:11px;border-bottom:1px solid var(--border);">' +
        '<span style="color:var(--text-dim);font-size:9px;margin-right:6px;">s' + l.sentence + '</span>' + line + '</div>';
    }
    html += '</div>';
  }

  main.innerHTML = html;
}

// --- digest generation ---
async function generateDigest(idx, btn) {
  const item = allItems[idx];
  if (!item) return;

  const apiKey = getApiKey();
  if (!apiKey) {
    btn.textContent = '✗ no api key';
    btn.classList.add('errored');
    setTimeout(() => { btn.textContent = 'generate'; btn.classList.remove('errored'); }, 2000);
    document.getElementById('prompt-editor').classList.add('open');
    document.getElementById('api-key').focus();
    return;
  }

  const framing = await showPrompt({
    title: 'Frame this digest',
    submitLabel: 'Generate',
    fields: [
      { name: 'preset', label: 'Preset', type: 'chips',
        options: ['default', 'punchy', 'investigative', 'summary'], default: 'default' },
      { name: 'notes', label: 'Extra framing', type: 'textarea',
        placeholder: 'Optional — e.g., "focus on procurement", "keep under 200 words"' },
    ],
  });
  if (framing === null) return;

  btn.classList.remove('copied', 'errored');
  btn.classList.add('generating');
  btn.disabled = true;

  // If this article hasn't been walked yet, walk it first so generate
  // has the graph context (linked nodes + hypotheses + connections) to work from.
  const viewBeforeWalk = currentView;
  let autoWalked = false;
  if (!item._processed) {
    btn.textContent = 'processing...';
    autoWalked = true;
    try {
      await startWalk(idx);
    } catch (e) {
      console.warn('auto-walk failed:', e);
    }
    if (!item._processed) {
      btn.textContent = '✗ process failed';
      btn.classList.add('errored');
      btn.classList.remove('generating');
      btn.disabled = false;
      setTimeout(() => { btn.textContent = 'generate'; btn.classList.remove('errored'); }, 3000);
      return;
    }
  }
  btn.textContent = 'generating...';

  // Build the article-linked node set from the walk log, then render each
  // with its current canonical/kind/hypothesis and the article's connections.
  const walkLog = item._walkLog || [];
  const articleEntityIds = new Set();
  walkLog.forEach((l) => {
    if (l.op === 'SIG' || l.op === 'DEF' || l.op === 'EVA' || l.op === 'REC') {
      // walk.log stores text=canonical; look up by canonical match
      for (const [id, e] of Object.entries(graph.entities)) {
        if (e.canonical === l.text) { articleEntityIds.add(id); break; }
      }
    } else if (l.op === 'CON') {
      if (l.from && graph.entities[l.from]) articleEntityIds.add(l.from);
      if (l.to && graph.entities[l.to]) articleEntityIds.add(l.to);
    } else if (l.op === 'SEG') {
      for (const [id, e] of Object.entries(graph.entities)) {
        if (e.canonical === l.text) { articleEntityIds.add(id); break; }
      }
    }
  });

  const articleCons = graph.connections
    .filter(c => c.sourceUrl === item.link || c.sourceTitle === item.title);

  const articleConsLines = articleCons.map((c) => {
    const fn = graph.entities[c.from]?.canonical || c.from;
    const tn = graph.entities[c.to]?.canonical || c.to;
    const ev = c.evidence ? ' — "' + c.evidence + '"' : '';
    const conf = c.confidence ? ' [' + c.confidence + ']' : '';
    const v = voiceCanonicalFor(c.voice);
    const attrib = v ? ' [according to ' + v + (c.voiceRelation ? '/' + c.voiceRelation : '') + ']' : '';
    return '`{' + fn + '}` →' + c.relation + '→ `{' + tn + '}`' + conf + attrib + ev;
  }).join('\n');

  // Aggregate distinct voices that contributed to this article's spans.
  // Lets the digest LLM see who's speaking before it writes the bullets.
  const articleVoiceSet = new Map();
  articleEntityIds.forEach((id) => {
    const e = graph.entities[id];
    if (!e) return;
    (e.spans || []).forEach(sp => {
      if (!sp || !sp.voice) return;
      const isThisArticle = (sp.sourceUrl && sp.sourceUrl === item.link) || (sp.sourceTitle && sp.sourceTitle === item.title);
      if (!isThisArticle) return;
      const key = sp.voice + '|' + (sp.voiceRelation || '');
      if (!articleVoiceSet.has(key)) {
        articleVoiceSet.set(key, { voice: sp.voice, rel: sp.voiceRelation || null, canonical: voiceCanonicalFor(sp.voice) });
      }
    });
  });
  const articleVoiceLines = [...articleVoiceSet.values()]
    .map(v => '  - ' + v.canonical + (v.rel ? ' (' + v.rel + ')' : ''))
    .join('\n');

  const nodeLines = [];
  articleEntityIds.forEach((id) => {
    const e = graph.entities[id];
    if (!e) return;
    let line = '`{' + e.canonical + '}` (' + id + ', ' + e.kind + (e.subtype ? '/' + e.subtype : '') + ')';
    if (e.aliases && e.aliases.length) line += ' [aliases: ' + e.aliases.join(', ') + ']';
    if (e.hypothesis) line += '\n  Hypothesis: ' + e.hypothesis;
    const localCons = graph.connections.filter(c =>
      (c.from === id || c.to === id) && (articleEntityIds.has(c.from) || articleEntityIds.has(c.to))
    );
    if (localCons.length) {
      const conLines = localCons.slice(0, 6).map((c) => {
        const other = c.from === id ? c.to : c.from;
        const otherName = graph.entities[other]?.canonical || other;
        const v = voiceCanonicalFor(c.voice);
        const attrib = v ? ' [according to ' + v + (c.voiceRelation ? '/' + c.voiceRelation : '') + ']' : '';
        return '    ' + (c.from === id ? '→' : '←') + ' ' + c.relation + ' `{' + otherName + '}`' + attrib;
      });
      line += '\n  Linked in graph:\n' + conLines.join('\n');
    }
    nodeLines.push(line);
  });

  const framingHasContent = !!(framing.notes || framing.preset !== 'default');
  const framingLines = [
    framing.preset && framing.preset !== 'default' ? 'Tone preset: ' + framing.preset : '',
    framing.notes ? 'Editor instructions:\n' + framing.notes : '',
  ].filter(Boolean).join('\n');

  const framingSystemBlock = framingHasContent
    ? '---\nEDITORIAL OVERRIDE FOR THIS DIGEST\n'
      + 'The instructions below come from the editor for this single article only. They take priority over the defaults above wherever they conflict — including topical emphasis, what to foreground, length, voice, and which sections to expand or omit. Reshape the digest to honor them. These are your primary instructions, not optional context.\n\n'
      + framingLines
      + '\n---'
    : '';

  const userMsg = [
    framingHasContent ? 'EDITOR DIRECTIVE FOR THIS DIGEST (follow over the defaults):\n' + framingLines + '\n' : '',
    'Headline: ' + item.title,
    'Source: ' + item.sourceName,
    'URL: ' + item.link,
    '',
    'You are writing the digest from this article\'s walked graph context. The raw body is not provided; each linked node carries its current hypothesis, and the connection list carries the evidence quotes the walk extracted. Treat hypotheses and evidence as authoritative material for the digest.',
    '',
    nodeLines.length ? 'Article-linked nodes (from walk):\n' + nodeLines.join('\n\n') : 'Article-linked nodes (from walk): (none)',
    '',
    articleConsLines ? 'Connections evidenced in this article:\n' + articleConsLines : 'Connections evidenced in this article: (none)',
    '',
    articleVoiceLines ? 'Voices behind these claims (attribution matters — never present an asserted_by claim as if attested_by):\n' + articleVoiceLines : '',
  ].filter(Boolean).join('\n');

  try {
    const baseSystem = getPrompt();
    const systemPrompt = framingSystemBlock
      ? baseSystem + '\n\n' + framingSystemBlock
      : baseSystem;
    const rawOutput = await callClaude(systemPrompt, userMsg, 2000);
    item.generatedRaw = rawOutput;

    const sentences = splitSentences(item.body);
    const sentenceMap = {};
    (item._walkLog || []).forEach(l => {
      if (!sentenceMap[l.sentence]) sentenceMap[l.sentence] = [];
      sentenceMap[l.sentence].push(l);
    });

    const articleJson = {
      title: item.title,
      source: item.sourceName,
      url: item.link,
      date: item.date ? item.date.toISOString() : null,
      digest: rawOutput,
      sentences: sentences.map((s, si) => ({
        idx: si,
        text: s,
        events: (sentenceMap[si] || []).map(e => ({ op: e.op, ref: e.text || e.from || '', span: e.span || s, provenance: e.provenance || 'source-attested' })),
      })),
      sites: Object.entries(graph.entities)
        .filter(([id, e]) => (e.sources || []).some(s => s.url === item.link || s.title === item.title))
        .map(([id, e]) => ({
          id,
          canonical: e.canonical,
          kind: e.kind,
          subtype: e.subtype || null,
          hypothesis: e.hypothesis,
          spans: (e.spans || []).filter(sp => sp.sourceUrl === item.link || sp.sourceTitle === item.title)
            .map(sp => ({ sentenceIdx: sp.sentenceIdx, text: sp.text, voice: sp.voice || null, voiceRelation: sp.voiceRelation || null })),
          roleProfile: computeRoleProfile(id),
        })),
      connections: graph.connections
        .filter(c => c.sourceUrl === item.link || c.sourceTitle === item.title)
        .map(c => ({
          from: c.from,
          to: c.to,
          relation: c.relation,
          evidence: c.evidence,
          confidence: c.confidence,
          provenance: c.provenance || 'source-attested',
          span: c.span ? { sentenceIdx: c.span.sentenceIdx, text: c.span.text } : null,
          voice: c.voice || null,
          voiceRelation: c.voiceRelation || null,
        })),
    };
    item._articleJson = articleJson;

    const substackEl = document.getElementById('out-substack-' + idx);
    if (substackEl) substackEl.innerHTML = mdToHtml(rawOutput, { linkNodes: true });

    const linkedEl = document.getElementById('out-linked-' + idx);
    if (linkedEl) {
      let linkedHtml = '<div style="font-size:12px;">';
      linkedHtml += '<div style="margin-bottom:12px;">' + mdToHtml(rawOutput, { linkNodes: true, inlineSpans: sentenceMap, sentences }) + '</div>';
      linkedHtml += '<hr style="border:none;border-top:1px solid var(--border);margin:12px 0;">';
      linkedHtml += '<div style="font-size:10px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;"><i class="ph ph-quotes"></i> source sentences with evidence</div>';
      const pubCanonical = walk.context && graph.entities[walk.context.pubId]
        ? graph.entities[walk.context.pubId].canonical
        : (item.sourceName || '');
      sentences.forEach((s, si) => {
        const events = sentenceMap[si];
        if (!events || !events.length) return;
        const tags = events.map(e => {
          const color = e.op === 'SIG' ? '#88C070' : e.op === 'DEF' ? '#d4a84d' : e.op === 'CON' ? '#5588aa' : e.op === 'EVA' ? '#c06060' : e.op === 'REC' ? '#9a55cc' : '#888';
          return '<span style="font-size:9px;background:' + color + '22;color:' + color + ';padding:0 4px;border-radius:2px;margin-left:4px;">' + e.op + ' ' + escapeAttr(e.text || e.from || '') + '</span>';
        }).join('');
        // Voice prefix — all events from one sentence share the wrapper voice.
        const ve = events[0] || {};
        const voiceCanonical = voiceCanonicalFor(ve.voice);
        const attribPrefix = voiceCanonical
          ? 'According to <strong>' + escapeAttr(voiceCanonical) + '</strong>'
            + (ve.voiceRelation ? ' (' + escapeAttr(ve.voiceRelation) + ')' : '')
            + (pubCanonical ? ' in <em>' + escapeAttr(pubCanonical) + '</em>' : '') + ': '
          : (pubCanonical ? 'According to ' + escapeAttr(pubCanonical) + ': ' : '');
        linkedHtml += '<div id="s' + si + '" style="padding:4px 0;border-bottom:1px solid var(--border);">';
        linkedHtml += '<span style="color:var(--text-dim);font-size:9px;margin-right:6px;">s' + si + '</span>';
        linkedHtml += '<span style="color:var(--text-dim);font-size:10px;">' + attribPrefix + '</span>';
        linkedHtml += '<span style="color:var(--text);">' + escapeAttr(s) + '</span>' + tags;
        linkedHtml += '</div>';
      });
      linkedHtml += '</div>';
      linkedEl.innerHTML = linkedHtml;
    }

    const jsonEl = document.getElementById('out-json-' + idx);
    if (jsonEl) jsonEl.innerHTML = '<pre style="background:var(--bg);border:1px solid var(--border);padding:8px;border-radius:3px;font-size:10px;max-height:400px;overflow:auto;white-space:pre-wrap;">' + escapeAttr(JSON.stringify(articleJson, null, 2)) + '</pre>';

    const outputEl = document.getElementById('output-' + idx);
    if (outputEl) {
      outputEl.classList.add('visible');
      showOutputTab(idx, 'substack');
    } else {
      // Output containers aren't mounted (we're in the library/source view).
      // Refresh that view so the freshly-generated digest appears in its slot.
      const srcIdx = sources.findIndex(s => s.id === item._sourceId || (item.link && s.url === item.link));
      if (srcIdx >= 0 && typeof viewSourceInMain === 'function') viewSourceInMain(srcIdx);
    }

    btn.textContent = '✓ done';
    btn.classList.remove('generating');
    btn.classList.add('copied');
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'generate'; btn.classList.remove('copied'); }, 2000);

    if (autoWalked && viewBeforeWalk !== currentView) showView(viewBeforeWalk);
  } catch (e) {
    console.error('Claude API error:', e);
    btn.textContent = '✗ ' + (e.message || 'error');
    btn.classList.remove('generating');
    btn.classList.add('errored');
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'generate'; btn.classList.remove('errored'); }, 3000);
  }
}

function downloadArticleJson(idx) {
  const item = allItems[idx];
  if (!item || !item._articleJson) return;
  const slug = (item.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  downloadJson(item._articleJson, slug + '.json');
}

// --- clipboard ---
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.dataset.label;
    btn.textContent = 'copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  });
}

function copyOutput(idx, btn) {
  const item = allItems[idx];
  if (!item || !item.generatedRaw) return;

  const outputEl = document.getElementById('output-' + idx);
  const substackVisible = document.getElementById('out-substack-' + idx)?.style.display !== 'none';
  const jsonVisible = document.getElementById('out-json-' + idx)?.style.display !== 'none';

  if (jsonVisible && item._articleJson) {
    navigator.clipboard.writeText(JSON.stringify(item._articleJson, null, 2)).then(() => {
      btn.textContent = 'copied json';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove('copied'); }, 1500);
    });
    return;
  }

  const sourceEl = substackVisible
    ? document.getElementById('out-substack-' + idx)
    : document.getElementById('out-linked-' + idx);

  if (!sourceEl) return;

  const tmp = document.createElement('div');
  tmp.style.position = 'fixed';
  tmp.style.left = '-9999px';
  tmp.style.top = '0';
  tmp.style.opacity = '0';
  tmp.innerHTML = sourceEl.innerHTML;
  document.body.appendChild(tmp);

  const range = document.createRange();
  range.selectNodeContents(tmp);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  try {
    document.execCommand('copy');
    btn.textContent = 'copied';
    btn.classList.add('copied');
  } catch (e) {
    btn.textContent = 'copy failed';
  }

  sel.removeAllRanges();
  document.body.removeChild(tmp);
  setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove('copied'); }, 1500);
}

// --- feed filters & status ---
function updateStatus() {
  const s = document.getElementById('status');
  const showing = document.querySelectorAll('.item:not([style*="display: none"])').length;
  let msg = showing + ' items from ' + loadedCount + '/' + SOURCES.length + ' feeds';
  if (errorCount > 0) msg += ' · ' + errorCount + ' failed';
  s.textContent = msg;
}

function applyFilters() {
  const q = document.getElementById('search').value.toLowerCase();
  document.querySelectorAll('#view-feed > .item').forEach(el => {
    const src = el.dataset.source;
    const text = el.dataset.searchtext;
    const matchSource = activeFilters.size === 0 || activeFilters.has(src);
    const matchSearch = !q || text.includes(q);
    el.style.display = (matchSource && matchSearch) ? '' : 'none';
  });
  updateStatus();
}

function updateItemProgress(idx, pct) {
  const bar = document.getElementById('progress-bar-' + idx);
  if (bar) bar.style.width = pct + '%';
}

function markItemProcessed(idx) {
  const item = allItems[idx];
  if (item) item._processed = true;
  const progEl = document.getElementById('progress-' + idx);
  if (progEl) progEl.style.display = 'none';
  const itemEl = document.getElementById('item-' + idx);
  if (itemEl) {
    const genBtn = itemEl.querySelector('[data-label="generate"]');
    if (genBtn) { genBtn.disabled = false; genBtn.style.opacity = ''; genBtn.style.cursor = ''; genBtn.title = ''; }
    const srcDiv = itemEl.querySelector('.item-source');
    if (srcDiv && !srcDiv.innerHTML.includes('indexed')) {
      srcDiv.innerHTML += ' <span style="color:var(--accent);font-size:9px;"><i class="ph ph-check-circle"></i> indexed</span>';
    }
  }
  renderLibrary();
  if (typeof renderSummarizeLpList === 'function') renderSummarizeLpList();
}
