// relations.js — the connection-relation vocabulary for CON records.
// A seed list of canonical relations; on editor load this is unioned with
// every relation already present in sites.jsonl so the vocabulary grows with
// the corpus. A genuinely new relation is allowed but should carry a one-line
// definition (stored on the CON record as meta.relDef) to keep the graph
// queryable instead of drifting into synonyms.
(function (root) {
  'use strict';

  var SEED = [
    'co-sponsors', 'cites', 'funds', 'opposes', 'member-of', 'affiliated-with',
    'succeeds', 'references', 'contracts-with', 'employs', 'oversees',
    'collaborates-with', 'owns', 'operates', 'investigates', 'regulates',
    'located-in', 'subsidiary-of', 'lobbies', 'appoints', 'advises',
  ];

  function normalize(rel) {
    return String(rel == null ? '' : rel).toLowerCase().trim().replace(/\s+/g, '-');
  }

  // Union the seed with relations seen in a folded set of connections.
  function buildVocab(connections) {
    var set = {};
    SEED.forEach(function (r) { set[r] = true; });
    (connections || []).forEach(function (c) {
      if (c && c.rel) set[normalize(c.rel)] = true;
    });
    return Object.keys(set).sort();
  }

  function isKnown(rel, vocab) {
    return (vocab || SEED).indexOf(normalize(rel)) >= 0;
  }

  root.Relations = {
    SEED: SEED, normalize: normalize, buildVocab: buildVocab, isKnown: isKnown,
  };
})(typeof window !== 'undefined' ? window : this);
