// summary.js — NotebookLM-style "chat with docs". Sources pane on the left
// (any ingested article qualifies; walked docs additionally expose drill-down
// for sites, spans, connections inside that source). Chat in the middle is
// a turn-based transcript that uses the active picks as its focused
// subgraph. Right pane (toggleable) shows the source clicked in the list
// with drill-down checkboxes.

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

// Mirrors the walk-log scan in walk.js: map an article to the entity ids
// its walk touched.
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

function toggleSummaryPick(kind, key) {
  const set = summaryPicksSetFor(kind);
  if (set.has(key)) set.delete(key); else set.add(key);
  renderSummarizeMainIfActive();
  updateSummarizeCompPill();
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
  renderSummarizeMainIfActive();
  updateSummarizeCompPill();
}

// ---- doc-derived data ----

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
// 'off' = nothing.
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

// Sources eligible for the chat: any ingested article. Walked docs are
// tagged so the UI can offer drill-down; unwalked docs are pickable at
// article-level only.
function summarizeLpDocs() {
  return (allItems || []).filter((it) => !!it);
}

// ---- view orchestration ----

function switchToSummarizeView() {
  const sect = document.getElementById('section-summarize');
  if (sect && getComputedStyle(sect).display === 'none') {
    sect.style.display = '';
    const caret = document.getElementById('caret-summarize');
    if (caret) caret.classList.remove('collapsed');
  }
  showView('summarize');
  try { renderSummarize(); } catch (err) { console.error('renderSummarize failed', err); }
}

function renderSummarizeMainIfActive() {
  if (currentView === 'summarize') renderSummarize();
  updateSummarizeCompPill();
}

// Called by showView() for the 'summarize' view branch.
function renderSummarizeMainView() { renderSummarize(); }

// Back-compat aliases for any caller still using the old names.
function renderSummaryGeneratorView() { renderSummarizeMainIfActive(); }
function renderSummarizeLpList() { updateSummarizeCompPill(); }
function renderSummaryPickerList() { /* picker tabs retired */ }

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

// ---- the three-pane renderer ----

