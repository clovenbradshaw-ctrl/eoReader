// fold.js — pure fold over append-only JSONL. Latest line per slug wins;
// NUL retracts. The log is the source of truth; this is the interpreter.
(function (root) {
  'use strict';

  function parseLines(text) {
    var out = [];
    var lines = (text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch (e) { /* skip bad line */ }
    }
    return out;
  }

  // sites.jsonl -> { entities: {id->entity}, connections: [], entryCount }
  function foldSites(text) {
    var lines = parseLines(text);
    var entities = {}, conns = {}, retracted = {};
    for (var i = 0; i < lines.length; i++) {
      var e = lines[i];
      var key = e.site + ':' + e.slug;
      if (e.op === 'NUL') { retracted[key] = true; continue; }
      if (e.op === 'INS') { entities[e.slug] = e; delete retracted[key]; }
      else if (e.op === 'CON') { conns[e.slug] = e; delete retracted[key]; }
    }
    var outEntities = {}, slug;
    for (slug in entities) {
      if (!entities.hasOwnProperty(slug)) continue;
      var en = entities[slug];
      if (retracted[en.site + ':' + slug]) continue;
      outEntities[slug] = {
        id: slug, name: en.title,
        type: (en.payload && en.payload.entityType) || 'org',
        description: (en.payload && en.payload.description) || '',
        articles: (en.payload && en.payload.articles) || [],
      };
    }
    var outConns = [];
    for (slug in conns) {
      if (!conns.hasOwnProperty(slug)) continue;
      var cn = conns[slug];
      if (retracted[cn.site + ':' + slug]) continue;
      var p = cn.payload || {};
      if (!outEntities[p.from] || !outEntities[p.to]) continue;
      outConns.push({
        from: p.from, to: p.to, rel: p.rel,
        evidence: p.evidence || '', article: p.article || null,
      });
    }
    return { entities: outEntities, connections: outConns, entryCount: lines.length };
  }

  // articles/<slug>.jsonl -> latest live DEF, or null if none / retracted.
  function foldArticle(text) {
    var lines = parseLines(text);
    var latest = null, dropped = false;
    for (var i = 0; i < lines.length; i++) {
      var e = lines[i];
      if (e.op === 'NUL') { dropped = true; continue; }
      if (e.op === 'DEF') { latest = e; dropped = false; }
    }
    if (!latest || dropped) return null;
    var pl = latest.payload || {};
    return {
      id: latest.slug, site: latest.site, title: latest.title,
      meta: latest.meta || {}, stance: latest.stance, ts: latest.ts,
      sections: pl.sections || [], entityRefs: pl.entityRefs || [],
      entryCount: lines.length,
    };
  }

  root.Fold = { parseLines: parseLines, foldSites: foldSites, foldArticle: foldArticle };
})(typeof window !== 'undefined' ? window : this);
