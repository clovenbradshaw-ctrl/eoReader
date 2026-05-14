// render.js — markdown, items, library, entity panels, connections, source view.
// Also: source pin/hide/promote helpers (so feed selections become library sources).

// ---- markdown ----
function mdToHtml(md, opts) {
  opts = opts || {};
  const lines = (md || '').split('\n');
  let html = '';
  let inCodeBlock = false;
  let codeBuffer = '';
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        html += '<pre style="background:#1a1a2e;border:1px solid #333;padding:10px;border-radius:3px;font-size:11px;overflow-x:auto;white-space:pre-wrap;">' + escapeAttr(codeBuffer.trim()) + '</pre>';
        codeBuffer = '';
        inCodeBlock = false;
      } else {
        if (inList) { html += inList === 'ol' ? '</ol>' : '</ul>'; inList = false; }
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) { codeBuffer += line + '\n'; continue; }

    if (!line.trim()) {
      if (inList) { html += inList === 'ol' ? '</ol>' : '</ul>'; inList = false; }
      continue;
    }

    if (line.trim() === '***' || line.trim() === '---') {
      if (inList) { html += inList === 'ol' ? '</ol>' : '</ul>'; inList = false; }
      html += '<hr style="border:none;border-top:1px solid #444;margin:12px 0;">';
      continue;
    }

    if (line.trim().startsWith('>')) {
      if (inList) { html += inList === 'ol' ? '</ol>' : '</ul>'; inList = false; }
      let quote = line.trim().slice(1).trim();
      while (i + 1 < lines.length && lines[i + 1].trim() && !lines[i + 1].trim().startsWith('-') && !lines[i + 1].trim().startsWith('```') && !lines[i + 1].trim().startsWith('#')) {
        i++;
        let cont = lines[i].trim();
        if (cont.startsWith('>')) cont = cont.slice(1).trim();
        quote += ' ' + cont;
      }
      quote = inlineFormat(quote, opts);
      html += '<blockquote style="border-left:3px solid #88C070;padding:8px 12px;margin:8px 0;color:#ccc;font-style:italic;">' + quote + '</blockquote>';
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      if (inList) { html += inList === 'ol' ? '</ol>' : '</ul>'; inList = false; }
      const level = headingMatch[1].length;
      const sizes = { 1: '18px', 2: '15px', 3: '13px', 4: '12px' };
      html += '<div style="font-size:' + sizes[level] + ';font-weight:700;color:var(--text-bright);margin:12px 0 6px;font-family:-apple-system,\'Segoe UI\',Helvetica,sans-serif;">' + inlineFormat(headingMatch[2], opts) + '</div>';
      continue;
    }

    if (line.trim().startsWith('- ') || (line.trim().startsWith('* ') && !line.trim().startsWith('**'))) {
      if (!inList || inList === 'ol') { if (inList) html += '</ol>'; html += '<ul style="margin:6px 0;padding-left:20px;">'; inList = true; }
      const content = line.trim().slice(2);
      html += '<li style="margin-bottom:4px;">' + inlineFormat(content, opts) + '</li>';
      continue;
    }

    const numMatch = line.trim().match(/^(\d+)\.\s+(.+)$/);
    if (numMatch) {
      if (!inList) { html += '<ol style="margin:6px 0;padding-left:20px;">'; inList = 'ol'; }
      html += '<li style="margin-bottom:4px;">' + inlineFormat(numMatch[2], opts) + '</li>';
      continue;
    }

    if (inList) { html += inList === 'ol' ? '</ol>' : '</ul>'; inList = false; }
    html += '<p style="margin-bottom:8px;">' + inlineFormat(line, opts) + '</p>';
  }

  if (inList) html += inList === 'ol' ? '</ol>' : '</ul>';
  if (inCodeBlock) html += '<pre style="background:#1a1a2e;border:1px solid #333;padding:10px;border-radius:3px;font-size:11px;">' + escapeAttr(codeBuffer.trim()) + '</pre>';

  return html;
}

function inlineFormat(text, opts) {
  opts = opts || {};
  let s = escapeAttr(text);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // {node} markers inside backticks — when linkNodes is set, look up by display name
  s = s.replace(/`(\{[^`}]+\})`/g, (m, inner) => {
    const display = inner.replace(/^\{|\}$/g, '').trim();
    if (opts.linkNodes) {
      const lower = display.toLowerCase();
      const hit = Object.entries(graph.entities).find(([id, e]) => {
        const names = [e.canonical, ...(e.aliases || [])];
        return names.some(n => n && n.toLowerCase() === lower);
      });
      if (hit) {
        const [id] = hit;
        return '<a href="#" onclick="event.preventDefault();selectEntity(\'' + id + '\');if(currentView!==\'index\')toggleGraph();" style="background:#2a2a3a;padding:1px 4px;border-radius:2px;color:#88C070;font-size:0.95em;text-decoration:none;cursor:pointer;font-family:monospace;">' + escapeAttr(inner) + '</a>';
      }
    }
    return '<code style="background:#2a2a3a;padding:1px 4px;border-radius:2px;color:#88C070;font-size:0.95em;">' + escapeAttr(inner) + '</code>';
  });
  s = s.replace(/`([^`]+)`/g, '<code style="background:#2a2a3a;padding:1px 4px;border-radius:2px;color:#88C070;font-size:0.95em;">$1</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#88C070;">$1</a>');
  s = s.replace(/(🔗\s*)(https?:\/\/\S+)/g, '$1<a href="$2" style="color:#88C070;">$2</a>');
  s = s.replace(/→/g, '<span style="color:#88C070;">→</span>');
  return s;
}

// ---- feed items ----
function renderFilters() { /* handled by left panel */ }