function renderSummarize() {
  const root = document.getElementById('view-summarize');
  if (!root) return;

  const detailOpen = !!summaryDetailDocId;
  const sourcesWidth = detailOpen ? '260px' : '300px';
  const detailCol = detailOpen
    ? '<div style="width:340px;border-left:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;background:var(--surface);">' + renderDetailPane() + '</div>'
    : '';

  let html = '<div style="display:flex;flex:1;overflow:hidden;height:100%;">';
  html += '<div style="width:' + sourcesWidth + ';border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;">' + renderSourcesPane() + '</div>';
  html += '<div style="flex:1;display:flex;flex-direction:column;overflow:hidden;">' + renderChatPane() + '</div>';
  html += detailCol;
  html += '</div>';
  root.innerHTML = html;

  // Auto-scroll chat to bottom after render.
  const transcript = document.getElementById('summary-transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;

  updateSummarizeCompPill();
}

// ---- sources pane ----

function renderSourcesPane() {
  const docs = summarizeLpDocs();
  const a = summaryPicks.articleIds.size;
  const e = summaryPicks.entityIds.size;
  const c = summaryPicks.connectionIdxs.size;
  const s = summaryPicks.spanRefs.size;

  let html = '<div style="padding:10px 10px 6px;border-bottom:1px solid var(--border);">';
  html += '<div class="lp-label" style="margin-top:0;"><i class="ph ph-chats-circle"></i> sources</div>';
  html += '<div style="font-size:10px;color:var(--text-dim);line-height:1.45;margin-bottom:6px;">pick the docs you want grounded in this chat. click a row to drill into its sites / spans / connections.</div>';
  html += '<div style="font-size:10px;color:var(--text-dim);">' + a + ' docs · ' + e + ' sites · ' + c + ' cons · ' + s + ' spans picked</div>';
  html += '<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">';
  html += '<button class="act-btn" style="font-size:10px;padding:3px 6px;" onclick="clearSummaryPicks(\'all\')"><i class="ph ph-eraser"></i> clear</button>';
  html += '</div></div>';

  html += '<div style="flex:1;overflow-y:auto;padding:4px 0;">';
  if (!docs.length) {
    html += '<div style="color:var(--text-dim);padding:12px;font-size:11px;">no ingested docs yet. ingest via URL, file, paste, or a feed first.</div>';
  } else {
    docs.forEach((item) => { html += renderSourceRow(item); });
  }
  html += '</div>';
  return html;
}

function renderSourceRow(item) {
  const articleId = summaryArticleKey(item);
  const safeId = escapeAttr(articleId);
  const state = summarizeDocState(item);
  const walked = ((item._walkLog || []).length) > 0;
  const isOpen = summaryDetailDocId === articleId;

  const box = state === 'on'
    ? '<i class="ph-fill ph-check-square" style="color:var(--accent);"></i>'
    : state === 'half'
      ? '<i class="ph-fill ph-minus-square" style="color:var(--accent);opacity:0.7;"></i>'
      : '<i class="ph ph-square" style="color:var(--text-dim);"></i>';
  const badge = walked
    ? '<span style="font-size:9px;color:var(--accent);background:rgba(120,200,140,0.12);padding:1px 4px;border-radius:2px;text-transform:uppercase;letter-spacing:0.3px;">walked</span>'
    : '<span style="font-size:9px;color:var(--text-dim);background:rgba(160,160,160,0.12);padding:1px 4px;border-radius:2px;text-transform:uppercase;letter-spacing:0.3px;">ingested</span>';

  const rowBg = isOpen ? 'background:var(--surface);' : '';
  let html = '<div style="border-bottom:1px solid var(--border);padding:6px 10px;display:flex;align-items:flex-start;gap:6px;font-size:11px;cursor:pointer;' + rowBg + '" onclick="openSummaryDetail(\'' + safeId + '\')">';
  html += '<span style="padding-top:1px;cursor:pointer;" onclick="event.stopPropagation();toggleSummarizeArticle(\'' + safeId + '\')">' + box + '</span>';
  html += '<div style="flex:1;min-width:0;">';
  html += '<div style="color:var(--text-bright);word-break:break-word;line-height:1.3;">' + escapeAttr((item.title || '(untitled)').slice(0, 90)) + '</div>';
  html += '<div style="display:flex;gap:6px;align-items:center;margin-top:3px;flex-wrap:wrap;">' + badge;
  html += '<span style="font-size:9px;color:var(--text-dim);">' + escapeAttr(item.sourceName || '') + '</span>';
  html += '</div>';
  html += '</div></div>';
  return html;
}

function toggleSummarizeArticle(articleId) {
  const item = (allItems || []).find((it) => summaryArticleKey(it) === articleId);
  if (!item) return;
  const state = summarizeDocState(item);
  if (state === 'on') {
    summaryPicks.articleIds.delete(articleId);
  } else if (state === 'half') {
    // half = sub-picks present. Clear them, then promote to whole-article pick.
    summaryEntitiesFromArticle(item).forEach((id) => summaryPicks.entityIds.delete(id));
    summarySpansFromArticle(item).forEach((s) => summaryPicks.spanRefs.delete(summarySpanKey(s.entityId, s.spanIdx)));
    summaryConnectionsFromArticle(item).forEach((c) => summaryPicks.connectionIdxs.delete(String(c.idx)));
    summaryPicks.articleIds.add(articleId);
  } else {
    summaryPicks.articleIds.add(articleId);
  }
  renderSummarizeMainIfActive();
}

// ---- detail pane (right column) ----

function openSummaryDetail(articleId) {
  summaryDetailDocId = articleId;
  renderSummarizeMainIfActive();
}

function closeSummaryDetail() {
  summaryDetailDocId = null;
  renderSummarizeMainIfActive();
}

function renderDetailPane() {
  const item = (allItems || []).find((it) => summaryArticleKey(it) === summaryDetailDocId);
  if (!item) {
    return '<div style="padding:14px;font-size:11px;color:var(--text-dim);">source not found.<div style="margin-top:8px;"><button class="act-btn" style="font-size:10px;" onclick="closeSummaryDetail()">close</button></div></div>';
  }
  const walked = ((item._walkLog || []).length) > 0;
  const articleId = summaryArticleKey(item);
  const state = summarizeDocState(item);
  const ents = summaryEntitiesFromArticle(item);
  const spans = summarySpansFromArticle(item);
  const cons = summaryConnectionsFromArticle(item);

  let html = '<div style="padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:8px;">';
  html += '<div style="flex:1;min-width:0;">';
  html += '<div style="font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">source</div>';
  html += '<div style="color:var(--text-bright);font-size:12px;line-height:1.3;word-break:break-word;">' + escapeAttr(item.title || '(untitled)') + '</div>';
  html += '<div style="font-size:10px;color:var(--text-dim);margin-top:3px;">' + escapeAttr(item.sourceName || '') + (item.link ? ' · <a href="' + escapeAttr(item.link) + '" target="_blank" style="color:var(--text-dim);">link</a>' : '') + '</div>';
  html += '</div>';
  html += '<button class="act-btn" style="font-size:10px;padding:3px 6px;" onclick="closeSummaryDetail()" title="close"><i class="ph ph-x"></i></button>';
  html += '</div>';

  html += '<div style="padding:10px 12px;border-bottom:1px solid var(--border);">';
  const safeId = escapeAttr(articleId);
  const wholeBtnStyle = state === 'on'
    ? 'background:var(--accent);color:#1a1a1a;border-color:var(--accent);'
    : '';
  const wholeLabel = state === 'on' ? '✓ whole article picked' : (state === 'half' ? 'pick whole article (overrides sub-picks)' : 'pick whole article');
  html += '<button class="act-btn" style="width:100%;font-size:10px;padding:4px 6px;' + wholeBtnStyle + '" onclick="toggleSummarizeArticle(\'' + safeId + '\')">' + wholeLabel + '</button>';
  html += '</div>';

  html += '<div style="flex:1;overflow-y:auto;padding:8px 12px;">';
  if (!walked) {
    html += '<div style="font-size:10px;color:var(--text-dim);line-height:1.5;">this doc has not been walked yet. drill-down picks for sites, spans, and connections light up once the walk runs over it. you can still include the whole article above.</div>';
  } else {
    html += renderSourceDetailBody(item, ents, spans, cons);
  }
  html += '</div>';
  return html;
}

function renderSourceDetailBody(item, ents, spans, cons) {
  let html = '';

  if (ents.size) {
    html += '<div style="font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin:4px 0 4px;">sites (' + ents.size + ')</div>';
    [...ents].forEach((id) => {
      const e = graph.entities[id];
      if (!e) return;
      const checked = summaryPicks.entityIds.has(id);
      const box = checked
        ? '<i class="ph-fill ph-check-square" style="color:var(--accent);"></i>'
        : '<i class="ph ph-square" style="color:var(--text-dim);"></i>';
      html += '<div style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;font-size:10px;cursor:pointer;" onclick="toggleSummaryPick(\'entity\', \'' + escapeAttr(id) + '\')">';
      html += '<span>' + box + '</span>';
      html += '<div style="flex:1;min-width:0;"><span style="color:var(--text-bright);">' + escapeAttr(e.canonical || id) + '</span> <span style="color:var(--text-dim);">— ' + escapeAttr(e.kind || '') + '</span></div>';
      html += '</div>';
    });
  }

  if (spans.length) {
    html += '<div style="font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin:10px 0 4px;">spans (' + spans.length + ')</div>';
    spans.forEach(({ entityId, spanIdx, span, entity }) => {
      const key = summarySpanKey(entityId, spanIdx);
      const checked = summaryPicks.spanRefs.has(key);
      const box = checked
        ? '<i class="ph-fill ph-check-square" style="color:var(--accent);"></i>'
        : '<i class="ph ph-square" style="color:var(--text-dim);"></i>';
      html += '<div style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;font-size:10px;cursor:pointer;" onclick="toggleSummaryPick(\'span\', \'' + escapeAttr(key) + '\')">';
      html += '<span>' + box + '</span>';
      html += '<div style="flex:1;min-width:0;color:var(--text);word-break:break-word;line-height:1.4;"><span style="color:var(--text-dim);">' + escapeAttr((entity.canonical || entityId).slice(0, 30)) + ':</span> "' + escapeAttr((span.text || '').slice(0, 140)) + '"</div>';
      html += '</div>';
    });
  }

  if (cons.length) {
    html += '<div style="font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin:10px 0 4px;">connections (' + cons.length + ')</div>';
    cons.forEach(({ idx, con }) => {
      const key = String(idx);
      const checked = summaryPicks.connectionIdxs.has(key);
      const box = checked
        ? '<i class="ph-fill ph-check-square" style="color:var(--accent);"></i>'
        : '<i class="ph ph-square" style="color:var(--text-dim);"></i>';
      const fn = (graph.entities[con.from] && graph.entities[con.from].canonical) || con.from;
      const tn = (graph.entities[con.to] && graph.entities[con.to].canonical) || con.to;
      html += '<div style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;font-size:10px;cursor:pointer;" onclick="toggleSummaryPick(\'connection\', \'' + escapeAttr(key) + '\')">';
      html += '<span>' + box + '</span>';
      html += '<div style="flex:1;min-width:0;color:var(--text);line-height:1.4;"><span style="color:var(--text-bright);">' + escapeAttr(fn) + '</span> <span style="color:var(--accent);">' + escapeAttr(con.relation || '?') + '</span> <span style="color:var(--text-bright);">' + escapeAttr(tn) + '</span></div>';
      html += '</div>';
    });
  }

  if (!ents.size && !spans.length && !cons.length) {
    html += '<div style="color:var(--text-dim);font-size:10px;padding:6px 0;">no sites, spans, or connections recorded for this doc.</div>';
  }
  return html;
}

// ---- chat pane (middle) ----

function renderChatPane() {
  const a = summaryPicks.articleIds.size;
  const e = summaryPicks.entityIds.size;
  const c = summaryPicks.connectionIdxs.size;
  const s = summaryPicks.spanRefs.size;
  const total = a + e + c + s;

  const togChip = (key, label) => {
    const on = summaryPicks[key] !== false;
    const style = on ? 'background:var(--accent);color:#1a1a1a;border-color:var(--accent);' : '';
    return '<button class="act-btn" style="font-size:10px;padding:3px 6px;' + style + '" onclick="summaryPicks.' + key + '=!(summaryPicks.' + key + '!==false);renderSummarize()">' + label + ': ' + (on ? 'on' : 'off') + '</button>';
  };

  let html = '<div style="padding:10px 14px 6px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">';
  html += '<div style="font-size:13px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;font-weight:600;"><i class="ph ph-chats-circle"></i> chat with docs</div>';
  html += '<div style="font-size:10px;color:var(--text-dim);">' + total + ' picks · ' + a + 'd · ' + e + 's · ' + c + 'c · ' + s + 'sp</div>';
  html += '<div style="flex:1;"></div>';
  html += togChip('includeSources', 'sources');
  html += togChip('includeNotes', 'editor notes');
  html += togChip('includeHypotheses', 'hypotheses');
  html += '<button class="act-btn" style="font-size:10px;padding:3px 6px;" onclick="summaryChat=[];renderSummarize()" title="clear conversation"><i class="ph ph-eraser"></i> clear chat</button>';
  html += '</div>';

  html += '<div id="summary-transcript" style="flex:1;overflow-y:auto;padding:14px 18px;">';
  html += renderChatTranscript(total);
  html += '</div>';

  // Composer + framing + one-shot digest.
  html += '<div style="border-top:1px solid var(--border);padding:8px 12px;background:var(--surface);">';
  html += '<details style="margin-bottom:6px;"><summary style="font-size:10px;color:var(--text-dim);cursor:pointer;">framing (optional)</summary>';
  html += '<textarea id="summary-framing-input" placeholder="extra instructions just for this conversation. e.g. focus on procurement, keep under 250 words" rows="2" oninput="summaryPicks.framing=this.value" style="width:100%;margin-top:6px;font-family:inherit;font-size:11px;padding:6px;background:var(--bg);border:1px solid var(--border);color:var(--text-bright);border-radius:3px;box-sizing:border-box;">' + escapeAttr(summaryPicks.framing || '') + '</textarea>';
  html += '</details>';

  const disabled = total === 0 ? 'opacity:0.5;cursor:not-allowed;' : '';
  const disabledAttr = total === 0 ? ' disabled' : '';
  html += '<div style="display:flex;gap:6px;align-items:flex-start;">';
  html += '<textarea id="summary-input" placeholder="' + (total === 0 ? 'pick a source first…' : 'ask a question grounded in the picked sources…') + '" rows="2" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();const v=this.value;this.value=\'\';summaryAsk(v);}" style="flex:1;font-family:inherit;font-size:12px;padding:8px;background:var(--bg);border:1px solid var(--border);color:var(--text-bright);border-radius:3px;resize:vertical;' + disabled + '"' + disabledAttr + '></textarea>';
  html += '<div style="display:flex;flex-direction:column;gap:4px;">';
  html += '<button class="act-btn" style="font-size:11px;padding:6px 12px;background:var(--accent);color:#1a1a1a;border-color:var(--accent);font-weight:600;' + disabled + '"' + disabledAttr + ' onclick="const i=document.getElementById(\'summary-input\');const v=i.value;i.value=\'\';summaryAsk(v);"><i class="ph ph-paper-plane-tilt"></i> ask</button>';
  html += '<button class="act-btn" style="font-size:10px;padding:4px 12px;' + disabled + '"' + disabledAttr + ' onclick="generateSummaryFromPicks()" title="one-shot digest from the picked sources"><i class="ph ph-file-text"></i> digest</button>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  return html;
}

function renderChatTranscript(totalPicks) {
  if (!summaryChat.length) {
    if (totalPicks === 0) {
      return '<div style="color:var(--text-dim);font-size:11px;line-height:1.6;">pick one or more sources on the left, then ask a question here or click <em>digest</em> for a one-shot summary.</div>';
    }
    return '<div style="color:var(--text-dim);font-size:11px;line-height:1.6;">ready when you are. ask anything grounded in the ' + totalPicks + ' picked item(s).</div>';
  }
  let html = '';
  summaryChat.forEach((m) => {
    if (m.role === 'user') {
      html += '<div style="margin-bottom:14px;text-align:right;"><div style="display:inline-block;max-width:80%;background:var(--surface);padding:8px 12px;border-radius:8px;font-size:12px;text-align:left;line-height:1.5;white-space:pre-wrap;">' + escapeAttr(m.content) + '</div></div>';
    } else {
      const body = m.pending
        ? '<div style="color:var(--text-dim);font-size:12px;">…</div>'
        : (m.error
            ? '<div style="color:#c06060;font-size:12px;">✗ ' + escapeAttr(m.content) + '</div>'
            : '<div style="font-size:12px;line-height:1.6;color:var(--text);">' + mdToHtml(m.content, { linkNodes: true }) + '</div>');
      html += '<div style="margin-bottom:14px;"><div style="max-width:90%;">' + body;
      if (m.composition && !m.pending && !m.error) {
        const cmp = m.composition;
        const u = m.usage || {};
        html += '<div style="margin-top:8px;padding-top:6px;border-top:1px dashed var(--border);font-size:10px;color:var(--text-dim);display:flex;gap:10px;flex-wrap:wrap;align-items:center;">';
        html += '<span>' + (cmp.entities || 0) + ' sites · ' + (cmp.connections || 0) + ' cons · ' + (cmp.spans || 0) + ' spans · ' + (cmp.sources || 0) + ' sources</span>';
        if (u.input_tokens != null) html += '<span>in ' + u.input_tokens + ' / out ' + (u.output_tokens || 0) + ' tok</span>';
        html += '<div style="flex:1;"></div>';
        html += '<button class="act-btn" style="font-size:9px;padding:2px 6px;" onclick="copyChatTurnMarkdown(' + m.ts + ')"><i class="ph ph-copy"></i> copy</button>';
        html += '</div>';
      }
      html += '</div></div>';
    }
  });
  return html;
}

function copyChatTurnMarkdown(ts) {
  const turn = summaryChat.find((m) => m.ts === ts);
  if (!turn || !turn.content) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(turn.content).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = turn.content;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }
}

