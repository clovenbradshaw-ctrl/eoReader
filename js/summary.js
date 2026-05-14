// summary.js — Summary Generator tab. Editor picks inputs at arbitrary
// granularity (individual sites, individual CON edges, individual evidence
// spans, individual articles) and the focused subgraph is built directly
// from those picks rather than via scope→seed→neighbor expansion. Runs
// against the same DEFAULT_PROMPT used by the librarian summary path,
// with an optional editorial framing override.

let summaryFilter = '';

// ---- shared helpers ----
function summarySpanKey(entityId, spanIdx) { return entityId + '::' + spanIdx; }
function summaryParseSpanKey(key) {
  const i = key.indexOf('::');
  return { entityId: key.slice(0, i), spanIdx: parseInt(key.slice(i + 2), 10) };
}
function summaryArticleKey(item) {
  if (!item) return '';
  return item.link || ('title:' + (item.title || '') + '|' + (item.date ? new Date(item.date).getTime() : ''));
}

// Mirrors the walk-log scan in walk.js:384–399: map an article to the
// entity ids its walk touched. Used when an article is picked as input.
function summaryEntitiesFromArticle(item) {
  const ids = new Set();
  const walkLog = (item && item._walkLog) || [];
  walkLog.forEach((l) => {
    if (l.op === 'SIG' || l.op === 'DEF' || l.op === 'EVA' || l.op === 'REC' || l.op === 'SEG') {
      for (const [id, e] of Object.entries(graph.entities)) {
        if (!e) continue;
        if (e.canonical === l.text) { ids.add(id); break; }
      }
    } else if (l.op === 'CON') {
      if (l.from && graph.entities[l.from]) ids.add(l.from);
      if (l.to && graph.entities[l.to]) ids.add(l.to);
    }
  });
  return ids;
}

function summaryPicksSetFor(kind) {
  if (kind === 'entity') return summaryPicks.entityIds;
  if (kind === 'connection') return summaryPicks.connectionIdxs;
  if (kind === 'span') return summaryPicks.spanRefs;
  if (kind === 'article') return summaryPicks.articleIds;
  return new Set();
}

function summaryPickerTabKindSingular() {
  if (summaryPickerTab === 'entities') return 'entity';
  if (summaryPickerTab === 'connections') return 'connection';
  if (summaryPickerTab === 'spans') return 'span';
  if (summaryPickerTab === 'articles') return 'article';
  return 'entity';
}

// ---- view ----
function renderSummaryGeneratorView() {
  const main = document.getElementById('graph-main-content');
  const sidebar = document.getElementById('graph-entities-list');
  if (main && sidebar) {
    const liveFilter = document.getElementById('summary-filter');
    if (liveFilter) summaryFilter = liveFilter.value;

    sidebar.innerHTML = renderSummarySidebarHtml();
    const fInput = document.getElementById('summary-filter');
    if (fInput) fInput.value = summaryFilter;

    main.innerHTML = renderSummaryMainHtml();
  }
  // Mirror state to the top-line surfaces (left-panel doc list + standalone view).
  if (typeof renderSummarizeLpList === 'function') renderSummarizeLpList();
  if (typeof renderSummarizeMainIfActive === 'function') renderSummarizeMainIfActive();
}

function renderSummarySidebarHtml() {
  const tabs = ['entities', 'connections', 'spans', 'articles'];
  const counts = {
    entities: summaryPicks.entityIds.size,
    connections: summaryPicks.connectionIdxs.size,
    spans: summaryPicks.spanRefs.size,
    articles: summaryPicks.articleIds.size,
  };
  let html = '<div style="padding:8px;display:flex;flex-direction:column;height:100%;">';
  html += '<div class="lp-label" style="margin-top:0;"><i class="ph ph-file-text"></i> summary generator</div>';
  html += '<p style="font-size:10px;color:var(--text-dim);line-height:1.5;margin-bottom:8px;">pick inputs at any granularity — individual sites, connections, evidence spans, or whole articles. the editor controls exactly what the prompt sees.</p>';

  html += '<div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;">';
  tabs.forEach((t) => {
    const active = summaryPickerTab === t;
    const style = active
      ? 'background:var(--accent);color:#1a1a1a;border-color:var(--accent);'
      : '';
    html += '<button class="act-btn" style="font-size:10px;padding:3px 6px;' + style + '" onclick="setSummaryPickerTab(\'' + t + '\')">' + t + ' (' + counts[t] + ')</button>';
  });
  html += '</div>';

  html += '<input type="text" id="summary-filter" placeholder="filter ' + summaryPickerTab + '..." oninput="summaryFilter=this.value;renderSummaryPickerList()" style="font-family:inherit;font-size:11px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);color:var(--text-bright);border-radius:3px;margin-bottom:6px;" />';

  html += '<div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">';
  html += '<button class="act-btn" style="font-size:9px;padding:2px 4px;" onclick="summaryPicksSelectVisible()">select visible</button>';
  html += '<button class="act-btn" style="font-size:9px;padding:2px 4px;" onclick="summaryPicksInvertVisible()">invert</button>';
  html += '<button class="act-btn" style="font-size:9px;padding:2px 4px;" onclick="clearSummaryPicks(\'' + summaryPickerTab + '\')">clear ' + summaryPickerTab + '</button>';
  html += '<button class="act-btn" style="font-size:9px;padding:2px 4px;color:#c06060;border-color:#c06060;" onclick="clearSummaryPicks(\'all\')">clear all</button>';
  html += '</div>';

  html += '<div id="summary-picker-list" style="flex:1;overflow-y:auto;border-top:1px solid var(--border);padding-top:4px;font-size:11px;">';
  html += renderSummaryPickerListInner();
  html += '</div>';

  html += '<div style="font-size:10px;color:var(--text-dim);margin-top:6px;border-top:1px solid var(--border);padding-top:6px;">picked: ' +
    counts.entities + ' sites · ' + counts.connections + ' cons · ' + counts.spans + ' spans · ' + counts.articles + ' articles</div>';
  html += '</div>';
  return html;
}

