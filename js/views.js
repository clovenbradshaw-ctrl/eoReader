// views.js — log view + time scrubber + dream view + librarian view renderers.
// (The actual dream/librarian logic lives in dream.js and librarian.js.)

// ---- log view (persistent, filterable, browsable event log) ----
let logFilter = { op: '', provenance: '', source: '', query: '' };

function renderLogView() {
  const main = document.getElementById('graph-main-content');
  const sidebar = document.getElementById('graph-entities-list');
  if (!main || !sidebar) return;

  sidebar.innerHTML = '<div style="padding:8px;">' +
    '<div class="lp-label" style="margin-top:0;"><i class="ph ph-funnel"></i> filters</div>' +
    '<label style="font-size:10px;color:var(--text-dim);">operator</label>' +
    '<select id="log-filter-op" onchange="logFilter.op=this.value;renderLogView()" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);font-size:11px;padding:4px;border-radius:3px;margin-bottom:6px;">' +
      ['', 'SIG', 'DEF', 'CON', 'EVA', 'REC', 'SEG', 'FEEDBACK', 'EDIT', 'DELETE'].map(op => '<option value="' + op + '"' + (logFilter.op === op ? ' selected' : '') + '>' + (op || 'all') + '</option>').join('') +
    '</select>' +
    '<label style="font-size:10px;color:var(--text-dim);">provenance</label>' +
    '<select id="log-filter-prov" onchange="logFilter.provenance=this.value;renderLogView()" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);font-size:11px;padding:4px;border-radius:3px;margin-bottom:6px;">' +
      ['', 'source-attested', 'system-inferred', 'editor-authored'].map(p => '<option value="' + p + '"' + (logFilter.provenance === p ? ' selected' : '') + '>' + (p || 'all') + '</option>').join('') +
    '</select>' +
    '<label style="font-size:10px;color:var(--text-dim);">search</label>' +
    '<input type="text" id="log-filter-q" value="' + escapeAttr(logFilter.query) + '" placeholder="text or site id..." oninput="logFilter.query=this.value;renderLogView()" style="width:100%;font-size:11px;padding:4px;margin-bottom:6px;" />' +
    '<button class="act-btn" style="width:100%;font-size:10px;" onclick="logFilter={op:\'\',provenance:\'\',source:\'\',query:\'\'};renderLogView()"><i class="ph ph-x-circle"></i> clear</button>' +
    '<div style="margin-top:12px;font-size:9px;color:var(--text-dim);">total events: ' + eventLog.length + '</div>' +
  '</div>';

  // filter
  const q = logFilter.query.toLowerCase();
  const filtered = eventLog.filter(ev => {
    if (logFilter.op && ev.op !== logFilter.op) return false;
    if (logFilter.provenance && (ev.provenance || 'source-attested') !== logFilter.provenance) return false;
    if (q) {
      const hay = JSON.stringify(ev).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    main.innerHTML = '<div style="color:var(--text-dim);padding:20px;">no events match. ' + eventLog.length + ' total.</div>';
    return;
  }

  const colors = { SIG: '#88C070', DEF: '#d4a84d', CON: '#5588aa', EVA: '#c06060', REC: '#9a55cc', SEG: '#cc7788', FEEDBACK: '#7788cc', EDIT: '#888', DELETE: '#c06060' };
  let html = '<div style="padding:8px;">';
  html += '<div style="font-size:10px;color:var(--text-dim);margin-bottom:8px;">showing ' + filtered.length + ' / ' + eventLog.length + ' events. newest first.</div>';
  for (let i = filtered.length - 1; i >= 0 && i >= filtered.length - 500; i--) {
    const ev = filtered[i];
    const c = colors[ev.op] || '#888';
    const prov = ev.provenance || 'source-attested';
    const t = new Date(ev.ts).toLocaleString();
    let desc = '';
    if (ev.op === 'SIG') desc = '<strong>' + escapeAttr(ev.canonical || ev.id) + '</strong> <span style="color:var(--text-dim);">(' + escapeAttr(ev.kind || '') + ')</span> — ' + escapeAttr((ev.hypothesis || '').slice(0, 140));
    else if (ev.op === 'DEF') desc = '<strong>' + escapeAttr(graph.entities[ev.id]?.canonical || ev.id) + '</strong> — ' + escapeAttr((ev.hypothesis || '').slice(0, 140));
    else if (ev.op === 'CON') desc = '<strong>' + escapeAttr(graph.entities[ev.from]?.canonical || ev.from) + '</strong> <span style="color:' + c + ';">' + escapeAttr(ev.relation || '') + '</span> <strong>' + escapeAttr(graph.entities[ev.to]?.canonical || ev.to) + '</strong>';
    else if (ev.op === 'EVA') desc = '<strong>' + escapeAttr(graph.entities[ev.id]?.canonical || ev.id) + '</strong> <span style="color:' + c + ';">' + escapeAttr(ev.verdict || '') + '</span> ' + escapeAttr((ev.note || '').slice(0, 120));
    else if (ev.op === 'REC') desc = '<strong>' + escapeAttr(graph.entities[ev.id]?.canonical || ev.id) + '</strong> → <strong>' + escapeAttr(ev.rename) + '</strong> ' + escapeAttr((ev.reason || '').slice(0, 120));
    else if (ev.op === 'SEG') desc = '<strong>' + escapeAttr(ev.id) + '</strong> → ' + (ev.into || []).map(s => escapeAttr(s.canonical || s.id)).join(', ');
    else if (ev.op === 'FEEDBACK') desc = '<strong>' + escapeAttr(ev.from) + '</strong>–<strong>' + escapeAttr(ev.to) + '</strong> ' + escapeAttr(ev.note || ev.confidence || '');
    else if (ev.op === 'EDIT') desc = '<strong>' + escapeAttr(ev.id) + '</strong>.' + escapeAttr(ev.field) + ' = ' + escapeAttr(JSON.stringify(ev.value).slice(0, 100));
    else if (ev.op === 'DELETE') desc = '<strong>' + escapeAttr(ev.id || ev.from || '') + '</strong> ' + (ev.target === 'connection' ? '→ ' + escapeAttr(ev.to || '') : '');

    html += '<div style="border-bottom:1px solid var(--border);padding:6px 0;font-size:11px;display:flex;gap:8px;">';
    html += '<span style="background:' + c + '22;color:' + c + ';padding:1px 5px;border-radius:2px;font-size:10px;font-weight:700;min-width:32px;text-align:center;">' + ev.op + '</span>';
    html += '<div style="flex:1;min-width:0;">';
    html += '<div>' + desc + '</div>';
    html += '<div style="font-size:9px;color:var(--text-dim);margin-top:2px;">' + t + ' · <span title="provenance">' + provenanceLabel(prov) + '</span>';
    if (ev.span && ev.span.sourceTitle) html += ' · <i class="ph ph-newspaper"></i> ' + escapeAttr(ev.span.sourceTitle);
    if (ev.hash) html += ' · <span style="font-family:monospace;">#' + ev.hash + '</span>';
    html += '</div>';
    if (ev.span && ev.span.text) html += '<div style="margin-top:3px;font-size:10px;color:var(--text);background:#1a1a2e;padding:2px 5px;border-radius:2px;border-left:2px solid #5588aa;font-style:italic;">"' + escapeAttr(ev.span.text.slice(0, 200)) + '"</div>';
    html += '</div></div>';
  }
  if (filtered.length > 500) html += '<div style="color:var(--text-dim);font-size:10px;padding:8px;">(showing newest 500 of ' + filtered.length + ' matching events)</div>';
  html += '</div>';
  main.innerHTML = html;
}

// ---- time scrubber ----
function renderScrubber() {
  const main = document.getElementById('graph-main-content');
  const sidebar = document.getElementById('graph-entities-list');
  if (!main) return;

  if (!eventLog.length) {
    sidebar.innerHTML = '';
    main.innerHTML = '<div style="color:var(--text-dim);padding:20px;">event log empty — process an article to populate the timeline</div>';
    return;
  }

  const minTs = eventLog[0].ts;
  const maxTs = eventLog[eventLog.length - 1].ts;
  if (scrubAt == null) scrubAt = maxTs;
  if (scrubAt < minTs) scrubAt = minTs;
  if (scrubAt > maxTs) scrubAt = maxTs;

  // snapshot at scrubAt
  const snap = foldEvents(eventLog, scrubAt);
  const eventsAt = eventLog.filter(e => e.ts <= scrubAt);
  const recentEvent = eventsAt.length ? eventsAt[eventsAt.length - 1] : null;
  const totalSites = Object.keys(snap.entities).length;
  const totalCons = snap.connections.length;

  // sidebar: snapshot site list (read-only)
  let side = '<div style="padding:8px;">';
  side += '<div class="lp-label" style="margin-top:0;"><i class="ph ph-clock-counter-clockwise"></i> at this moment</div>';
  side += '<div style="font-size:10px;color:var(--text-dim);margin-bottom:8px;">' + totalSites + ' sites · ' + totalCons + ' connections</div>';
  const snapIds = Object.keys(snap.entities).sort((a, b) => snap.entities[a].canonical.localeCompare(snap.entities[b].canonical));
  if (!snapIds.length) {
    side += '<div style="color:var(--text-dim);font-size:11px;">no sites yet at this point</div>';
  } else {
    snapIds.forEach(id => {
      const e = snap.entities[id];
      side += '<div class="ge-item" onclick="selectEntity(\'' + id + '\');graphTab(\'entities\')">' +
        '<span class="ge-name">' + escapeAttr(e.canonical) + '</span> <span class="ge-kind">' + escapeAttr(e.kind || '') + '</span></div>';
    });
  }
  side += '</div>';
  sidebar.innerHTML = side;

  // main: slider + recent events
  let html = '<div style="padding:16px;">';
  html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;display:flex;justify-content:space-between;">';
  html += '<span><i class="ph ph-calendar"></i> ' + new Date(scrubAt).toLocaleString() + '</span>';
  html += '<span>' + eventsAt.length + ' / ' + eventLog.length + ' events</span>';
  html += '</div>';
  html += '<input type="range" min="' + minTs + '" max="' + maxTs + '" value="' + scrubAt + '" step="1" oninput="scrubAt=parseInt(this.value);renderScrubber()" style="width:100%;margin-bottom:12px;" />';
  html += '<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);margin-bottom:16px;">';
  html += '<span>' + new Date(minTs).toLocaleString() + '</span><span>' + new Date(maxTs).toLocaleString() + '</span>';
  html += '</div>';

  html += '<div style="display:flex;gap:6px;margin-bottom:12px;">';
  html += '<button class="act-btn" onclick="scrubAt=' + minTs + ';renderScrubber()"><i class="ph ph-skip-back"></i></button>';
  html += '<button class="act-btn" onclick="scrubPrev()"><i class="ph ph-caret-left"></i></button>';
  html += '<button class="act-btn" onclick="scrubNext()"><i class="ph ph-caret-right"></i></button>';
  html += '<button class="act-btn" onclick="scrubAt=' + maxTs + ';renderScrubber()"><i class="ph ph-skip-forward"></i></button>';
  html += '<button class="act-btn" onclick="scrubAt=null;graphTab(\'entities\')"><i class="ph ph-x"></i> exit scrubber</button>';
  html += '</div>';

  // events around current cursor
  html += '<div class="lp-label"><i class="ph ph-list"></i> events at this moment (newest first)</div>';
  const window = eventsAt.slice(-25).reverse();
  if (!window.length) {
    html += '<div style="color:var(--text-dim);font-size:11px;">no events yet</div>';
  } else {
    const colors = { SIG: '#88C070', DEF: '#d4a84d', CON: '#5588aa', EVA: '#c06060', REC: '#9a55cc', SEG: '#cc7788', FEEDBACK: '#7788cc', EDIT: '#888', DELETE: '#c06060' };
    window.forEach(ev => {
      const c = colors[ev.op] || '#888';
      html += '<div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--border);">';
      html += '<span style="background:' + c + '22;color:' + c + ';padding:1px 5px;border-radius:2px;font-size:9px;font-weight:700;">' + ev.op + '</span> ';
      if (ev.op === 'SIG') html += '<strong>' + escapeAttr(ev.canonical || ev.id) + '</strong>';
      else if (ev.op === 'DEF') html += '<strong>' + escapeAttr(snap.entities[ev.id]?.canonical || ev.id) + '</strong>';
      else if (ev.op === 'CON') html += '<strong>' + escapeAttr(snap.entities[ev.from]?.canonical || ev.from) + '</strong> → <strong>' + escapeAttr(snap.entities[ev.to]?.canonical || ev.to) + '</strong>';
      else html += '<strong>' + escapeAttr(ev.id || ev.from || '') + '</strong>';
      html += '<span style="color:var(--text-dim);font-size:9px;margin-left:6px;">' + new Date(ev.ts).toLocaleTimeString() + '</span>';
      html += '</div>';
    });
  }
  html += '</div>';
  main.innerHTML = html;
}

function scrubPrev() {
  if (!eventLog.length) return;
  const idx = eventLog.findIndex(e => e.ts > (scrubAt || 0));
  const prevIdx = idx === -1 ? eventLog.length - 2 : Math.max(0, idx - 2);
  scrubAt = eventLog[prevIdx].ts;
  renderScrubber();
}
function scrubNext() {
  if (!eventLog.length) return;
  const idx = eventLog.findIndex(e => e.ts > (scrubAt || 0));
  if (idx === -1) return;
  scrubAt = eventLog[idx].ts;
  renderScrubber();
}

// ---- dream view ----
function renderDreamView() {
  const main = document.getElementById('graph-main-content');
  const sidebar = document.getElementById('graph-entities-list');
  if (!main) return;

  sidebar.innerHTML = '<div style="padding:8px;">' +
    '<div class="lp-label" style="margin-top:0;"><i class="ph ph-moon-stars"></i> dream</div>' +
    '<p style="font-size:10px;color:var(--text-dim);line-height:1.5;margin-bottom:8px;">find pairs of sites that are semantically near but graph-distant. surface a structural connection the linear pass missed.</p>' +
    '<button class="act-btn" style="width:100%;font-size:11px;" onclick="runDreamPass()"><i class="ph ph-play"></i> run dream pass</button>' +
    '<div style="margin-top:8px;font-size:10px;color:var(--text-dim);">candidates pending: ' + dreamCandidates.filter(c => c.status === 'pending').length + '</div>' +
  '</div>';

  if (!dreamCandidates.length) {
    main.innerHTML = '<div style="color:var(--text-dim);padding:20px;">no candidates yet. click "run dream pass" to scan the index.</div>';
    return;
  }

  let html = '<div style="padding:16px;">';
  html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:12px;">' + dreamCandidates.length + ' candidates · ' + dreamCandidates.filter(c => c.status === 'novel').length + ' novel · ' + dreamCandidates.filter(c => c.status === 'rejected').length + ' rejected</div>';
  dreamCandidates.slice().reverse().forEach((cand, ri) => {
    const idx = dreamCandidates.length - 1 - ri;
    const fromE = graph.entities[cand.from];
    const toE = graph.entities[cand.to];
    if (!fromE || !toE) return;
    const statusColor = cand.status === 'pending' ? '#d4a84d' : cand.status === 'novel' ? 'var(--accent)' : cand.status === 'accepted' ? 'var(--accent)' : '#c06060';
    html += '<div style="border:1px solid var(--border);border-radius:3px;padding:10px;margin-bottom:10px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
    html += '<div><strong>' + escapeAttr(fromE.canonical) + '</strong> <span style="color:var(--accent);">' + escapeAttr(cand.relation || '?') + '</span> <strong>' + escapeAttr(toE.canonical) + '</strong></div>';
    html += '<span style="font-size:10px;color:' + statusColor + ';">' + escapeAttr(cand.status) + '</span></div>';
    if (cand.evidence) html += '<div style="font-size:11px;color:var(--text-dim);font-style:italic;margin-bottom:6px;">"' + escapeAttr(cand.evidence) + '"</div>';
    if (cand.cites && cand.cites.length) {
      html += '<div style="font-size:10px;color:var(--text-dim);margin-bottom:6px;">';
      cand.cites.forEach(ci => {
        html += '<div><i class="ph ph-newspaper"></i> ' + escapeAttr(ci.sourceTitle || '') + ': <em>"' + escapeAttr((ci.spanText || '').slice(0, 200)) + '"</em></div>';
      });
      html += '</div>';
    }
    html += '<div style="font-size:10px;color:var(--text-dim);margin-bottom:6px;"><i class="ph ph-thermometer-simple"></i> textual similarity ' + (cand.sim ? cand.sim.toFixed(2) : '?') + ' · graph distance ' + (cand.dist === Infinity ? '∞' : cand.dist) + '</div>';
    if (cand.status === 'novel' || cand.status === 'pending') {
      html += '<div style="display:flex;gap:6px;">';
      html += '<button class="act-btn" onclick="acceptDream(' + idx + ')"><i class="ph ph-check"></i> accept as CON</button>';
      html += '<button class="act-btn" style="color:#c06060;border-color:#c06060;" onclick="rejectDream(' + idx + ')"><i class="ph ph-x"></i> reject</button>';
      html += '</div>';
    }
    html += '</div>';
  });
  html += '</div>';
  main.innerHTML = html;
}

// ---- librarian view ----
function renderLibrarianView() {
  const main = document.getElementById('graph-main-content');
  const sidebar = document.getElementById('graph-entities-list');
  if (!main) return;

  sidebar.innerHTML = '<div style="padding:8px;">' +
    '<div class="lp-label" style="margin-top:0;"><i class="ph ph-chat-circle-dots"></i> librarian</div>' +
    '<p style="font-size:10px;color:var(--text-dim);line-height:1.5;">ask questions grounded in the indexed sites and their spans. answers cite site ids and quote source spans.</p>' +
    '<button class="act-btn" style="width:100%;font-size:10px;margin-top:8px;" onclick="librarianChat=[];renderLibrarianView()"><i class="ph ph-trash"></i> clear conversation</button>' +
  '</div>';

  let html = '<div style="padding:16px;display:flex;flex-direction:column;height:calc(100vh - 180px);">';
  html += '<div id="librarian-transcript" style="flex:1;overflow-y:auto;margin-bottom:12px;padding:8px;">';
  if (!librarianChat.length) {
    html += '<div style="color:var(--text-dim);font-size:11px;">ask anything about the index. e.g. "what connects NDP to surveillance?"</div>';
  } else {
    librarianChat.forEach((m) => {
      if (m.role === 'user') {
        html += '<div style="margin-bottom:12px;text-align:right;"><div style="display:inline-block;max-width:80%;background:var(--surface);padding:8px 12px;border-radius:8px;font-size:12px;text-align:left;">' + escapeAttr(m.content) + '</div></div>';
      } else {
        html += '<div style="margin-bottom:12px;"><div style="max-width:90%;font-size:12px;line-height:1.6;color:var(--text);">' + mdToHtml(m.content, { linkNodes: true }) + '</div></div>';
      }
    });
  }
  html += '</div>';
  html += '<div style="display:flex;gap:6px;">';
  html += '<input type="text" id="librarian-input" placeholder="ask the librarian..." style="flex:1;font-family:inherit;font-size:12px;padding:8px;background:var(--surface);border:1px solid var(--border);color:var(--text-bright);border-radius:3px;" onkeydown="if(event.key===\'Enter\'){event.preventDefault();librarianAsk(this.value);this.value=\'\';}" />';
  html += '<button class="act-btn" onclick="const i=document.getElementById(\'librarian-input\');librarianAsk(i.value);i.value=\'\';"><i class="ph ph-paper-plane-tilt"></i> send</button>';
  html += '</div></div>';
  main.innerHTML = html;
}