// ---- ask / generate (chat-style) ----

// Build the focused-entity set from the current picks.
function summaryFocusedFromPicks() {
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
  return focused;
}

async function summaryAsk(question) {
  question = (question || '').trim();
  if (!question) return;
  const apiKey = getApiKey();
  if (!apiKey) { await showAlert('Set your Anthropic API key first'); return; }

  const focused = summaryFocusedFromPicks();
  if (!focused.size && !summaryPicks.articleIds.size) {
    await showAlert('Pick at least one source, site, span, or connection first.');
    return;
  }

  // Push user turn + pending assistant turn.
  const userTs = Date.now();
  summaryChat.push({ role: 'user', content: question, ts: userTs });
  const assistantTs = userTs + 1;
  const pending = { role: 'assistant', content: '…', ts: assistantTs, pending: true };
  summaryChat.push(pending);
  renderSummarize();

  // Build context (focused subgraph + voices + sources).
  const built = buildSummaryContext(focused);

  // Conversation history (last few user+assistant turns, excluding the pending one).
  const recent = summaryChat.slice(0, -1).slice(-8);
  const convo = recent
    .filter((t) => t.content && !t.pending && !t.error)
    .map((t) => (t.role === 'user' ? 'USER: ' : 'ASSISTANT: ') + t.content)
    .join('\n\n');

  const framing = (summaryPicks.framing || '').trim();
  const userMsg = [
    '=== FOCUSED SUBGRAPH (editor-curated picks) ===',
    built.context,
    '',
    '=== CONVERSATION ===',
    convo,
  ].filter(Boolean).join('\n');

  const baseSystem = getPrompt();
  const systemPrompt = framing
    ? baseSystem + '\n\n---\nEDITORIAL OVERRIDE FOR THIS CONVERSATION\n' + framing + '\n---'
    : baseSystem;

  try {
    const r = await callLLM({
      system: systemPrompt,
      user: userMsg,
      maxTokens: 1200,
      role: 'summary',
    });
    pending.content = r.text;
    pending.pending = false;
    pending.usage = r.usage;
    pending.ms = r.ms;
    pending.model = r.model;
    pending.composition = built.composition;
  } catch (e) {
    pending.content = e.message || String(e);
    pending.pending = false;
    pending.error = true;
  }
  renderSummarize();
}