function renderSummaryPickerList() {
  const el = document.getElementById('summary-picker-list');
  if (el) el.innerHTML = renderSummaryPickerListInner();
}

function renderSummaryPickerListInner() {
  const q = (summaryFilter || '').toLowerCase();

  if (summaryPickerTab === 'entities') {
    const rows = Object.entries(graph.entities || {})
      .filter(([id, e]) => {
        if (!q) return true;
        return id.toLowerCase().includes(q) ||
          (e.canonical || '').toLowerCase().includes(q) ||
          (e.kind || '').toLowerCase().includes(q) ||
          (e.aliases || []).some((a) => (a || '').toLowerCase().includes(q));
      })
      .sort((a, b) => (a[1].canonical || '').localeCompare(b[1].canonical || ''));
    if (!rows.length) return '<div style="color:var(--text-dim);padding:6px;">no entities match</div>';
    return rows.map(([id, e]) => {
      const label = escapeAttr(e.canonical || id) + ' <span style="color:var(--text-dim);">— ' + escapeAttr(e.kind || '') + '</span>';
      return summaryPickRowHtml('entity', id, label);
    }).join('');
  }

  if (summaryPickerTab === 'connections') {
    const rows = (graph.connections || [])
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => {
        if (!q) return true;
        const fn = graph.entities[c.from] && graph.entities[c.from].canonical || c.from;
        const tn = graph.entities[c.to] && graph.entities[c.to].canonical || c.to;
        return (fn + ' ' + tn + ' ' + (c.relation || '') + ' ' + (c.evidence || '')).toLowerCase().includes(q);
      });
    if (!rows.length) return '<div style="color:var(--text-dim);padding:6px;">no connections match</div>';
    return rows.slice(0, 500).map(({ c, i }) => {
      const fn = graph.entities[c.from] && graph.entities[c.from].canonical || c.from;
      const tn = graph.entities[c.to] && graph.entities[c.to].canonical || c.to;
      const label = escapeAttr(fn) + ' <span style="color:var(--accent);">' + escapeAttr(c.relation || '?') + '</span> ' + escapeAttr(tn);
      return summaryPickRowHtml('connection', String(i), label);
    }).join('');
  }

  if (summaryPickerTab === 'spans') {
    const out = [];
    Object.entries(graph.entities || {}).forEach(([id, e]) => {
      const allSpans = e.spans || [];
      if (!allSpans.length) return;
      const matched = [];
      allSpans.forEach((sp, realIdx) => {
        if (q) {
          const hay = (sp.text || '') + ' ' + (sp.sourceTitle || '') + ' ' + (e.canonical || '');
          if (!hay.toLowerCase().includes(q)) return;
        }
        matched.push({ sp, realIdx });
      });
      if (!matched.length) return;
      out.push('<div style="margin-top:6px;font-weight:600;color:var(--text-bright);">' + escapeAttr(e.canonical || id) + ' <span style="color:var(--text-dim);font-weight:normal;">(' + matched.length + ')</span></div>');
      matched.forEach(({ sp, realIdx }) => {
        const key = summarySpanKey(id, realIdx);
        const label = '<span style="color:var(--text-dim);">' + escapeAttr((sp.sourceTitle || '?').slice(0, 40)) + ':</span> "' + escapeAttr((sp.text || '').slice(0, 140)) + '"';
        out.push(summaryPickRowHtml('span', key, label));
      });
    });
    if (!out.length) return '<div style="color:var(--text-dim);padding:6px;">no spans match</div>';
    return out.join('');
  }

  if (summaryPickerTab === 'articles') {
    const rows = (allItems || [])
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => !q ||
        (it.title || '').toLowerCase().includes(q) ||
        (it.sourceName || '').toLowerCase().includes(q));
    if (!rows.length) return '<div style="color:var(--text-dim);padding:6px;">no articles match</div>';
    return rows.slice(0, 300).map(({ it }) => {
      const articleId = summaryArticleKey(it);
      const walkedOps = (it._walkLog || []).length;
      const label = escapeAttr((it.title || '(untitled)').slice(0, 70)) +
        ' <span style="color:var(--text-dim);">— ' + escapeAttr(it.sourceName || '') +
        (walkedOps ? ', walked ' + walkedOps + ' ops' : ', not walked') + '</span>';
      return summaryPickRowHtml('article', articleId, label);
    }).join('');
  }

  return '';
}