function renderItems() {
  const el = document.getElementById('view-feed');
  if (!el) return;
  el.innerHTML = '';

  allItems.sort((a, b) => (b.date || 0) - (a.date || 0));

  allItems.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.id = 'item-' + idx;
    div.dataset.source = item.source;
    div.dataset.searchtext = (item.title + ' ' + item.snippet + ' ' + item.sourceName).toLowerCase();

    const processed = !!item._processed;

    div.innerHTML = `
      <div class="item-progress" id="progress-${idx}" style="height:2px;background:var(--border);margin-bottom:0;border-radius:1px;overflow:hidden;${processed ? 'display:none;' : ''}">
        <div id="progress-bar-${idx}" style="height:2px;background:var(--accent);width:0%;transition:width 0.3s;"></div>
      </div>
      <div class="item-source">${escapeAttr(item.sourceName)}<span class="item-date">${fmtDate(item.date)}</span>${processed ? ' <span style="color:var(--accent);font-size:9px;"><i class="ph ph-check-circle"></i> indexed</span>' : ''}</div>
      <div class="item-title"><a href="#" onclick="event.preventDefault();openFeedItem(${idx})">${escapeAttr(item.title) || '(untitled)'}</a></div>
      <div class="item-actions">
        <button class="act-btn" data-label="open" onclick="openFeedItem(${idx})"><i class="ph ph-article"></i> open</button>
        <button class="act-btn" data-label="process" onclick="startWalk(${idx})"><i class="ph ph-cpu"></i> process</button>
        <button class="act-btn" data-label="generate" onclick="generateDigest(${idx}, this)"><i class="ph ph-lightning"></i> generate</button>
        <button class="act-btn" data-label="copy url" onclick="copyText(allItems[${idx}].link, this)"><i class="ph ph-link"></i> url</button>
        <button class="expand-btn" onclick="this.closest('.item').classList.toggle('expanded'); this.textContent = this.closest('.item').classList.contains('expanded') ? '▾ collapse' : '▸ preview'">▸ preview</button>
      </div>
      <div class="item-snippet">${item.snippet}</div>
      <div class="claude-output" id="output-${idx}">
        <div style="display:flex;gap:4px;margin-bottom:8px;">
          <button class="graph-tab active" onclick="showOutputTab(${idx},'substack')">substack</button>
          <button class="graph-tab" onclick="showOutputTab(${idx},'linked')"><i class="ph ph-link-simple"></i> linked</button>
          <button class="graph-tab" onclick="showOutputTab(${idx},'json')"><i class="ph ph-brackets-curly"></i> json</button>
        </div>
        <div class="rendered-entry" id="out-substack-${idx}"></div>
        <div id="out-linked-${idx}" style="display:none;"></div>
        <div id="out-json-${idx}" style="display:none;"></div>
        <div class="output-actions">
          <button class="act-btn" data-label="copy entry" onclick="copyOutput(${idx}, this)"><i class="ph ph-clipboard-text"></i> copy</button>
          <button class="act-btn" data-label="regenerate" onclick="generateDigest(${idx}, this)"><i class="ph ph-arrows-clockwise"></i> regenerate</button>
          <button class="act-btn" data-label="download json" onclick="downloadArticleJson(${idx})"><i class="ph ph-download"></i> .json</button>
        </div>
      </div>
    `;
    el.appendChild(div);
  });

  updateStatus();
}