// One-shot standardized digest from the current picks — appended to the
// chat as an assistant turn. Uses the queue so it's cancellable and
// visible on the process tab.
async function generateSummaryFromPicks() {
  const apiKey = getApiKey();
  if (!apiKey) { await showAlert('Set your Anthropic API key first'); return; }

  const focused = summaryFocusedFromPicks();
  if (!focused.size && !summaryPicks.articleIds.size) {
    await showAlert('Pick at least one source, site, span, or connection first.');
    return;
  }

  const built = buildSummaryContext(focused);
  const framingHeader = buildSummaryFramingHeader(built);
  const baseSystem = getPrompt();
  const framing = (summaryPicks.framing || '').trim();
  const systemPrompt = framing
    ? baseSystem + '\n\n---\nEDITORIAL OVERRIDE FOR THIS DIGEST\nThe instructions below come from the editor for this single summary only. They take priority over the defaults wherever they conflict.\n\n' + framing + '\n---'
    : baseSystem;

  const userTs = Date.now();
  const sizeLabel = focused.size + ' site' + (focused.size === 1 ? '' : 's');
  summaryChat.push({ role: 'user', content: 'Generate digest from picked sources (' + sizeLabel + ').', ts: userTs });
  const assistantTs = userTs + 1;
  const pending = { role: 'assistant', content: '…', ts: assistantTs, pending: true, composition: built.composition };
  summaryChat.push(pending);
  renderSummarize();

  enqueueJob('summary', {
    key: 'summary-' + assistantTs,
    title: 'digest · ' + sizeLabel,
    systemPrompt,
    framingHeader,
    composition: built.composition,
    assistantTs,
  });
}