function summaryPickRowHtml(kind, key, labelHtml) {
  const set = summaryPicksSetFor(kind);
  const checked = set.has(key);
  const bg = checked ? 'background:var(--surface);' : '';
  const safeKey = escapeAttr(key);
  return '<div data-summary-row="' + kind + '" data-summary-key="' + safeKey + '" style="display:flex;align-items:flex-start;gap:6px;padding:3px 4px;border-radius:2px;cursor:pointer;' + bg + '" onclick="toggleSummaryPick(\'' + kind + '\', this.getAttribute(\'data-summary-key\'))">' +
    '<input type="checkbox" ' + (checked ? 'checked' : '') + ' style="margin-top:2px;pointer-events:none;" />' +
    '<div style="flex:1;min-width:0;word-break:break-word;">' + labelHtml + '</div></div>';
}

function setSummaryPickerTab(tab) {
  summaryPickerTab = tab;
  summaryFilter = '';
  renderSummaryGeneratorView();
}

function toggleSummaryPick(kind, key) {
  const set = summaryPicksSetFor(kind);
  if (set.has(key)) set.delete(key); else set.add(key);
  renderSummaryGeneratorView();
}

function clearSummaryPicks(kind) {
  if (kind === 'all') {
    summaryPicks.entityIds.clear();
    summaryPicks.connectionIdxs.clear();
    summaryPicks.spanRefs.clear();
    summaryPicks.articleIds.clear();
  } else if (kind === 'entities') summaryPicks.entityIds.clear();
  else if (kind === 'connections') summaryPicks.connectionIdxs.clear();
  else if (kind === 'spans') summaryPicks.spanRefs.clear();
  else if (kind === 'articles') summaryPicks.articleIds.clear();
  renderSummaryGeneratorView();
}

function summaryPicksSelectVisible() {
  const set = summaryPicksSetFor(summaryPickerTabKindSingular());
  document.querySelectorAll('#summary-picker-list [data-summary-row]').forEach((row) => {
    set.add(row.getAttribute('data-summary-key'));
  });
  renderSummaryGeneratorView();
}

function summaryPicksInvertVisible() {
  const set = summaryPicksSetFor(summaryPickerTabKindSingular());
  document.querySelectorAll('#summary-picker-list [data-summary-row]').forEach((row) => {
    const k = row.getAttribute('data-summary-key');
    if (set.has(k)) set.delete(k); else set.add(k);
  });
  renderSummaryGeneratorView();
}

// ---- main panel ----
function renderSummaryMainHtml() {
  let html = '<div style="padding:16px;display:flex;flex-direction:column;height:calc(100vh - 180px);">';

  html += '<div style="border:1px solid var(--border);border-radius:3px;padding:10px;margin-bottom:12px;background:var(--surface);">';
  html += '<div class="lp-label" style="margin-top:0;">framing (optional)</div>';
  html += '<textarea id="summary-framing" placeholder="e.g. focus on procurement, keep under 250 words" rows="2" oninput="summaryPicks.framing=this.value" style="width:100%;font-family:inherit;font-size:11px;padding:6px;background:var(--bg);border:1px solid var(--border);color:var(--text-bright);border-radius:3px;box-sizing:border-box;">' + escapeAttr(summaryPicks.framing || '') + '</textarea>';

  const togChip = (key, label) => {
    const on = summaryPicks[key] !== false;
    const style = on ? 'background:var(--accent);color:#1a1a1a;border-color:var(--accent);' : '';
    return '<button class="act-btn" style="font-size:10px;padding:3px 6px;' + style + '" onclick="summaryPicks.' + key + '=!(summaryPicks.' + key + '!==false);renderSummaryGeneratorView()">' + label + ': ' + (on ? 'on' : 'off') + '</button>';
  };

  html += '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;">';
  html += togChip('includeSources', 'sources');
  html += togChip('includeNotes', 'editor notes');
  html += togChip('includeHypotheses', 'hypotheses');
  html += '<div style="flex:1;"></div>';
  html += '<button class="act-btn" style="font-size:11px;padding:4px 12px;background:var(--accent);color:#1a1a1a;border-color:var(--accent);font-weight:600;" onclick="generateSummaryFromPicks()"><i class="ph ph-play"></i> generate</button>';
  html += '</div>';
  html += '</div>';

  html += '<div id="summary-output-panel" style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:3px;padding:14px;background:var(--bg);position:relative;">';
  html += renderSummaryOutputHtml();
  html += '</div>';

  html += '</div>';
  return html;
}