function showOutputTab(idx, tab) {
  ['substack', 'linked', 'json'].forEach(t => {
    const el = document.getElementById('out-' + t + '-' + idx);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  const outputEl = document.getElementById('output-' + idx);
  if (outputEl) {
    outputEl.querySelectorAll('.graph-tab').forEach(btn => {
      btn.classList.toggle('active', btn.textContent.trim().toLowerCase().startsWith(tab.slice(0, 4)));
    });
  }
}

// --- promote a feed item to a saved source on selection ---
function promoteFeedItemToSource(idx) {
  const item = allItems[idx];
  if (!item) return null;
  // already linked?
  let src = sources.find(s => s.id === item._sourceId || (item.link && s.url === item.link));
  if (src) {
    src.lastInteracted = Date.now();
    saveGraph();
    return src;
  }
  const id = 'src-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  src = {
    id,
    title: item.title,
    url: item.link || null,
    sourceName: item.sourceName,
    body: item.body || '',
    date: item.date ? item.date.toISOString() : new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    lastInteracted: Date.now(),
    sitesFound: [],
    processed: !!item._processed,
    pinned: false,
    hidden: false,
    origin: 'feed',
  };
  sources.unshift(src);
  item._sourceId = id;
  saveGraph();
  return src;
}

function touchSource(sourceId) {
  const s = sources.find(x => x.id === sourceId);
  if (s) { s.lastInteracted = Date.now(); saveGraph(); }
}

function pinSource(idx) {
  const s = sources[idx];
  if (!s) return;
  s.pinned = !s.pinned;
  saveGraph();
  renderLibrary();
}

function hideSource(idx) {
  const s = sources[idx];
  if (!s) return;
  s.hidden = true;
  s.pinned = false;
  saveGraph();
  renderLibrary();
}

function unhideSource(idx) {
  const s = sources[idx];
  if (!s) return;
  s.hidden = false;
  saveGraph();
  renderLibrary();
}

let showHidden = false;
function toggleHiddenSources() {
  showHidden = !showHidden;
  renderLibrary();
}

function openFeedItem(idx) {
  const item = allItems[idx];
  if (!item) return;
  const src = promoteFeedItemToSource(idx);
  if (src) {
    const srcIdx = sources.indexOf(src);
    viewSourceInMain(srcIdx);
  } else {
    scrollToItem(idx);
  }
}

// ---- graph rendering ----
function renderGraphPanel() {
  renderEntityList();
  const main = document.getElementById('graph-main-content');

  if (activeGraphTab === 'entities') {
    if (selectedEntity && graph.entities[selectedEntity]) {
      renderEntityDetail(selectedEntity);
    } else {
      main.innerHTML = '<div style="color:var(--text-dim);padding:20px;">select a site to view its hypothesis, definition, and connections</div>';
    }
  } else if (activeGraphTab === 'connections') {
    renderConnectionsView();
  } else if (activeGraphTab === 'walk') {
    renderWalkStep();
  } else if (activeGraphTab === 'log') {
    renderLogView();
  } else if (activeGraphTab === 'scrub') {
    renderScrubber();
  } else if (activeGraphTab === 'dream') {
    renderDreamView();
  } else if (activeGraphTab === 'librarian') {
    renderLibrarianView();
  }

  const walkTab = document.getElementById('tab-walk');
  if (walkTab) {
    walkTab.innerHTML = walk.active && activeGraphTab !== 'walk'
      ? '<i class="ph ph-cpu"></i> process <span style="color:#d4a84d;">●</span>'
      : '<i class="ph ph-cpu"></i> process';
  }
}

function toggleGroupByName(checked) {
  window.groupByNameGroup = !!checked;
  try { localStorage.setItem('eo_groupByNameGroup', checked ? '1' : '0'); } catch (e) {}
  renderEntityList();
}

function groupKeyOf(e, id) {
  return e.nameGroup || id;
}

(function () {
  try {
    if (localStorage.getItem('eo_groupByNameGroup') === '1') window.groupByNameGroup = true;
  } catch (e) {}
})();

function renderEntityList() {
  const el = document.getElementById('graph-entities-list');
  if (!el) return;
  const checkbox = document.getElementById('group-by-name');
  if (checkbox && checkbox.checked !== !!window.groupByNameGroup) checkbox.checked = !!window.groupByNameGroup;
  const searchVal = (document.getElementById('index-search')?.value || '').toLowerCase();
  const sourceFilter = document.getElementById('index-source-filter')?.value || '';

  const sourceSelect = document.getElementById('index-source-filter');
  if (sourceSelect) {
    const allSources = new Set();
    for (const e of Object.values(graph.entities)) {
      (e.sources || []).forEach(s => { if (s.title) allSources.add(s.title); });
    }
    const currentVal = sourceSelect.value;
    const opts = '<option value="">all sources</option>' +
      [...allSources].sort().map(s => '<option value="' + escapeAttr(s) + '"' + (s === currentVal ? ' selected' : '') + '>' + escapeAttr(s.slice(0, 40)) + '</option>').join('');
    sourceSelect.innerHTML = opts;
  }

  // pivot mode — if selected, rank by hop distance + textual similarity
  let ids = Object.keys(graph.entities);

  if (searchVal) {
    ids = ids.filter(id => {
      const e = graph.entities[id];
      return e.canonical.toLowerCase().includes(searchVal) ||
        id.includes(searchVal) ||
        (e.hypothesis || '').toLowerCase().includes(searchVal) ||
        (e.subtype || '').toLowerCase().includes(searchVal) ||
        (e.aliases || []).some(a => a.toLowerCase().includes(searchVal));
    });
  }
  if (sourceFilter) {
    ids = ids.filter(id => {
      const e = graph.entities[id];
      return (e.sources || []).some(s => s.title === sourceFilter);
    });
  }

  if (!ids.length) {
    el.innerHTML = '<div style="color:var(--text-dim);padding:8px;font-size:11px;">' +
      (Object.keys(graph.entities).length ? 'no matches' : 'no sites yet — process an article to begin') + '</div>';
    return;
  }

  // click-to-pivot: when an entity is selected, sort by proximity to it
  if (selectedEntity && graph.entities[selectedEntity] && activeGraphTab === 'entities') {
    const distances = computePivotDistances(selectedEntity, ids);
    ids.sort((a, b) => (distances[a] ?? 999) - (distances[b] ?? 999) || graph.entities[a].canonical.localeCompare(graph.entities[b].canonical));

    let html = '<div style="font-size:9px;color:var(--text-dim);padding:0 6px 4px;margin-bottom:4px;border-bottom:1px solid var(--border);"><i class="ph ph-crosshair"></i> pivot: ' + escapeAttr(graph.entities[selectedEntity].canonical) + '</div>';
    ids.forEach(id => {
      const e = graph.entities[id];
      const sel = id === selectedEntity ? ' selected' : '';
      const conCount = graph.connections.filter(c => c.from === id || c.to === id).length;
      const dist = distances[id];
      const distLabel = dist === 0 ? '·' : dist === 1 ? '1-hop' : dist === Infinity ? '~' : dist + '-hop';
      html += '<div class="ge-item' + sel + '" onclick="selectEntity(\'' + id + '\')">' +
        '<span class="ge-name">' + escapeAttr(e.canonical) + '</span>' +
        '<span class="ge-kind" style="color:#888;"> ' + distLabel + '</span>' +
        (e.subtype ? '<span class="ge-kind">' + e.subtype + '</span>' : '') +
        (conCount ? ' <span class="ge-kind"><i class="ph ph-flow-arrow"></i>' + conCount + '</span>' : '') +
        '</div>';
    });
    el.innerHTML = html;
    return;
  }

  // default: terrain-grouped list
  const terrains = ['Entity','Link','Network','Kind','Field','Void','Atmosphere','Lens','Paradigm'];
  const grouped = {};
  terrains.forEach(t => grouped[t] = []);
  grouped['Other'] = [];
  ids.forEach(id => {
    const t = graph.entities[id].kind || 'Other';
    if (grouped[t]) grouped[t].push(id);
    else grouped['Other'].push(id);
  });

  let html = '';
  terrains.concat(['Other']).forEach(terrain => {
    const group = grouped[terrain];
    if (!group || !group.length) return;
    group.sort((a, b) => graph.entities[a].canonical.localeCompare(graph.entities[b].canonical));

    html += '<div class="lp-label" style="margin-top:8px;cursor:pointer;font-size:9px;" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'\':\'none\'">';
    html += '<i class="ph ph-caret-down" style="font-size:8px;"></i> ' + terrain + ' <span style="color:var(--text-dim);">(' + group.length + ')</span></div>';
    html += '<div>';
    if (window.groupByNameGroup) {
      // bucket by nameGroup (or id when no group); render groups with >1 member as collapsible
      const buckets = {};
      const order = [];
      group.forEach(id => {
        const e = graph.entities[id];
        const k = groupKeyOf(e, id);
        if (!buckets[k]) { buckets[k] = []; order.push(k); }
        buckets[k].push(id);
      });
      order.forEach(k => {
        const members = buckets[k];
        if (members.length === 1) {
          const id = members[0];
          const e = graph.entities[id];
          const sel = id === selectedEntity ? ' selected' : '';
          const conCount = graph.connections.filter(c => c.from === id || c.to === id).length;
          const name = e.displayName && e.displayName !== e.canonical
            ? escapeAttr(e.displayName) + ' <span style="color:var(--text-dim);font-size:9px;">(' + escapeAttr(e.canonical) + ')</span>'
            : escapeAttr(e.canonical);
          html += '<div class="ge-item' + sel + '" onclick="selectEntity(\'' + id + '\')">' +
            '<span class="ge-name">' + name + '</span>' +
            (e.subtype ? '<span class="ge-kind">' + e.subtype + '</span>' : '') +
            (conCount ? ' <span class="ge-kind"><i class="ph ph-flow-arrow"></i>' + conCount + '</span>' : '') +
            '</div>';
        } else {
          const headDisplay = members.map(id => graph.entities[id].displayName).find(Boolean)
            || graph.entities[members[0]].canonical;
          html += '<div class="ge-item" style="cursor:pointer;" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'\':\'none\'">' +
            '<span class="ge-name"><i class="ph ph-caret-right" style="font-size:9px;"></i> ' + escapeAttr(headDisplay) + '</span>' +
            ' <span class="ge-kind">(' + members.length + ')</span>' +
            '</div>';
          html += '<div style="display:none;padding-left:12px;border-left:1px solid var(--border);margin-left:4px;">';
          members.forEach(id => {
            const e = graph.entities[id];
            const sel = id === selectedEntity ? ' selected' : '';
            const conCount = graph.connections.filter(c => c.from === id || c.to === id).length;
            html += '<div class="ge-item' + sel + '" onclick="event.stopPropagation();selectEntity(\'' + id + '\')">' +
              '<span class="ge-name">' + escapeAttr(e.canonical) + '</span>' +
              (e.subtype ? '<span class="ge-kind">' + e.subtype + '</span>' : '') +
              (conCount ? ' <span class="ge-kind"><i class="ph ph-flow-arrow"></i>' + conCount + '</span>' : '') +
              '</div>';
          });
          html += '</div>';
        }
      });
    } else {
      group.forEach(id => {
        const e = graph.entities[id];
        const sel = id === selectedEntity ? ' selected' : '';
        const conCount = graph.connections.filter(c => c.from === id || c.to === id).length;
        const name = e.displayName && e.displayName !== e.canonical
          ? escapeAttr(e.canonical) + ' <span style="color:var(--text-dim);font-size:9px;">[' + escapeAttr(e.displayName) + ']</span>'
          : escapeAttr(e.canonical);
        html += '<div class="ge-item' + sel + '" onclick="selectEntity(\'' + id + '\')">' +
          '<span class="ge-name">' + name + '</span>' +
          (e.subtype ? '<span class="ge-kind">' + e.subtype + '</span>' : '') +
          (conCount ? ' <span class="ge-kind"><i class="ph ph-flow-arrow"></i>' + conCount + '</span>' : '') +
          '</div>';
      });
    }
    html += '</div>';
  });

  el.innerHTML = html;
}

// BFS distance from pivot. Unreachable nodes get +similarity-derived rank
// (lower is closer). When the graph is disconnected we still want to surface
// semantically-near nodes.
function computePivotDistances(pivotId, ids) {
  const dist = { [pivotId]: 0 };
  const adj = {};
  for (const c of graph.connections) {
    (adj[c.from] = adj[c.from] || []).push(c.to);
    (adj[c.to] = adj[c.to] || []).push(c.from);
  }
  let frontier = [pivotId];
  let d = 0;
  while (frontier.length) {
    d++;
    const next = [];
    for (const id of frontier) {
      for (const n of (adj[id] || [])) {
        if (dist[n] == null) { dist[n] = d; next.push(n); }
      }
    }
    frontier = next;
  }
  // for unreachable, rank by lexical similarity of hypothesis+canonical
  const pivotTxt = ((graph.entities[pivotId].hypothesis || '') + ' ' + (graph.entities[pivotId].canonical || '')).toLowerCase();
  const pivotToks = new Set(pivotTxt.split(/\W+/).filter(t => t.length > 3));
  for (const id of ids) {
    if (dist[id] != null) continue;
    const e = graph.entities[id];
    const txt = ((e.hypothesis || '') + ' ' + (e.canonical || '')).toLowerCase();
    const toks = new Set(txt.split(/\W+/).filter(t => t.length > 3));
    let shared = 0;
    for (const t of toks) if (pivotToks.has(t)) shared++;
    // rank further out, ordered by negative shared-tokens
    dist[id] = 100 - shared;
  }
  return dist;
}

function selectEntity(id) {
  selectedEntity = id;
  activeGraphTab = 'entities';
  document.querySelectorAll('.graph-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-entities')?.classList.add('active');
  renderGraphPanel();
}

function renderEntityDetail(id) {
  const e = graph.entities[id];
  if (!e) return;
  const main = document.getElementById('graph-main-content');
  const cons = graph.connections.filter(c => c.from === id || c.to === id);

  let html = '<div class="ge-detail">';

  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">';
  html += '<div><span style="font-size:15px;font-weight:700;color:var(--text-bright);">' + escapeAttr(e.canonical) + '</span>';
  html += ' <span class="eo-kind" style="font-size:11px;">' + e.kind + '</span>';
  if (e.segFrom) html += ' <span style="font-size:9px;color:#d4a84d;"><i class="ph ph-scissors"></i> SEG from ' + escapeAttr(e.segFrom) + '</span>';
  html += '</div>';
  html += '<div style="display:flex;gap:6px;"><button class="act-btn" onclick="exportSite(\'' + id + '\')"><i class="ph ph-export"></i> export</button></div>';
  html += '</div>';

  // role-profile chip (operator distribution)
  const profile = computeRoleProfile(id);
  if (profile.total) {
    html += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:8px;font-size:10px;color:var(--text-dim);"><i class="ph ph-chart-bar"></i> role profile (' + profile.total + ' events):</div>';
    html += '<div style="display:flex;gap:2px;margin-bottom:10px;height:6px;border-radius:2px;overflow:hidden;">';
    const colors = { SIG: '#88C070', DEF: '#d4a84d', CON: '#5588aa', EVA: '#c06060', REC: '#9a55cc', SEG: '#888' };
    for (const op of ['SIG','DEF','CON','EVA','REC','SEG']) {
      const pct = (profile.dist[op] * 100).toFixed(1);
      if (profile.counts[op]) html += '<div title="' + op + ' ' + profile.counts[op] + ' (' + pct + '%)" style="background:' + colors[op] + ';width:' + pct + '%;"></div>';
    }
    html += '</div>';
    html += '<div style="font-size:9px;color:var(--text-dim);margin-bottom:8px;">';
    for (const op of ['SIG','DEF','CON','EVA','REC','SEG']) {
      if (profile.counts[op]) html += '<span style="margin-right:8px;"><span style="color:' + colors[op] + ';">●</span> ' + op + ' ' + profile.counts[op] + '</span>';
    }
    html += '</div>';
  }

  html += '<label><i class="ph ph-brain"></i> hypothesis — what the system thinks this is</label>';
  html += '<textarea rows="4" style="border-color:#d4a84d;" onchange="updateEntity(\'' + id + '\', \'hypothesis\', this.value)">' + escapeAttr(e.hypothesis || '') + '</textarea>';

  html += '<div style="display:flex;gap:8px;margin-top:8px;">';
  html += '<div style="flex:1;"><label>canonical name</label>';
  html += '<input type="text" value="' + escapeAttr(e.canonical) + '" onchange="updateEntity(\'' + id + '\', \'canonical\', this.value)" /></div>';
  html += '<div style="width:100px;"><label>terrain</label>';
  html += '<select onchange="updateEntity(\'' + id + '\', \'kind\', this.value)" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text-bright);font-family:inherit;font-size:12px;padding:6px 4px;border-radius:3px;">';
  ['Void','Entity','Kind','Field','Link','Network','Atmosphere','Lens','Paradigm'].forEach(t => {
    html += '<option' + (e.kind === t ? ' selected' : '') + '>' + t + '</option>';
  });
  html += '</select></div>';
  html += '</div>';
  html += '<label>subtype (free text — evolves through DEF/EVA)</label>';
  html += '<input type="text" value="' + escapeAttr(e.subtype || '') + '" placeholder="e.g. organization, person, contract, policy..." onchange="updateEntity(\'' + id + '\', \'subtype\', this.value)" />';
  html += '<label>aliases</label>';
  html += '<input type="text" value="' + escapeAttr((e.aliases || []).join(', ')) + '" onchange="updateEntityAliases(\'' + id + '\', this.value)" />';

  // rename history
  if (e.renames && e.renames.length) {
    html += '<label><i class="ph ph-pencil"></i> rename history</label>';
    e.renames.slice().reverse().forEach(r => {
      html += '<div style="font-size:10px;color:var(--text-dim);">' + escapeAttr(r.from) + ' → <strong style="color:var(--text-bright);">' + escapeAttr(r.to) + '</strong>';
      if (r.reason) html += ' — <em>' + escapeAttr(r.reason) + '</em>';
      html += '</div>';
    });
  }

  // EVA history
  if (e.evaHistory && e.evaHistory.length) {
    html += '<label><i class="ph ph-warning"></i> evaluation log (' + e.evaHistory.length + ')</label>';
    e.evaHistory.slice().reverse().forEach(ev => {
      const color = ev.verdict === 'contradiction' ? '#c06060' : ev.verdict === 'tension' ? '#d4a84d' : 'var(--accent)';
      html += '<div style="padding:3px 0;border-bottom:1px solid var(--border);font-size:10px;">';
      html += '<span style="color:' + color + ';font-weight:700;">' + escapeAttr(ev.verdict || '') + '</span> ';
      html += '<span style="color:var(--text);">' + escapeAttr(ev.note || '') + '</span>';
      if (ev.span) html += '<div style="font-size:9px;color:var(--text-dim);font-style:italic;">"' + escapeAttr((ev.span.text || '').slice(0, 150)) + '"</div>';
      html += '</div>';
    });
  }

  if (cons.length) {
    html += '<label><i class="ph ph-flow-arrow"></i> connections (' + cons.length + ')</label>';
    cons.forEach((c) => {
      const globalIdx = graph.connections.indexOf(c);
      const other = c.from === id ? c.to : c.from;
      const dir = c.from === id ? '→' : '←';
      const otherName = graph.entities[other] ? graph.entities[other].canonical : other;
      const conf = c.confidence || 'medium';
      const confColor = conf === 'high' ? 'var(--accent)' : conf === 'low' ? '#c06060' : '#d4a84d';
      const fb = c.feedback;
      const prov = c.provenance || 'source-attested';
      const provColor = prov === 'source-attested' ? '#88C070' : prov === 'system-inferred' ? '#9a55cc' : '#5588aa';

      html += '<div style="padding:4px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:flex-start;">';
      html += '<div style="flex:1;">';
      html += '<span style="color:var(--text-bright);">' + dir + '</span> <strong style="color:var(--accent);">' + escapeAttr(c.relation) + '</strong> ';
      html += '<span style="color:var(--text-bright);cursor:pointer;text-decoration:underline;" onclick="selectEntity(\'' + other + '\')">' + escapeAttr(otherName) + '</span>';
      html += ' <span style="font-size:9px;color:' + confColor + ';">' + conf + '</span>';
      html += ' <span style="font-size:9px;color:' + provColor + ';" title="provenance">' + provenanceLabel(prov) + '</span>';
      if (c.evidence) html += '<div style="font-size:10px;color:var(--text-dim);font-style:italic;">' + escapeAttr(c.evidence) + '</div>';
      if (c.span && c.span.text) html += '<div style="font-size:9px;color:var(--text);background:#1a1a2e;padding:2px 5px;border-radius:2px;border-left:2px solid #5588aa;margin-top:2px;font-style:italic;">"' + escapeAttr(c.span.text.slice(0, 150)) + '"</div>';
      if (c.sourceTitle) html += '<div style="font-size:9px;color:var(--text-dim);"><i class="ph ph-newspaper"></i> ' + escapeAttr(c.sourceTitle) + '</div>';
      if (fb) html += '<div style="font-size:9px;color:#c06060;"><i class="ph ph-chat-dots"></i> ' + escapeAttr(fb) + '</div>';
      html += '</div>';
      html += '<div style="display:flex;gap:2px;flex-shrink:0;">';
      html += '<button class="act-btn" style="padding:1px 4px;font-size:10px;" onclick="feedbackConnection(' + globalIdx + ', true)" title="confirm"><i class="ph ph-check"></i></button>';
      html += '<button class="act-btn" style="padding:1px 4px;font-size:10px;" onclick="promptConnectionFeedback(' + globalIdx + ')" title="correct"><i class="ph ph-pencil"></i></button>';
      html += '<button class="act-btn" style="padding:1px 4px;font-size:10px;color:#c06060;" onclick="deleteConnection(' + globalIdx + ')" title="remove"><i class="ph ph-x"></i></button>';
      html += '</div></div>';
    });
  }

  if (e.defHistory && e.defHistory.length > 1) {
    html += '<label><i class="ph ph-clock-counter-clockwise"></i> hypothesis evolution (' + e.defHistory.length + ' revisions)</label>';
    e.defHistory.slice().reverse().forEach(d => {
      html += '<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:10px;">';
      if (d.span) {
        html += '<div style="color:var(--text-dim);font-size:9px;"><i class="ph ph-newspaper"></i> ' + escapeAttr(d.span.sourceTitle || '') + '</div>';
        html += '<div style="color:var(--text);background:#1a1a2e;padding:3px 6px;border-radius:2px;margin:2px 0;border-left:2px solid #5588aa;font-style:italic;">"' + escapeAttr(d.span.text || '') + '"</div>';
      } else if (d.source) {
        html += '<div style="color:var(--text-dim);font-size:9px;"><i class="ph ph-newspaper"></i> ' + escapeAttr(d.source) + '</div>';
      }
      html += '<div style="color:#d4a84d;margin-top:2px;"><i class="ph ph-brain"></i> ' + escapeAttr((d.hypothesis || '').slice(0, 200)) + '</div>';
      html += '</div>';
    });
  }

  if (e.spans && e.spans.length) {
    html += '<label><i class="ph ph-quotes"></i> source spans (' + e.spans.length + ') — the Given</label>';
    e.spans.forEach(sp => {
      html += '<div style="padding:3px 0;border-bottom:1px solid var(--border);font-size:10px;">';
      html += '<div style="color:var(--text);background:#1a1a2e;padding:3px 6px;border-radius:2px;border-left:2px solid #5588aa;font-style:italic;">"' + escapeAttr(sp.text || '') + '"</div>';
      html += '<div style="color:var(--text-dim);font-size:9px;">' + escapeAttr(sp.sourceTitle || '') + (sp.sourceUrl ? ' · <a href="' + escapeAttr(sp.sourceUrl) + '" target="_blank" style="color:var(--accent);">source</a>' : '') + '</div>';
      html += '</div>';
    });
  }

  if (e.sources && e.sources.length) {
    html += '<label><i class="ph ph-newspaper"></i> sources (' + e.sources.length + ')</label>';
    e.sources.forEach(s => {
      html += '<div style="font-size:10px;color:var(--text-dim);margin-bottom:2px;">';
      if (s.url) html += '<a href="' + escapeAttr(s.url) + '" target="_blank" style="color:var(--accent);">' + escapeAttr(s.title || s.url) + '</a>';
      else html += escapeAttr(s.title || '?');
      html += '</div>';
    });
  }

  html += '<label><i class="ph ph-chat-dots"></i> your notes</label>';
  html += '<textarea rows="2" placeholder="corrections, context, or notes about this site..." onchange="updateEntity(\'' + id + '\', \'userNotes\', this.value)">' + escapeAttr(e.userNotes || '') + '</textarea>';

  html += '<div style="margin-top:12px;display:flex;gap:8px;">';
  html += '<button class="act-btn" onclick="exportSite(\'' + id + '\')"><i class="ph ph-export"></i> export dossier</button>';
  html += '<button class="act-btn" onclick="askLibrarianAbout(\'' + id + '\')"><i class="ph ph-chat-circle"></i> ask librarian</button>';
  html += '<button class="act-btn" style="color:#c06060;border-color:#c06060;" onclick="deleteEntity(\'' + id + '\')"><i class="ph ph-trash"></i> delete</button>';
  html += '</div>';

  html += '</div>';
  main.innerHTML = html;
}

function feedbackConnection(idx, confirm) {
  const c = graph.connections[idx];
  if (!c) return;
  c.confidence = confirm ? 'high' : 'low';
  c.feedback = confirm ? 'confirmed by editor' : null;
  c.provenance = 'editor-authored';
  pushEvent({
    op: 'FEEDBACK', from: c.from, to: c.to, relation: c.relation,
    confidence: c.confidence, note: c.feedback, ts: Date.now(), provenance: 'editor-authored',
  });
  saveGraph();
  if (selectedEntity) renderEntityDetail(selectedEntity);
}

async function promptConnectionFeedback(idx) {
  const res = await showPrompt({
    title: 'Connection feedback',
    submitLabel: 'Save',
    fields: [
      { name: 'note', label: 'What\'s wrong with this connection? Your correction', type: 'textarea',
        placeholder: 'Describe the issue or suggest a fix' },
    ],
  });
  if (!res) return;
  const note = res.note || '';
  const c = graph.connections[idx];
  if (c) {
    c.feedback = note;
    c.confidence = 'low';
    c.provenance = 'editor-authored';
    pushEvent({
      op: 'FEEDBACK', from: c.from, to: c.to, relation: c.relation,
      confidence: 'low', note, ts: Date.now(), provenance: 'editor-authored',
    });
    saveGraph();
    if (selectedEntity) renderEntityDetail(selectedEntity);
  }
}

function exportSite(id) {
  const e = graph.entities[id];
  if (!e) return;
  const cons = graph.connections.filter(c => c.from === id || c.to === id);

  const data = {
    id,
    canonical: e.canonical,
    kind: e.kind,
    aliases: e.aliases || [],
    hypothesis: e.hypothesis || null,
    segFrom: e.segFrom || null,
    firstSeen: e.firstSeen || null,
    roleProfile: computeRoleProfile(id),
    sources: e.sources || [],
    connections: cons.map(c => ({
      direction: c.from === id ? 'outgoing' : 'incoming',
      relation: c.relation,
      target: c.from === id ? c.to : c.from,
      targetName: graph.entities[c.from === id ? c.to : c.from]?.canonical || null,
      evidence: c.evidence || null,
      confidence: c.confidence || null,
      provenance: c.provenance || null,
      sourceTitle: c.sourceTitle || null,
      sourceUrl: c.sourceUrl || null,
      feedback: c.feedback || null,
    })),
    hypothesisEvolution: (e.defHistory || []).map(d => ({
      hypothesis: d.hypothesis || d.def || '',
      source: d.source || null,
      timestamp: d.ts || null,
      provenance: d.provenance || null,
    })),
    evaluations: (e.evaHistory || []),
    renames: (e.renames || []),
    userNotes: e.userNotes || null,
  };

  downloadJson(data, id + '.json');
}

function exportAllSites() {
  const data = {
    exportDate: new Date().toISOString(),
    format: 'plaintext-index-v2',
    sites: Object.entries(graph.entities).map(([id, e]) => ({
      id,
      canonical: e.canonical,
      terrain: e.kind,
      subtype: e.subtype || null,
      aliases: e.aliases || [],
      hypothesis: e.hypothesis || null,
      sources: e.sources || [],
      firstSeen: e.firstSeen || null,
      segFrom: e.segFrom || null,
      userNotes: e.userNotes || null,
      roleProfile: computeRoleProfile(id),
      renames: e.renames || [],
      spans: (e.spans || []).map(sp => ({
        text: sp.text, sourceUrl: sp.sourceUrl, sourceTitle: sp.sourceTitle, sentenceIdx: sp.sentenceIdx,
      })),
      hypothesisEvolution: (e.defHistory || []).map(d => ({
        hypothesis: d.hypothesis || d.def || '',
        span: d.span ? { text: d.span.text, sourceUrl: d.span.sourceUrl, sourceTitle: d.span.sourceTitle } : null,
        timestamp: d.ts || null,
        provenance: d.provenance || null,
      })),
      evaHistory: e.evaHistory || [],
    })),
    connections: graph.connections.map(c => ({
      from: c.from, to: c.to, relation: c.relation,
      evidence: c.evidence || null, confidence: c.confidence || null,
      provenance: c.provenance || null,
      span: c.span ? { text: c.span.text, sourceUrl: c.span.sourceUrl, sourceTitle: c.span.sourceTitle } : null,
      sourceTitle: c.sourceTitle || null,
      sourceUrl: c.sourceUrl || null,
      feedback: c.feedback || null,
    })),
    sources: sources,
    eventLog: eventLog,
  };

  downloadJson(data, 'plaintext-index-' + new Date().toISOString().slice(0, 10) + '.json');
}

function updateEntity(id, field, value) {
  const e = graph.entities[id];
  if (!e) return;
  e[field] = value;
  pushEvent({ op: 'EDIT', id, field, value, ts: Date.now(), provenance: 'editor-authored' });
  saveGraph();
  renderEntityList();
}

function updateEntityAliases(id, value) {
  if (!graph.entities[id]) return;
  const aliases = value.split(',').map(s => s.trim()).filter(Boolean);
  graph.entities[id].aliases = aliases;
  pushEvent({ op: 'EDIT', id, field: 'aliases', value: aliases, ts: Date.now(), provenance: 'editor-authored' });
  saveGraph();
}

function deleteEntity(id) {
  pushEvent({ op: 'DELETE', target: 'entity', id, ts: Date.now(), provenance: 'editor-authored' });
  delete graph.entities[id];
  graph.connections = graph.connections.filter(c => c.from !== id && c.to !== id);
  selectedEntity = null;
  saveGraph();
  renderGraphPanel();
}

function renderConnectionsView() {
  const main = document.getElementById('graph-main-content');
  if (!graph.connections.length) {
    main.innerHTML = '<div style="color:var(--text-dim);padding:20px;">no connections yet</div>';
    return;
  }
  const html = graph.connections.map((c, i) => {
    const fromName = graph.entities[c.from] ? graph.entities[c.from].canonical : c.from;
    const toName = graph.entities[c.to] ? graph.entities[c.to].canonical : c.to;
    const prov = c.provenance || 'source-attested';
    const provColor = prov === 'source-attested' ? '#88C070' : prov === 'system-inferred' ? '#9a55cc' : '#5588aa';
    return '<div class="walk-prop">' +
      '<div class="walk-prop-op">CON</div>' +
      '<div class="walk-prop-body">' +
        '<strong>' + escapeAttr(fromName) + '</strong>' +
        ' <span style="color:var(--accent);">' + escapeAttr(c.relation) + '</span> ' +
        '<strong>' + escapeAttr(toName) + '</strong>' +
        ' <span style="font-size:9px;color:' + provColor + ';">' + provenanceLabel(prov) + '</span>' +
        (c.evidence ? '<div style="font-size:10px;color:var(--text-dim);font-style:italic;">' + escapeAttr(c.evidence) + '</div>' : '') +
        (c.sourceTitle ? '<div style="font-size:9px;color:var(--text-dim);">from: ' + escapeAttr(c.sourceTitle) + '</div>' : '') +
      '</div>' +
      '<div class="walk-prop-actions"><button onclick="deleteConnection(' + i + ')"><i class="ph ph-x"></i></button></div>' +
      '</div>';
  }).join('');
  main.innerHTML = html;
}

function deleteConnection(i) {
  const c = graph.connections[i];
  if (c) pushEvent({ op: 'DELETE', target: 'connection', from: c.from, to: c.to, relation: c.relation, ts: Date.now(), provenance: 'editor-authored' });
  graph.connections.splice(i, 1);
  saveGraph();
  renderGraphPanel();
}

// ---- left-panel sources & library ----
function renderSourcesList() {
  const el = document.getElementById('lp-sources');
  if (!el) return;
  let html = '<div class="lp-item' + (activeFilters.size === 0 ? ' active' : '') + '" onclick="filterBySource(null)">' +
    '<i class="ph ph-list" style="color:var(--text-dim);flex-shrink:0;margin-top:2px;"></i>' +
    '<span class="lp-title">all feeds</span></div>';
  html += SOURCES.map(s =>
    '<div class="lp-item' + (activeFilters.has(s.key) ? ' active' : '') + '" onclick="filterBySource(\'' + s.key + '\')">' +
      '<i class="ph ph-rss" style="color:var(--accent);flex-shrink:0;margin-top:2px;"></i>' +
      '<span class="lp-title">' + escapeAttr(s.name) + '</span>' +
    '</div>'
  ).join('');
  el.innerHTML = html;
}

function filterBySource(key) {
  activeFilters.clear();
  if (key) activeFilters.add(key);
  applyFilters();
  renderSourcesList();
}

function renderLibrary() {
  const el = document.getElementById('lp-library');
  const countEl = document.getElementById('library-count');
  if (!el) return;
  const searchVal = (document.getElementById('library-search')?.value || '').toLowerCase();

  // build candidate list: persisted sources + processed feed items not yet in sources
  let items = [];
  sources.forEach((s, i) => {
    items.push({
      title: s.title,
      sourceName: s.sourceName,
      date: s.ingestedAt || s.date,
      lastInteracted: s.lastInteracted || (s.ingestedAt ? new Date(s.ingestedAt).getTime() : 0),
      processed: s.processed,
      pinned: !!s.pinned,
      hidden: !!s.hidden,
      type: 'source',
      idx: i,
      url: s.url,
    });
  });
  allItems.forEach((item, i) => {
    if (!item._processed) return;
    const alreadyInSources = sources.some(s => s.url === item.link || s.title === item.title);
    if (alreadyInSources) return;
    items.push({
      title: item.title,
      sourceName: item.sourceName,
      date: item.date ? item.date.toISOString() : '',
      lastInteracted: item.date ? new Date(item.date).getTime() : 0,
      processed: true,
      pinned: false,
      hidden: false,
      type: 'feed',
      idx: i,
      url: item.link,
    });
  });

  if (showHidden) {
    items = items.filter(it => it.hidden);
  } else {
    items = items.filter(it => !it.hidden);
  }

  // pinned first, then by lastInteracted desc, then by date desc as tiebreaker
  items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if ((b.lastInteracted || 0) !== (a.lastInteracted || 0)) return (b.lastInteracted || 0) - (a.lastInteracted || 0);
    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  if (searchVal) {
    items = items.filter(it => (it.title || '').toLowerCase().includes(searchVal) || (it.sourceName || '').toLowerCase().includes(searchVal));
  }

  if (countEl) countEl.textContent = items.length;

  const hiddenCount = sources.filter(s => s.hidden).length;
  let toolbar = '<div style="display:flex;justify-content:space-between;align-items:center;font-size:9px;color:var(--text-dim);margin:4px 0;">';
  toolbar += '<span>' + (showHidden ? 'hidden' : 'visible') + '</span>';
  toolbar += '<button class="act-btn" style="padding:1px 6px;font-size:9px;" onclick="toggleHiddenSources()">' +
    (showHidden ? '<i class="ph ph-eye"></i> show visible' : '<i class="ph ph-eye-slash"></i> hidden (' + hiddenCount + ')') + '</button>';
  toolbar += '</div>';

  if (!items.length) {
    el.innerHTML = toolbar + '<div style="color:var(--text-dim);font-size:10px;padding:4px;">' + (showHidden ? 'no hidden sources' : 'no content yet') + '</div>';
    return;
  }

  el.innerHTML = toolbar + items.map(it => {
    const badge = it.processed
      ? '<span class="lp-badge" style="background:#88C07022;color:var(--accent);"><i class="ph ph-check"></i></span>'
      : '<span class="lp-badge" style="background:#88888822;color:var(--text-dim);">new</span>';
    const pinIcon = it.pinned
      ? '<span style="color:var(--accent);" title="pinned"><i class="ph ph-push-pin-fill"></i></span>'
      : '';
    const onclick = it.type === 'source'
      ? 'viewSourceInMain(' + it.idx + ')'
      : 'openFeedItem(' + it.idx + ')';
    const actions = it.type === 'source'
      ? '<button class="act-btn" style="padding:1px 4px;font-size:9px;border:none;" onclick="event.stopPropagation();pinSource(' + it.idx + ')" title="' + (it.pinned ? 'unpin' : 'pin') + '"><i class="ph ph-' + (it.pinned ? 'push-pin-fill' : 'push-pin') + '"></i></button>' +
        '<button class="act-btn" style="padding:1px 4px;font-size:9px;border:none;color:var(--text-dim);" onclick="event.stopPropagation();' + (it.hidden ? 'unhideSource' : 'hideSource') + '(' + it.idx + ')" title="' + (it.hidden ? 'unhide' : 'hide') + '"><i class="ph ph-eye' + (it.hidden ? '' : '-slash') + '"></i></button>'
      : '';
    return '<div class="lp-item" onclick="' + onclick + '">' +
      '<div style="flex:1;min-width:0;">' +
        '<div class="lp-title">' + pinIcon + escapeAttr((it.title || '').slice(0, 50)) + '</div>' +
        '<div class="lp-meta">' + escapeAttr(it.sourceName || '') + '</div>' +
      '</div>' +
      actions +
      badge +
    '</div>';
  }).join('');
}

function scrollToItem(idx) {
  const el = document.getElementById('item-' + idx);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function viewSourceInMain(srcIdx) {
  const s = sources[srcIdx];
  if (!s) return;
  s.lastInteracted = Date.now();
  saveGraph();

  if (currentView !== 'feed') toggleGraph();

  const el = document.getElementById('view-feed');
  const itemIdx = allItems.findIndex(it => it._sourceId === s.id || (s.url && it.link === s.url));

  let html = '<div style="padding:16px;">';
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">';
  html += '<div>';
  html += '<div style="font-size:16px;font-weight:700;color:var(--text-bright);font-family:-apple-system,sans-serif;">' + escapeAttr(s.title || '') + '</div>';
  html += '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">' + escapeAttr(s.sourceName || '') + ' · ' + new Date(s.ingestedAt || s.date).toLocaleDateString() + '</div>';
  if (s.url) html += '<div style="font-size:11px;margin-top:2px;"><a href="' + escapeAttr(s.url) + '" target="_blank" style="color:var(--accent);">' + escapeAttr(s.url) + '</a></div>';
  html += '</div>';
  html += '<div style="display:flex;gap:6px;">';
  html += '<button class="act-btn" onclick="pinSource(' + srcIdx + ')"><i class="ph ph-push-pin' + (s.pinned ? '-fill' : '') + '"></i> ' + (s.pinned ? 'unpin' : 'pin') + '</button>';
  html += '<button class="act-btn" onclick="' + (s.hidden ? 'unhideSource' : 'hideSource') + '(' + srcIdx + ')"><i class="ph ph-eye' + (s.hidden ? '' : '-slash') + '"></i> ' + (s.hidden ? 'unhide' : 'hide') + '</button>';
  if (itemIdx >= 0) {
    html += '<button class="act-btn" onclick="startWalk(' + itemIdx + ')"><i class="ph ph-cpu"></i> process</button>';
    if (allItems[itemIdx]._processed) {
      html += '<button class="act-btn" onclick="generateDigest(' + itemIdx + ', this)"><i class="ph ph-lightning"></i> generate</button>';
    }
  }
  html += '<button class="act-btn" onclick="renderItems()"><i class="ph ph-arrow-left"></i> back</button>';
  html += '</div></div>';

  if (s.processed) {
    const linkedSites = Object.entries(graph.entities)
      .filter(([id, e]) => (e.sources || []).some(src => src.url === s.url || src.title === s.title));
    if (linkedSites.length) {
      html += '<div style="margin-bottom:12px;"><div class="lp-label"><i class="ph ph-map-pin"></i> sites found (' + linkedSites.length + ')</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
      linkedSites.forEach(([id, e]) => {
        html += '<span class="eo-entity" data-kind="' + e.kind + '" onclick="selectEntity(\'' + id + '\');toggleGraph();" style="cursor:pointer;">' + escapeAttr(e.canonical) + '<span class="eo-kind">' + (e.subtype || e.kind) + '</span></span>';
      });
      html += '</div></div>';
    }
  } else {
    html += '<div style="color:var(--text-dim);font-size:11px;margin-bottom:12px;"><i class="ph ph-info"></i> not yet processed — click process to index this content</div>';
  }

  if (itemIdx >= 0 && allItems[itemIdx].generatedRaw) {
    html += '<div style="margin-bottom:16px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:3px;">';
    html += '<div class="lp-label"><i class="ph ph-lightning"></i> generated entry</div>';
    html += mdToHtml(allItems[itemIdx].generatedRaw, { linkNodes: true });
    html += '</div>';
  }

  html += '<div class="lp-label" style="margin-top:8px;"><i class="ph ph-article"></i> source content</div>';
  html += '<div style="font-family:-apple-system,sans-serif;font-size:13px;line-height:1.8;color:var(--text);background:var(--surface);padding:16px;border-radius:3px;max-height:60vh;overflow-y:auto;white-space:pre-wrap;">' + escapeAttr(s.body || '(no content)') + '</div>';

  html += '<div style="margin-top:12px;display:flex;gap:8px;">';
  html += '<button class="act-btn" style="color:#c06060;border-color:#c06060;" onclick="deleteSource(' + srcIdx + ')"><i class="ph ph-trash"></i> delete source</button>';
  html += '</div>';

  html += '</div>';
  el.innerHTML = html;
}

async function deleteSource(idx) {
  if (!(await showConfirm('Delete this source?', { okLabel: 'Delete', title: 'Confirm delete' }))) return;
  sources.splice(idx, 1);
  saveGraph();
  renderLibrary();
  renderItems();
}