async function runSummaryJob(job, signal) {
  const t = job.target;
  const turn = summaryChat.find((m) => m.ts === t.assistantTs);
  try {
    const r = await callLLM({
      system: t.systemPrompt,
      user: t.framingHeader,
      maxTokens: 2000,
      role: 'summary',
      signal,
    });
    if (turn) {
      turn.content = r.text;
      turn.pending = false;
      turn.usage = r.usage;
      turn.ms = r.ms;
      turn.model = r.model;
      turn.composition = t.composition;
    }
  } catch (e) {
    if (turn) {
      turn.content = (e && e.name === 'AbortError') ? 'cancelled' : (e.message || String(e));
      turn.pending = false;
      turn.error = true;
    }
    if (e && e.name === 'AbortError') { renderSummarizeMainIfActive(); throw e; }
    renderSummarizeMainIfActive();
    throw e;
  }
  renderSummarizeMainIfActive();
}

// ---- focused-subgraph context builder (unchanged shape) ----

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
  // Whole-article picks contribute their own source line.
  summaryPicks.articleIds.forEach((aid) => {
    const item = (allItems || []).find((it) => summaryArticleKey(it) === aid);
    if (item) addSrc(item.title, item.link);
  });
  const sources = [...srcMap.values()];
  composition.sources = sources.length;
  if (includeSources && sources.length) {
    lines.push('');
    lines.push('SOURCES (' + sources.length + ' distinct):');
    sources.slice(0, 12).forEach((s) => lines.push('  - ' + (s.title || '(untitled)') + (s.url ? ' — ' + s.url : '')));
  }

  // Whole-article body picks: include a slice of the article body.
  if (summaryPicks.articleIds.size) {
    const bodyLines = [];
    summaryPicks.articleIds.forEach((aid) => {
      const item = (allItems || []).find((it) => summaryArticleKey(it) === aid);
      if (!item) return;
      const body = (item.body || item.snippet || '').trim();
      if (!body) return;
      bodyLines.push('=== ARTICLE: ' + (item.title || '(untitled)') + ' ===');
      bodyLines.push(body.slice(0, 4000));
    });
    if (bodyLines.length) {
      lines.push('');
      lines.push('PICKED ARTICLE BODIES:');
      lines.push(bodyLines.join('\n\n'));
    }
  }

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
    lines.push('VOICES (grouped by relation — attribution must travel into the answer):');
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