function renderSummaryOutputHtml() {
  if (!summaryOutput) {
    return '<div style="color:var(--text-dim);font-size:11px;">no summary yet. pick inputs in the sidebar, optionally add framing, then press generate.</div>';
  }
  if (summaryOutput.pending) {
    return '<div style="color:var(--text-dim);font-size:11px;">…</div>';
  }
  if (summaryOutput.error) {
    return '<div style="color:#c06060;font-size:11px;">✗ ' + escapeAttr(summaryOutput.error) + '</div>';
  }
  let html = '<div style="font-size:12px;line-height:1.6;color:var(--text);">' + mdToHtml(summaryOutput.md, { linkNodes: true }) + '</div>';
  const u = summaryOutput.usage || {};
  const c = summaryOutput.composition || {};
  html += '<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border);font-size:10px;color:var(--text-dim);display:flex;gap:10px;flex-wrap:wrap;align-items:center;">';
  html += '<span>in ' + (u.input_tokens != null ? u.input_tokens : '?') + ' / out ' + (u.output_tokens != null ? u.output_tokens : '?') + ' tok · ' + (summaryOutput.ms || '?') + 'ms · ' + escapeAttr(summaryOutput.model || '?') + '</span>';
  html += '<span>composition: ' + (c.entities || 0) + ' sites · ' + (c.connections || 0) + ' cons · ' + (c.spans || 0) + ' spans · ' + (c.sources || 0) + ' sources</span>';
  html += '<div style="flex:1;"></div>';
  html += '<button class="act-btn" style="font-size:10px;padding:3px 8px;" onclick="copySummaryMarkdown()"><i class="ph ph-copy"></i> copy md</button>';
  html += '<button class="act-btn" style="font-size:10px;padding:3px 8px;" onclick="summaryOutput=null;renderSummaryGeneratorView()"><i class="ph ph-trash"></i> clear</button>';
  html += '</div>';
  return html;
}

// ---- generation ----
async function generateSummaryFromPicks() {
  const apiKey = getApiKey();
  if (!apiKey) { await showAlert('Set your Anthropic API key first'); return; }

  const focused = new Set([...summaryPicks.entityIds]);

  summaryPicks.connectionIdxs.forEach((idxStr) => {
    const c = graph.connections[parseInt(idxStr, 10)];
    if (!c) return;
    if (graph.entities[c.from]) focused.add(c.from);
    if (graph.entities[c.to]) focused.add(c.to);
  });

  summaryPicks.articleIds.forEach((aid) => {
    const item = (allItems || []).find((it) => summaryArticleKey(it) === aid);
    if (!item) return;
    summaryEntitiesFromArticle(item).forEach((id) => focused.add(id));
  });

  summaryPicks.spanRefs.forEach((k) => {
    const { entityId } = summaryParseSpanKey(k);
    if (graph.entities[entityId]) focused.add(entityId);
  });

  if (!focused.size) {
    await showAlert('Pick at least one site, connection, span, or article first.');
    return;
  }

  const built = buildSummaryContext(focused);
  const framingHeader = buildSummaryFramingHeader(built);
  const baseSystem = getPrompt();
  const framing = (summaryPicks.framing || '').trim();
  const systemPrompt = framing
    ? baseSystem + '\n\n---\nEDITORIAL OVERRIDE FOR THIS DIGEST\nThe instructions below come from the editor for this single summary only. They take priority over the defaults wherever they conflict.\n\n' + framing + '\n---'
    : baseSystem;

  summaryOutput = { pending: true, ts: Date.now() };
  renderSummaryGeneratorView();

  // Enqueue as a queue job so it's cancellable + visible on the process tab.
  enqueueJob('summary', {
    key: 'summary-' + Date.now(),
    title: 'summary · ' + (focused.size) + ' sites',
    systemPrompt,
    framingHeader,
    composition: built.composition,
  });
}

async function runSummaryJob(job, signal) {
  const t = job.target;
  try {
    const r = await callClaudeRaw(t.systemPrompt, t.framingHeader, 2000, null, { signal });
    summaryOutput = {
      md: r.text,
      ts: Date.now(),
      usage: r.usage,
      ms: r.ms,
      model: r.model,
      composition: t.composition,
    };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      summaryOutput = { error: 'cancelled', ts: Date.now() };
      renderSummaryGeneratorView();
      throw e;
    }
    summaryOutput = { error: e.message, ts: Date.now() };
    renderSummaryGeneratorView();
    throw e;
  }
  renderSummaryGeneratorView();
}

