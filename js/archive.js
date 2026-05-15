// archive.js — export current summary as a self-contained interactive HTML
// document and upload it to archive.org via the ncsm n8n webhook.
//
// Exposed on window: uploadSummaryToArchive, buildInteractiveSummaryHtml.
// Wired from the button rendered in summary.js renderSummaryOutputHtml().

(function () {
  const WEBHOOK = 'https://n8n.intelechia.com/webhook/archive-upload';
  const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

  // ---- gather subgraph data from current picks --------------------------

  // Recomputes the focused entity set the same way generateSummaryFromPicks
  // (summary.js) does, so the exported doc captures exactly what the LLM saw.
  function collectFocusedEntityIds() {
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

  // Source: an assistant turn from summaryChat (the new "chat with docs"
  // model). Pass in the turn so we can archive any historical answer, not
  // just the most recent one.
  function buildExportData(turn) {
    const focused = collectFocusedEntityIds();

    const entityIds = [...focused].filter((id) => graph.entities[id]);

    const entitiesOut = {};
    entityIds.forEach((id) => {
      const e = graph.entities[id];
      entitiesOut[id] = {
        canonical: e.canonical || id,
        aliases: (e.aliases || []).slice(),
        kind: e.kind || '',
        subtype: e.subtype || '',
        hypothesis: e.hypothesis || '',
        userNotes: e.userNotes || '',
        spans: (e.spans || []).map((sp) => ({
          text: sp.text || '',
          sourceTitle: sp.sourceTitle || '',
          sourceUrl: sp.sourceUrl || '',
          voice: sp.voice || '',
          voiceRelation: sp.voiceRelation || '',
        })),
      };
    });

    const focusedSet = new Set(entityIds);
    const conIdxSet = new Set();
    summaryPicks.connectionIdxs.forEach((s) => conIdxSet.add(parseInt(s, 10)));
    (graph.connections || []).forEach((c, i) => {
      if (focusedSet.has(c.from) && focusedSet.has(c.to)) conIdxSet.add(i);
    });
    const connectionsOut = [...conIdxSet]
      .map((i) => graph.connections[i])
      .filter(Boolean)
      .map((c) => ({
        from: c.from,
        to: c.to,
        relation: c.relation || '',
        confidence: c.confidence || '',
        evidence: c.evidence || '',
        sourceTitle: c.sourceTitle || '',
        sourceUrl: c.sourceUrl || '',
        voice: c.voice || '',
        voiceRelation: c.voiceRelation || '',
      }));

    const srcMap = new Map();
    const addSrc = (title, url) => {
      if (!title && !url) return;
      const key = (url || '') + '|' + (title || '');
      if (!srcMap.has(key)) srcMap.set(key, { title: title || '', url: url || '' });
    };
    entityIds.forEach((id) => {
      (entitiesOut[id].spans || []).forEach((sp) => addSrc(sp.sourceTitle, sp.sourceUrl));
    });
    connectionsOut.forEach((c) => addSrc(c.sourceTitle, c.sourceUrl));
    const sourcesOut = [...srcMap.values()];

    const t = turn || {};
    return {
      summary: {
        md: t.content || '',
        model: t.model || '',
        ms: t.ms || 0,
        usage: t.usage || {},
        composition: t.composition || {},
        ts: t.ts || Date.now(),
        framing: (summaryPicks.framing || '').trim(),
      },
      entities: entitiesOut,
      connections: connectionsOut,
      sources: sourcesOut,
      meta: {
        generator: 'eoReader',
        exportedAt: new Date().toISOString(),
        focused: entityIds,
      },
    };
  }

  // ---- HTML escape helpers (the exported doc must be self-contained, so we
  // inline our own escaping rather than relying on state.js at view time) --

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // JSON embedded inside a <script> needs </script> sequences neutralised.
  function safeJson(obj) {
    return JSON.stringify(obj)
      .replace(/<\//g, '<\\/')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  // ---- build the self-contained HTML ------------------------------------

  function buildInteractiveSummaryHtml(data, meta) {
    const title = meta.title || ('eoReader summary · ' + new Date().toISOString().slice(0, 10));
    const description = meta.description || '';
    const dataJson = safeJson(data);

    const composition = data.summary.composition || {};
    const compLine =
      (composition.entities || 0) + ' sites · ' +
      (composition.connections || 0) + ' connections · ' +
      (composition.spans || 0) + ' spans · ' +
      (composition.sources || 0) + ' sources';

    return [
'<!DOCTYPE html>',
'<html lang="en">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<meta name="generator" content="eoReader">',
'<title>' + esc(title) + '</title>',
'<style>',
':root{--accent:#88C070;--bg:#1a1a1a;--surface:#242424;--border:#333;--text:#ccc;--text-bright:#eee;--text-dim:#888;}',
'*{box-sizing:border-box;margin:0;padding:0;}',
"body{font-family:'SF Mono','Cascadia Code','Consolas',monospace;background:var(--bg);color:var(--text);font-size:13px;line-height:1.6;}",
'.wrap{max-width:900px;margin:0 auto;padding:32px 24px 96px;}',
'header.doc{border-bottom:1px solid var(--border);padding-bottom:14px;margin-bottom:24px;}',
'header.doc h1{font-size:18px;color:var(--accent);font-weight:400;margin-bottom:6px;}',
'header.doc .meta{font-size:11px;color:var(--text-dim);display:flex;gap:14px;flex-wrap:wrap;}',
'main{font-size:13px;line-height:1.7;color:var(--text);}',
'main p{margin-bottom:0.9em;}',
'main h1,main h2,main h3{color:var(--text-bright);margin:1.2em 0 0.5em;font-weight:600;}',
'main h1{font-size:16px;}main h2{font-size:14px;}main h3{font-size:13px;}',
'main ul,main ol{margin:0.5em 0 0.9em 1.6em;}',
'main li{margin-bottom:0.25em;}',
'main code{background:#2a2a3a;padding:1px 4px;border-radius:2px;color:#88C070;font-size:0.95em;}',
'main a.eo-chip{background:#2a2a3a;padding:1px 4px;border-radius:2px;color:#88C070;font-size:0.95em;text-decoration:none;cursor:pointer;font-family:monospace;}',
'main a.eo-chip:hover{background:#3a3a4a;text-decoration:underline;}',
'main a.ext{color:#88C070;}',
'.sources{margin-top:48px;padding-top:16px;border-top:1px solid var(--border);}',
'.sources h2{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);margin-bottom:10px;font-weight:400;}',
'.sources ol{margin-left:1.4em;font-size:11px;line-height:1.6;}',
'.sources li{margin-bottom:4px;color:var(--text-dim);}',
'.sources li a{color:var(--text);}',
'.panel{position:fixed;top:0;right:0;height:100vh;width:420px;max-width:90vw;background:var(--surface);border-left:1px solid var(--border);box-shadow:-8px 0 24px rgba(0,0,0,0.5);transform:translateX(100%);transition:transform 0.18s ease;overflow-y:auto;z-index:100;padding:20px 18px;}',
'.panel.open{transform:translateX(0);}',
'.panel .close{position:absolute;top:10px;right:12px;background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer;font-family:inherit;}',
'.panel .close:hover{color:var(--text-bright);}',
'.panel h3{font-size:15px;color:var(--accent);font-weight:400;margin-bottom:4px;padding-right:24px;}',
'.panel .kind{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);margin-bottom:12px;}',
'.panel section{margin-top:16px;}',
'.panel section h4{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);margin-bottom:6px;font-weight:400;}',
'.panel .span{padding:6px 0;border-bottom:1px solid var(--border);font-size:11px;line-height:1.6;}',
'.panel .span:last-child{border-bottom:none;}',
'.panel .span .text{color:var(--text-bright);}',
'.panel .span .src{display:block;color:var(--text-dim);margin-top:3px;font-size:10px;}',
'.panel .span .src a{color:#88C070;}',
'.panel .con{padding:6px 0;border-bottom:1px solid var(--border);font-size:11px;line-height:1.5;}',
'.panel .con:last-child{border-bottom:none;}',
'.panel .alias{display:inline-block;background:#2a2a3a;color:#aaa;padding:1px 6px;border-radius:8px;font-size:10px;margin:2px 4px 2px 0;}',
'.panel .note{font-size:11px;color:var(--text);padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:3px;white-space:pre-wrap;}',
'.scrim{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:99;opacity:0;pointer-events:none;transition:opacity 0.18s;}',
'.scrim.open{opacity:1;pointer-events:auto;}',
'footer.gen{margin-top:48px;padding-top:14px;border-top:1px solid var(--border);font-size:10px;color:var(--text-dim);text-align:center;}',
'</style>',
'</head>',
'<body>',
'<div class="wrap">',
'<header class="doc">',
'<h1>' + esc(title) + '</h1>',
'<div class="meta">',
'<span>' + esc(compLine) + '</span>',
'<span>generated ' + esc(new Date(data.summary.ts || Date.now()).toISOString().slice(0,16).replace('T',' ')) + ' UTC</span>',
'<span>model ' + esc(data.summary.model || '?') + '</span>',
'</div>',
description ? '<div style="margin-top:8px;font-size:11px;color:var(--text-dim);">' + esc(description) + '</div>' : '',
'</header>',
'<main id="doc-body"></main>',
'<div class="sources" id="doc-sources"></div>',
'<footer class="gen">exported from eoReader · click any <code>{name}</code> to see sources and connections</footer>',
'</div>',
'<div class="scrim" id="scrim"></div>',
'<aside class="panel" id="panel" aria-hidden="true">',
'<button class="close" type="button" aria-label="close">×</button>',
'<div id="panel-body"></div>',
'</aside>',
'<script type="application/json" id="eo-data">' + dataJson + '</script>',
'<script>',
viewerScript(),
'</script>',
'</body>',
'</html>',
''
    ].join('\n');
  }

  // The viewer JS is shipped verbatim inside every exported doc. Keep it
  // dependency-free — no references to window globals from eoReader.
  function viewerScript() {
    return `
(function(){
  var DATA = JSON.parse(document.getElementById('eo-data').textContent);
  var entities = DATA.entities || {};
  var connections = DATA.connections || [];
  var sources = DATA.sources || [];

  // Map lowercased canonical/alias -> entity id, for {name} chip resolution.
  var nameIndex = {};
  Object.keys(entities).forEach(function(id){
    var e = entities[id];
    var names = [e.canonical].concat(e.aliases || []);
    names.forEach(function(n){
      if (!n) return;
      nameIndex[String(n).toLowerCase()] = id;
    });
  });

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Minimal markdown -> HTML. Mirrors the relevant subset of mdToHtml in
  // js/render.js so {entity} chips, headings, lists, links, and emphasis
  // all render the same way they do inside eoReader.
  function mdToHtml(md){
    var lines = String(md || '').split(/\\r?\\n/);
    var out = [];
    var inUl = false, inOl = false, para = [];
    function flushPara(){
      if (para.length){ out.push('<p>' + renderInline(para.join(' ')) + '</p>'); para = []; }
    }
    function closeLists(){
      if (inUl){ out.push('</ul>'); inUl = false; }
      if (inOl){ out.push('</ol>'); inOl = false; }
    }
    for (var i=0;i<lines.length;i++){
      var ln = lines[i];
      if (!ln.trim()){ flushPara(); closeLists(); continue; }
      var h = ln.match(/^(#{1,3})\\s+(.*)$/);
      if (h){
        flushPara(); closeLists();
        out.push('<h' + h[1].length + '>' + renderInline(h[2]) + '</h' + h[1].length + '>');
        continue;
      }
      var li = ln.match(/^[-*]\\s+(.*)$/);
      if (li){
        flushPara();
        if (inOl){ out.push('</ol>'); inOl = false; }
        if (!inUl){ out.push('<ul>'); inUl = true; }
        out.push('<li>' + renderInline(li[1]) + '</li>');
        continue;
      }
      var ol = ln.match(/^\\d+\\.\\s+(.*)$/);
      if (ol){
        flushPara();
        if (inUl){ out.push('</ul>'); inUl = false; }
        if (!inOl){ out.push('<ol>'); inOl = true; }
        out.push('<li>' + renderInline(ol[1]) + '</li>');
        continue;
      }
      closeLists();
      para.push(ln);
    }
    flushPara(); closeLists();
    return out.join('\\n');
  }

  function renderInline(text){
    var s = esc(text);
    s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
    // {name} chips
    s = s.replace(/\`(\\{[^\`}]+\\})\`/g, function(m, inner){
      var name = inner.replace(/^\\{|\\}$/g,'').trim();
      var id = nameIndex[name.toLowerCase()];
      if (id){
        return '<a href="#" class="eo-chip" data-eid="' + esc(id) + '">' + esc(inner) + '</a>';
      }
      return '<code>' + esc(inner) + '</code>';
    });
    s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a class="ext" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(^|[^"=])(https?:\\/\\/[^\\s<]+)/g, '$1<a class="ext" href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    s = s.replace(/→/g, '<span style="color:#88C070;">→</span>');
    return s;
  }

  function renderDoc(){
    document.getElementById('doc-body').innerHTML = mdToHtml(DATA.summary.md);
    var srcEl = document.getElementById('doc-sources');
    if (sources.length){
      var html = '<h2>sources</h2><ol>';
      sources.forEach(function(s){
        var t = s.title || '(untitled)';
        if (s.url){
          html += '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(t) + '</a></li>';
        } else {
          html += '<li>' + esc(t) + '</li>';
        }
      });
      html += '</ol>';
      srcEl.innerHTML = html;
    }
  }

  // Connections grouped by entity id, for the side panel.
  var consByEntity = {};
  connections.forEach(function(c){
    if (c.from){ (consByEntity[c.from] = consByEntity[c.from] || []).push(c); }
    if (c.to && c.to !== c.from){ (consByEntity[c.to] = consByEntity[c.to] || []).push(c); }
  });

  function panelBodyHtml(id){
    var e = entities[id];
    if (!e) return '<div>unknown entity</div>';
    var html = '';
    html += '<h3>' + esc(e.canonical) + '</h3>';
    html += '<div class="kind">' + esc(e.kind || '') + (e.subtype ? ' · ' + esc(e.subtype) : '') + '</div>';

    if (e.aliases && e.aliases.length){
      html += '<section><h4>aliases</h4><div>';
      e.aliases.forEach(function(a){ html += '<span class="alias">' + esc(a) + '</span>'; });
      html += '</div></section>';
    }

    if (e.hypothesis){
      html += '<section><h4>hypothesis</h4><div class="note">' + esc(e.hypothesis) + '</div></section>';
    }

    if (e.userNotes){
      html += '<section><h4>editor notes</h4><div class="note">' + esc(e.userNotes) + '</div></section>';
    }

    var spans = e.spans || [];
    if (spans.length){
      html += '<section><h4>evidence spans (' + spans.length + ')</h4>';
      spans.forEach(function(sp){
        html += '<div class="span"><span class="text">"' + esc(sp.text) + '"</span>';
        var attrib = '';
        if (sp.voice){ attrib += 'according to ' + esc(sp.voice); }
        if (sp.voiceRelation){ attrib += ' (' + esc(sp.voiceRelation) + ')'; }
        if (sp.sourceTitle || sp.sourceUrl){
          attrib += attrib ? ' in ' : 'in ';
          if (sp.sourceUrl){
            attrib += '<a href="' + esc(sp.sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(sp.sourceTitle || sp.sourceUrl) + '</a>';
          } else {
            attrib += esc(sp.sourceTitle);
          }
        }
        if (attrib) html += '<span class="src">' + attrib + '</span>';
        html += '</div>';
      });
      html += '</section>';
    }

    var cons = consByEntity[id] || [];
    if (cons.length){
      html += '<section><h4>connections (' + cons.length + ')</h4>';
      cons.forEach(function(c){
        var fn = entities[c.from] ? entities[c.from].canonical : c.from;
        var tn = entities[c.to] ? entities[c.to].canonical : c.to;
        var dir = c.from === id ? '→' : '←';
        var other = c.from === id ? tn : fn;
        html += '<div class="con">' + esc(dir) + ' <strong>' + esc(c.relation || 'related') + '</strong> ' + esc(other);
        if (c.evidence){ html += '<br><span class="src">"' + esc(c.evidence) + '"</span>'; }
        if (c.sourceTitle || c.sourceUrl){
          var s = c.sourceUrl
            ? '<a href="' + esc(c.sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(c.sourceTitle || c.sourceUrl) + '</a>'
            : esc(c.sourceTitle);
          html += '<br><span class="src">source: ' + s + '</span>';
        }
        html += '</div>';
      });
      html += '</section>';
    }
    return html;
  }

  function openPanel(id){
    document.getElementById('panel-body').innerHTML = panelBodyHtml(id);
    document.getElementById('panel').classList.add('open');
    document.getElementById('panel').setAttribute('aria-hidden','false');
    document.getElementById('scrim').classList.add('open');
  }
  function closePanel(){
    document.getElementById('panel').classList.remove('open');
    document.getElementById('panel').setAttribute('aria-hidden','true');
    document.getElementById('scrim').classList.remove('open');
  }

  document.addEventListener('click', function(e){
    var chip = e.target.closest && e.target.closest('a.eo-chip');
    if (chip){ e.preventDefault(); openPanel(chip.dataset.eid); return; }
    if (e.target.closest && e.target.closest('.panel .close')){ closePanel(); return; }
    if (e.target.id === 'scrim'){ closePanel(); return; }
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') closePanel();
  });

  renderDoc();
})();
`;
  }

  // ---- metadata derivation ----------------------------------------------

  function deriveDefaultTitle(data) {
    const md = (data.summary.md || '').trim();
    if (md) {
      const firstLine = md.split(/\n/, 1)[0].replace(/^#+\s*/, '').trim();
      if (firstLine && firstLine.length <= 120) return firstLine;
      if (firstLine) return firstLine.slice(0, 100) + '…';
    }
    return 'eoReader summary · ' + new Date().toISOString().slice(0, 10);
  }

  function deriveDefaultDescription(data) {
    const c = data.summary.composition || {};
    const parts = [];
    parts.push((c.entities || 0) + ' sites, ' + (c.connections || 0) + ' connections, ' +
               (c.spans || 0) + ' spans, ' + (c.sources || 0) + ' sources.');
    if (data.summary.framing) parts.push('Framing: ' + data.summary.framing);
    const snippet = (data.summary.md || '').replace(/[#*`>]/g, '').trim().slice(0, 240);
    if (snippet) parts.push(snippet);
    parts.push('Exported by eoReader. Click {name} markers in the document to see evidence and sources.');
    return parts.join(' ');
  }

  function deriveDefaultSubject(data) {
    const tags = ['eoReader', 'knowledge graph', 'summary'];
    const canonicals = Object.values(data.entities)
      .map((e) => e.canonical)
      .filter(Boolean)
      .slice(0, 12);
    return tags.concat(canonicals).join(';');
  }

  function filenameStem() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rand = Math.random().toString(36).slice(2, 8);
    return 'eoreader-' + ts + '-' + rand;
  }

  // ---- upload flow ------------------------------------------------------

  // Find an assistant turn in summaryChat. If ts is supplied, look it up;
  // otherwise return the most recent finished assistant turn.
  function findArchivableTurn(ts) {
    if (typeof summaryChat === 'undefined' || !Array.isArray(summaryChat)) return null;
    if (ts != null) {
      return summaryChat.find((m) => m.ts === ts && m.role === 'assistant') || null;
    }
    for (let i = summaryChat.length - 1; i >= 0; i--) {
      const m = summaryChat[i];
      if (m.role === 'assistant' && !m.pending && !m.error && m.content) return m;
    }
    return null;
  }

  async function uploadChatTurnToArchive(ts) {
    return uploadSummaryToArchive(ts);
  }

  async function uploadSummaryToArchive(ts) {
    const turn = findArchivableTurn(ts);
    if (!turn) {
      await showAlert('Generate or pick an assistant answer first.');
      return;
    }

    const data = buildExportData(turn);

    const filled = await showPrompt({
      title: 'upload summary to archive.org',
      submitLabel: 'upload',
      cancelLabel: 'cancel',
      fields: [
        { name: 'title', label: 'title', default: deriveDefaultTitle(data) },
        { name: 'description', label: 'description', type: 'textarea', default: deriveDefaultDescription(data) },
        { name: 'creator', label: 'creator', default: 'eoReader' },
        { name: 'subject', label: 'subjects (semicolon-separated)', default: deriveDefaultSubject(data) },
      ],
    });
    if (!filled) return;

    const meta = {
      title: (filled.title || '').trim() || deriveDefaultTitle(data),
      description: (filled.description || '').trim(),
      creator: (filled.creator || '').trim() || 'eoReader',
      subject: (filled.subject || '').trim() || 'eoReader;knowledge graph;summary',
    };

    const html = buildInteractiveSummaryHtml(data, meta);
    const blob = new Blob([html], { type: 'text/html' });
    const stem = filenameStem();
    const filename = stem + '.html';

    const params = new URLSearchParams({
      filename,
      title: meta.title,
      description: meta.description,
      creator: meta.creator,
      subject: meta.subject,
      collection: 'opensource',
      mediatype: 'texts',
      language: 'eng',
      licenseurl: 'https://creativecommons.org/licenses/by/4.0/',
    });

    const ui = openProgressDialog(meta.title, blob, filename);

    try {
      const result = await postBlobWithProgress(blob, params, ui.onProgress);
      const archiveUrl = (result && result.url)
        || ('https://archive.org/details/' + stem);
      ui.success(archiveUrl);
    } catch (err) {
      ui.failure(err && err.message ? err.message : String(err));
    }
  }

  function postBlobWithProgress(blob, params, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', WEBHOOK + '?' + params.toString());
      xhr.setRequestHeader('Content-Type', blob.type || 'text/html');
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        onProgress(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let parsed = null;
          try { parsed = JSON.parse(xhr.responseText); } catch (_) { parsed = null; }
          resolve(parsed || {});
        } else {
          reject(new Error('upload failed (HTTP ' + xhr.status + ')'));
        }
      };
      xhr.onerror = () => reject(new Error('network error — webhook unreachable'));
      xhr.ontimeout = () => reject(new Error('upload timed out after ' + Math.round(UPLOAD_TIMEOUT_MS/1000) + 's'));
      xhr.send(blob);
    });
  }

  // ---- progress dialog --------------------------------------------------
  // Custom because showAlert/showPrompt close on submit; we need a panel that
  // mutates in place: prepare → uploading X% → archived/failed.

  function openProgressDialog(title, blob, filename) {
    const root = document.getElementById('modal-root') || (() => {
      const r = document.createElement('div'); r.id = 'modal-root'; document.body.appendChild(r); return r;
    })();
    root.hidden = false;
    root.innerHTML = '';

    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:4px;min-width:360px;max-width:520px;width:100%;padding:18px;color:var(--text);font-family:inherit;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,0.5);';

    const head = document.createElement('div');
    head.style.cssText = 'font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:var(--accent);margin-bottom:10px;';
    head.textContent = 'uploading to archive.org';
    panel.appendChild(head);

    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'color:var(--text-bright);font-size:12px;margin-bottom:12px;word-break:break-word;';
    titleEl.textContent = title;
    panel.appendChild(titleEl);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:8px;';
    status.textContent = 'preparing…';
    panel.appendChild(status);

    const bar = document.createElement('div');
    bar.style.cssText = 'height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin-bottom:14px;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;background:var(--accent);width:0%;transition:width 0.2s;';
    bar.appendChild(fill);
    panel.appendChild(bar);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    panel.appendChild(actions);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);

    function close() {
      root.innerHTML = '';
      root.hidden = true;
    }

    function makeBtn(label, primary) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = (primary
        ? 'background:var(--accent);color:#1a1a1a;border:1px solid var(--accent);font-weight:600;'
        : 'background:var(--bg);color:var(--text);border:1px solid var(--border);')
        + 'font-family:inherit;font-size:12px;padding:6px 14px;border-radius:3px;cursor:pointer;';
      return b;
    }

    function downloadFallback() {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return {
      onProgress(loaded, total) {
        const pct = total ? Math.round((loaded / total) * 100) : 0;
        fill.style.width = pct + '%';
        status.textContent = 'uploading ' + pct + '%';
      },
      success(archiveUrl) {
        fill.style.width = '100%';
        status.innerHTML = '✓ archived. archive.org may take a few minutes to finalize the item.';
        status.style.color = 'var(--accent)';
        const linkRow = document.createElement('div');
        linkRow.style.cssText = 'margin:10px 0 14px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:3px;font-size:11px;word-break:break-all;';
        linkRow.innerHTML = '<a href="' + archiveUrl + '" target="_blank" rel="noopener noreferrer" style="color:#88C070;">' + archiveUrl + '</a>';
        panel.insertBefore(linkRow, actions);
        actions.innerHTML = '';
        const copy = makeBtn('copy link', false);
        copy.addEventListener('click', () => {
          navigator.clipboard && navigator.clipboard.writeText(archiveUrl);
        });
        const done = makeBtn('done', true);
        done.addEventListener('click', close);
        actions.appendChild(copy);
        actions.appendChild(done);
      },
      failure(message) {
        fill.style.background = '#c06060';
        status.textContent = '✗ ' + message;
        status.style.color = '#c06060';
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:14px;';
        hint.textContent = 'You can still save the document locally.';
        panel.insertBefore(hint, actions);
        actions.innerHTML = '';
        const dl = makeBtn('download .html', false);
        dl.addEventListener('click', downloadFallback);
        const dismiss = makeBtn('close', true);
        dismiss.addEventListener('click', close);
        actions.appendChild(dl);
        actions.appendChild(dismiss);
      },
    };
  }

  window.uploadSummaryToArchive = uploadSummaryToArchive;
  window.uploadChatTurnToArchive = uploadChatTurnToArchive;
  window.buildInteractiveSummaryHtml = buildInteractiveSummaryHtml;
})();
