// buckets.js — the 9 EO terrains group into 3 buckets. This is an additional
// classification axis; the per-kind colors defined elsewhere stay as they are.
//   Things    = Entity, Kind, Field, Void
//   Relations = Link, Network
//   Frames    = Atmosphere, Lens, Paradigm
(function (root) {
  'use strict';
  var BUCKET_OF = {
    Entity: 'Things', Kind: 'Things', Field: 'Things', Void: 'Things',
    Link: 'Relations', Network: 'Relations',
    Atmosphere: 'Frames', Lens: 'Frames', Paradigm: 'Frames',
  };
  var BUCKET_ORDER = ['Things', 'Relations', 'Frames'];
  var BUCKET_COLORS = { Things: '#6a9a7a', Relations: '#c9a55a', Frames: '#9a7aaa' };
  function bucketOf(kind) { return BUCKET_OF[kind] || 'Things'; }
  function bucketColor(kind) { return BUCKET_COLORS[bucketOf(kind)] || '#9a9a9a'; }
  root.Buckets = {
    BUCKET_OF: BUCKET_OF, BUCKET_ORDER: BUCKET_ORDER, BUCKET_COLORS: BUCKET_COLORS,
    bucketOf: bucketOf, bucketColor: bucketColor,
  };
})(typeof window !== 'undefined' ? window : this);