// Build the focused-subgraph context block from explicit picks. Mirrors the
// section layout of buildLibrarianDigestContext() (SITES / CONNECTIONS /
// SOURCES) so the system prompt sees a familiar shape, but iteration is
// driven by explicit picks rather than scope→seed→neighbor expansion.
function buildSummaryContext(focused) {
  const includeSources = summaryPicks.includeSources !== false;
  const includeNotes = summaryPicks.includeNotes !== false;
  const includeHypotheses = summaryPicks.includeHypotheses !== false;

  const composition = {
    entities: 0, connections: 0, spans: 0, sources: 0, notes: 0,
    pickedEntities: summaryPicks.entityIds.size,
    pickedConnections: summaryPicks.connectionIdxs.size,
    pickedSpans: summaryPicks.spanRefs.size,
    pickedArticles: summaryPicks.articleIds.size,
  };

  const SPAN_DEFAULT_PER_ENTITY = 3;
  const spansByEntity = new Map();
  summaryPicks.spanRefs.forEach((k) => {
    const { entityId, spanIdx } = summaryParseSpanKey(k);
    if (!spansByEntity.has(entityId)) spansByEntity.set(entityId, new Set());
    spansByEntity.get(entityId).add(spanIdx);
  });

  const lines = [];
  lines.push('FOCUSED SUBGRAPH (editor-curated picks, no scope expansion).');
  lines.push('Sites: ' + [...focused].map((id) => '`' + id + '`').join(', ') + '.');
  lines.push('');
  lines.push('SITES:');

  for (const id of focused) {
    const e = graph.entities[id];
    if (!e) continue;
    composition.entities++;
    let line = 'Site `' + id + '` — ' + e.canonical + ' (' + e.kind + (e.subtype ? ', ' + e.subtype : '') + ')';
    if (e.aliases && e.aliases.length) line += ' [aliases: ' + e.aliases.slice(0, 4).join(', ') + ']';
    lines.push(line);
    if (includeHypotheses && e.hypothesis) lines.push('  hypothesis: ' + e.hypothesis);

    const allSpans = e.spans || [];
    let spans;
    if (spansByEntity.has(id)) {
      const wanted = spansByEntity.get(id);
      spans = allSpans.filter((_, i) => wanted.has(i));
    } else {
      spans = allSpans.slice(0, SPAN_DEFAULT_PER_ENTITY);
    }
    spans.forEach((sp) => {
      lines.push('  span: ' + formatSpanForPrompt(sp));
      composition.spans++;
    });

    if (includeNotes && e.userNotes && e.userNotes.trim()) {
      lines.push('  editor note: ' + e.userNotes.trim().slice(0, 240));
      composition.notes++;
    }
  }

  // Connections: explicit picks ∪ any whose both endpoints landed in focused
  const conIdxSet = new Set();
  summaryPicks.connectionIdxs.forEach((s) => conIdxSet.add(parseInt(s, 10)));
  (graph.connections || []).forEach((c, i) => {
    if (focused.has(c.from) && focused.has(c.to)) conIdxSet.add(i);
  });
  const cons = [...conIdxSet].map((i) => graph.connections[i]).filter(Boolean);
  if (cons.length) {
    lines.push('');
    lines.push('CONNECTIONS (' + cons.length + '):');
    cons.forEach((c) => {
      lines.push('  ' + formatConnectionForPrompt(c));
      composition.connections++;
    });
  }

  // Sources: collected from focused-entity spans + connection sources
  const srcMap = new Map();
  const addSrc = (title, url) => {
    if (!title && !url) return;
    const key = (url || '') + '|' + (title || '');
    if (!srcMap.has(key)) srcMap.set(key, { title: title || '', url: url || '' });
  };
  for (const id of focused) {
    const e = graph.entities[id];
    if (!e) continue;
    (e.spans || []).forEach((sp) => addSrc(sp.sourceTitle, sp.sourceUrl));
  }
  cons.forEach((c) => addSrc(c.sourceTitle, c.sourceUrl));
  const sources = [...srcMap.values()];
  composition.sources = sources.length;
  if (includeSources && sources.length) {
    lines.push('');
    lines.push('SOURCES (' + sources.length + ' distinct):');
    sources.slice(0, 12).forEach((s) => lines.push('  - ' + (s.title || '(untitled)') + (s.url ? ' — ' + s.url : '')));
  }

  // Voices block — group voices by voiceRelation so the digest LLM can
  // tell journalist reporting apart from interested-party assertion.
  const byRel = { attested_by: [], asserted_by: [], documented_in: [], characterized_by: [] };
  for (const id of focused) {
    const e = graph.entities[id];
    if (!e) continue;
    voicesOnRecord(e).forEach(v => {
      const rel = v.voiceRelation || 'attested_by';
      if (!byRel[rel]) byRel[rel] = [];
      if (!byRel[rel].some(x => x.voice === v.voice)) byRel[rel].push(v);
    });
  }
  const anyVoice = Object.values(byRel).some(arr => arr.length);
  if (anyVoice) {
    lines.push('');
    lines.push('VOICES (grouped by relation — attribution must travel into the digest):');
    Object.entries(byRel).forEach(([rel, arr]) => {
      if (!arr.length) return;
      lines.push('  ' + rel + ': ' + arr.map(v => v.canonical).join(', '));
    });
  }

  return { context: lines.join('\n'), composition, sources, focused: [...focused] };
}

function buildSummaryFramingHeader(built) {
  const ids = built.focused;
  let headlineGuess;
  if (ids.length === 1) {
    headlineGuess = (graph.entities[ids[0]] && graph.entities[ids[0]].canonical) || ids[0];
  } else if (ids.length <= 3) {
    headlineGuess = ids.map((id) => (graph.entities[id] && graph.entities[id].canonical) || id).join(' / ');
  } else {
    headlineGuess = 'Index summary — ' + ids.length + ' sites';
  }
  const sourcesLine = built.sources.length
    ? built.sources.slice(0, 6).map((s) => s.url ? '[' + (s.title || s.url) + '](' + s.url + ')' : (s.title || '')).filter(Boolean).join(' · ')
    : '';

  return [
    '=== DIGEST FROM GRAPH TRAVERSAL ===',
    'Produce the standardized digest exactly as the system prompt specifies. There is no single article — the focused subgraph below (editor-curated picks, sites, spans, connections, sources) is your only evidence. Quote spans verbatim; do not fabricate quotations beyond what is provided.',
    '',
    'Headline topic: ' + headlineGuess + ' (rewrite for clarity if useful — still ### H3).',
    'Source line (use as the italic Markdown source line; if empty, use "Source: index, multiple feeds"): *' + (sourcesLine || 'Source: index, multiple feeds') + '*',
    '',
    'Voice convention in the context below: span and connection lines end with "according to <voice> (<relation>) in <publication>". Relations are attested_by (journalist reporting), asserted_by (quoted speaker), documented_in (cited record), characterized_by (interpretive frame). Carry the attribution through to the bullets; never present an asserted_by claim as if it were attested.',
    '',
    '=== FOCUSED SUBGRAPH ===',
    built.context,
  ].join('\n');
}

