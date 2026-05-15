// eo-publish.js — EO-notation line builders for the minisite publishing system.
// operator(stance, terrain): DEF = article version, INS = entity ("site"),
// CON = connection, NUL = retraction. Every line is append-only JSONL.
(function (root) {
  'use strict';

  var SITE_FILE = 'sites.jsonl';
  function articleFile(slug) { return 'articles/' + slug + '.jsonl'; }

  function slugify(s) {
    return String(s == null ? '' : s).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // FNV-1a content hash — client-side dedupe of identical appended lines.
  function hash(obj) {
    var str = JSON.stringify(obj), h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function articleEntry(o) {
    var e = {
      op: 'DEF', site: o.site, slug: o.slug, title: o.title,
      stance: o.stance || 'published', terrain: 'Entity',
      author: o.author || 'anon', meta: o.meta || {},
      payload: { sections: o.sections || [], entityRefs: o.entityRefs || [] },
    };
    e.hash = hash(e);
    return e;
  }

  function entityEntry(o) {
    var e = {
      op: 'INS', site: o.site, slug: o.slug, title: o.name,
      stance: 'published', terrain: 'Entity',
      author: o.author || 'anon', meta: {},
      payload: {
        entityType: o.entityType || 'org',
        description: o.description || '',
        articles: o.articles || [],
      },
    };
    e.hash = hash(e);
    return e;
  }

  function connectionSlug(from, to, rel) {
    return from + '__' + to + '__' + slugify(rel);
  }

  function connectionEntry(o) {
    var e = {
      op: 'CON', site: o.site, slug: connectionSlug(o.from, o.to, o.rel),
      title: o.rel, stance: 'published', terrain: 'Link',
      author: o.author || 'anon', meta: {},
      payload: {
        from: o.from, to: o.to, rel: o.rel,
        evidence: o.evidence || '', article: o.article || null,
      },
    };
    e.hash = hash(e);
    return e;
  }

  function retractEntry(o) {
    var e = {
      op: 'NUL', site: o.site, slug: o.slug,
      stance: 'retracted', terrain: 'Void',
      author: o.author || 'anon', meta: { retracts: o.op || null }, payload: {},
    };
    e.hash = hash(e);
    return e;
  }

  root.EO = {
    SITE_FILE: SITE_FILE, articleFile: articleFile, slugify: slugify, hash: hash,
    connectionSlug: connectionSlug, articleEntry: articleEntry, entityEntry: entityEntry,
    connectionEntry: connectionEntry, retractEntry: retractEntry,
  };
})(typeof window !== 'undefined' ? window : this);