function copySummaryMarkdown() {
  if (!summaryOutput || !summaryOutput.md) return;
  const text = summaryOutput.md;
  const done = () => {
    const panel = document.getElementById('summary-output-panel');
    if (!panel) return;
    const note = document.createElement('div');
    note.textContent = '✓ copied';
    note.style.cssText = 'position:absolute;background:var(--accent);color:#1a1a1a;padding:4px 10px;font-size:11px;border-radius:3px;top:14px;right:14px;';
    panel.appendChild(note);
    setTimeout(() => note.remove(), 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (_) {}
    document.body.removeChild(ta);
  }
}

// =====================================================================
// Top-line "summarize" surface: document-centric drill-down picker in
// the left panel + standalone view-summarize for framing + output.
// Reuses summaryPicks, buildSummaryContext, generateSummaryFromPicks.
// =====================================================================

// Spans whose source matches this article (by url, falling back to title).
function summarySpansFromArticle(item) {
  const out = [];
  if (!item) return out;
  const wantUrl = item.link || '';
  const wantTitle = item.title || '';
  Object.entries(graph.entities || {}).forEach(([id, e]) => {
    if (!e) return;
    (e.spans || []).forEach((sp, i) => {
      if (!sp) return;
      const u = sp.sourceUrl || '';
      const t = sp.sourceTitle || '';
      if ((wantUrl && u === wantUrl) || (!u && wantTitle && t === wantTitle)) {
        out.push({ entityId: id, spanIdx: i, span: sp, entity: e });
      }
    });
  });
  return out;
}

// Connection indices whose evidence came from this article.
function summaryConnectionsFromArticle(item) {
  const out = [];
  if (!item) return out;
  const wantUrl = item.link || '';
  const wantTitle = item.title || '';
  (graph.connections || []).forEach((c, i) => {
    if (!c) return;
    const u = c.sourceUrl || '';
    const t = c.sourceTitle || '';
    if ((wantUrl && u === wantUrl) || (!u && wantTitle && t === wantTitle)) {
      out.push({ idx: i, con: c });
    }
  });
  return out;
}

// Three-state checkbox: 'on' = article picked, 'half' = some sub-picks,
// 'off' = nothing. Drives the doc-row checkbox and the toggle action.
function summarizeDocState(item) {
  const articleId = summaryArticleKey(item);
  if (summaryPicks.articleIds.has(articleId)) return 'on';
  const ents = summaryEntitiesFromArticle(item);
  for (const id of ents) if (summaryPicks.entityIds.has(id)) return 'half';
  const spans = summarySpansFromArticle(item);
  for (const s of spans) if (summaryPicks.spanRefs.has(summarySpanKey(s.entityId, s.spanIdx))) return 'half';
  const cons = summaryConnectionsFromArticle(item);
  for (const c of cons) if (summaryPicks.connectionIdxs.has(String(c.idx))) return 'half';
  return 'off';
}

// Articles eligible for the lp picker: anything walked, plus anything the
// user has ingested. The walked check is heuristic — _walkLog is the
// canonical marker of "this doc contributed to the graph".
function summarizeLpDocs() {
  return (allItems || []).filter((it) => ((it && it._walkLog) || []).length > 0);
}

function renderSummarizeLpList() {
  const el = document.getElementById('summarize-lp-list');
  if (!el) return;
  const docs = summarizeLpDocs();
  if (!docs.length) {
    el.innerHTML = '<div style="color:var(--text-dim);padding:6px;font-size:10px;">no walked docs yet. ingest something and run the walk.</div>';
    updateSummarizeCompPill();
    return;
  }
  let html = '';
  docs.forEach((item) => { html += renderSummarizeLpDocRow(item); });
  el.innerHTML = html;
  updateSummarizeCompPill();
}

function renderSummarizeLpDocRow(item) {
  const articleId = summaryArticleKey(item);
  const safeId = escapeAttr(articleId);
  const state = summarizeDocState(item);
  const expanded = summaryPicks.lpExpanded.has(articleId);
  const ents = summaryEntitiesFromArticle(item);
  const spans = summarySpansFromArticle(item);
  const cons = summaryConnectionsFromArticle(item);
  const opCount = (item._walkLog || []).length;

  const box = state === 'on'
    ? '<i class="ph-fill ph-check-square" style="color:var(--accent);"></i>'
    : state === 'half'
      ? '<i class="ph-fill ph-minus-square" style="color:var(--accent);opacity:0.6;"></i>'
      : '<i class="ph ph-square" style="color:var(--text-dim);"></i>';
  const caret = expanded ? 'ph-caret-down' : 'ph-caret-right';

  let html = '<div style="border-bottom:1px solid var(--border);padding:3px 0;">';
  html += '<div style="display:flex;align-items:flex-start;gap:4px;font-size:11px;">';
  html += '<span style="cursor:pointer;padding-top:2px;" onclick="toggleSummarizeLpExpand(\'' + safeId + '\')"><i class="ph ' + caret + '" style="font-size:10px;color:var(--text-dim);"></i></span>';
  html += '<span style="cursor:pointer;padding-top:1px;" onclick="toggleSummarizeLpDoc(\'' + safeId + '\')">' + box + '</span>';
  html += '<div style="flex:1;min-width:0;cursor:pointer;" onclick="toggleSummarizeLpExpand(\'' + safeId + '\')">';
  html += '<div style="color:var(--text-bright);word-break:break-word;">' + escapeAttr((item.title || '(untitled)').slice(0, 80)) + '</div>';
  html += '<div style="color:var(--text-dim);font-size:9px;">' + escapeAttr(item.sourceName || '') + ' · ' + ents.size + ' sites · ' + spans.length + ' spans · ' + cons.length + ' cons · ' + opCount + ' ops</div>';
  html += '</div></div>';

  if (expanded) {
    html += '<div style="padding:4px 0 4px 20px;">';
    html += renderSummarizeLpDrilldown(item, ents, spans, cons);
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderSummarizeLpDrilldown(item, ents, spans, cons) {
  let html = '';

  // Entities sub-section
  if (ents.size) {
    html += '<div style="font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin:4px 0 2px;">sites (' + ents.size + ')</div>';
    [...ents].forEach((id) => {
      const e = graph.entities[id];
      if (!e) return;
      const checked = summaryPicks.entityIds.has(id);
      const box = checked
        ? '<i class="ph-fill ph-check-square" style="color:var(--accent);"></i>'
        : '<i class="ph ph-square" style="color:var(--text-dim);"></i>';
      html += '<div style="display:flex;align-items:flex-start;gap:5px;padding:2px 0;font-size:10px;cursor:pointer;" onclick="toggleSummaryPick(\'entity\', \'' + escapeAttr(id) + '\');renderSummarizeLpList();renderSummarizeMainIfActive();">';
      html += '<span>' + box + '</span>';
      html += '<div style="flex:1;min-width:0;"><span style="color:var(--text-bright);">' + escapeAttr(e.canonical || id) + '</span> <span style="color:var(--text-dim);">— ' + escapeAttr(e.kind || '') + '</span></div>';
      html += '</div>';
    });
  }

  // Spans sub-section
  if (spans.length) {
    html += '<div style="font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin:6px 0 2px;">spans (' + spans.length + ')</div>';
    spans.forEach(({ entityId, spanIdx, span, entity }) => {
      const key = summarySpanKey(entityId, spanIdx);
      const checked = summaryPicks.spanRefs.has(key);
      const box = checked
        ? '<i class="ph-fill ph-check-square" style="color:var(--accent);"></i>'
        : '<i class="ph ph-square" style="color:var(--text-dim);"></i>';
      html += '<div style="display:flex;align-items:flex-start;gap:5px;padding:2px 0;font-size:10px;cursor:pointer;" onclick="toggleSummaryPick(\'span\', \'' + escapeAttr(key) + '\');renderSummarizeLpList();renderSummarizeMainIfActive();">';
      html += '<span>' + box + '</span>';
      html += '<div style="flex:1;min-width:0;color:var(--text);word-break:break-word;"><span style="color:var(--text-dim);">' + escapeAttr((entity.canonical || entityId).slice(0, 30)) + ':</span> "' + escapeAttr((span.text || '').slice(0, 110)) + '"</div>';
      html += '</div>';
    });
  }

  // Connections sub-section
  if (cons.length) {
    html += '<div style="font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin:6px 0 2px;">connections (' + cons.length + ')</div>';
    cons.forEach(({ idx, con }) => {
      const key = String(idx);
      const checked = summaryPicks.connectionIdxs.has(key);
      const box = checked
        ? '<i class="ph-fill ph-check-square" style="color:var(--accent);"></i>'
        : '<i class="ph ph-square" style="color:var(--text-dim);"></i>';
      const fn = (graph.entities[con.from] && graph.entities[con.from].canonical) || con.from;
      const tn = (graph.entities[con.to] && graph.entities[con.to].canonical) || con.to;
      html += '<div style="display:flex;align-items:flex-start;gap:5px;padding:2px 0;font-size:10px;cursor:pointer;" onclick="toggleSummaryPick(\'connection\', \'' + escapeAttr(key) + '\');renderSummarizeLpList();renderSummarizeMainIfActive();">';
      html += '<span>' + box + '</span>';
      html += '<div style="flex:1;min-width:0;color:var(--text);"><span style="color:var(--text-bright);">' + escapeAttr(fn) + '</span> <span style="color:var(--accent);">' + escapeAttr(con.relation || '?') + '</span> <span style="color:var(--text-bright);">' + escapeAttr(tn) + '</span></div>';
      html += '</div>';
    });
  }

  if (!ents.size && !spans.length && !cons.length) {
    html += '<div style="color:var(--text-dim);font-size:10px;padding:4px 0;">no sites / spans / connections recorded for this doc.</div>';
  }
  return html;
}

function toggleSummarizeLpDoc(articleId) {
  const item = (allItems || []).find((it) => summaryArticleKey(it) === articleId);
  if (!item) return;
  const state = summarizeDocState(item);
  if (state === 'on') {
    summaryPicks.articleIds.delete(articleId);
  } else if (state === 'half') {
    // clear sub-picks contributed by this doc, then promote to whole-doc pick.
    summaryEntitiesFromArticle(item).forEach((id) => summaryPicks.entityIds.delete(id));
    summarySpansFromArticle(item).forEach((s) => summaryPicks.spanRefs.delete(summarySpanKey(s.entityId, s.spanIdx)));
    summaryConnectionsFromArticle(item).forEach((c) => summaryPicks.connectionIdxs.delete(String(c.idx)));
    summaryPicks.articleIds.add(articleId);
  } else {
    summaryPicks.articleIds.add(articleId);
  }
  renderSummarizeLpList();
  renderSummarizeMainIfActive();
}

function toggleSummarizeLpExpand(articleId) {
  if (summaryPicks.lpExpanded.has(articleId)) summaryPicks.lpExpanded.delete(articleId);
  else summaryPicks.lpExpanded.add(articleId);
  renderSummarizeLpList();
}

function updateSummarizeCompPill() {
  const pill = document.getElementById('summarize-comp-pill');
  if (!pill) return;
  const a = summaryPicks.articleIds.size;
  const e = summaryPicks.entityIds.size;
  const c = summaryPicks.connectionIdxs.size;
  const s = summaryPicks.spanRefs.size;
  if (!a && !e && !c && !s) { pill.textContent = ''; return; }
  pill.textContent = a + 'd · ' + e + 's · ' + c + 'c · ' + s + 'sp';
}

// ---- view-summarize (top-level view) ----
function switchToSummarizeView() {
  // expand the lp section if collapsed
  const sect = document.getElementById('section-summarize');
  if (sect && getComputedStyle(sect).display === 'none') {
    sect.style.display = '';
    const caret = document.getElementById('caret-summarize');
    if (caret) caret.classList.remove('collapsed');
  }
  // Transition the view first so a render failure can't strand the user on feed.
  showView('summarize');
  try {
    renderSummarizeLpList();
  } catch (err) {
    console.error('renderSummarizeLpList failed', err);
  }
}

function renderSummarizeMainIfActive() {
  if (currentView === 'summarize') renderSummarizeMainView();
}

function renderSummarizeMainView() {
  const root = document.getElementById('view-summarize');
  if (!root) return;
  const a = summaryPicks.articleIds.size;
  const e = summaryPicks.entityIds.size;
  const c = summaryPicks.connectionIdxs.size;
  const s = summaryPicks.spanRefs.size;
  const total = a + e + c + s;

  const togChip = (key, label) => {
    const on = summaryPicks[key] !== false;
    const style = on ? 'background:var(--accent);color:#1a1a1a;border-color:var(--accent);' : '';
    return '<button class="act-btn" style="font-size:10px;padding:3px 6px;' + style + '" onclick="summaryPicks.' + key + '=!(summaryPicks.' + key + '!==false);renderSummarizeMainView()">' + label + ': ' + (on ? 'on' : 'off') + '</button>';
  };

  let html = '<div style="padding:16px;display:flex;flex-direction:column;height:100%;box-sizing:border-box;overflow:hidden;">';
  html += '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px;flex-wrap:wrap;">';
  html += '<div style="font-size:13px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;font-weight:600;"><i class="ph ph-file-text"></i> summarize</div>';
  html += '<div style="font-size:11px;color:var(--text-dim);">' + a + ' docs · ' + e + ' sites · ' + c + ' cons · ' + s + ' spans picked</div>';
  html += '</div>';

  html += '<div style="border:1px solid var(--border);border-radius:3px;padding:10px;margin-bottom:12px;background:var(--surface);">';
  html += '<div class="lp-label" style="margin-top:0;">framing (optional)</div>';
  html += '<textarea id="summarize-main-framing" placeholder="optional extra instructions. picks already drive the focused subgraph — only add here if you want to override style or scope." rows="2" oninput="summaryPicks.framing=this.value" style="width:100%;font-family:inherit;font-size:11px;padding:6px;background:var(--bg);border:1px solid var(--border);color:var(--text-bright);border-radius:3px;box-sizing:border-box;">' + escapeAttr(summaryPicks.framing || '') + '</textarea>';
  html += '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;">';
  html += togChip('includeSources', 'sources');
  html += togChip('includeNotes', 'editor notes');
  html += togChip('includeHypotheses', 'hypotheses');
  html += '<div style="flex:1;"></div>';
  const genDisabled = total === 0 ? 'opacity:0.5;cursor:not-allowed;' : '';
  html += '<button class="act-btn" style="font-size:11px;padding:4px 14px;background:var(--accent);color:#1a1a1a;border-color:var(--accent);font-weight:600;' + genDisabled + '" onclick="generateSummaryFromPicks().then(renderSummarizeMainView)"' + (total === 0 ? ' disabled' : '') + '><i class="ph ph-play"></i> generate</button>';
  html += '</div></div>';

  html += '<div id="summary-output-panel" style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:3px;padding:14px;background:var(--bg);position:relative;">';
  html += renderSummaryOutputHtml();
  html += '</div>';

  html += '</div>';
  root.innerHTML = html;
}
