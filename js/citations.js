// citations.js — span-level citation links. Every source span can point at
// the exact passage on the source page two ways:
//   1. a browser text-fragment deep link (url#:~:text=...) that scrolls to and
//      highlights the quote — works in Chrome/Edge/Safari;
//   2. a Google search of the quote, as a fallback when the fragment misses.
// Both links are built synchronously from the span text alone — no network —
// so walk extraction is never blocked. The optional source ping (fetchPageText)
// only drives the "verified" badge and runs in parallel with the walk.

function citeNorm(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Percent-encode for a text-fragment directive. encodeURIComponent handles
// most reserved chars, but a literal hyphen is a fragment delimiter and must
// be escaped too.
function citeEncFrag(s) {
  return encodeURIComponent(s).replace(/-/g, '%2D');
}

// Build the `#:~:text=` suffix. Short quotes go in whole; longer ones use the
// textStart,textEnd form so the URL stays short and survives minor page drift.
function makeTextFragment(quote) {
  const q = (quote || '').trim().replace(/\s+/g, ' ');
  if (!q) return '';
  const words = q.split(' ');
  if (words.length <= 10) return '#:~:text=' + citeEncFrag(q);
  const start = words.slice(0, 6).join(' ');
  const end = words.slice(-6).join(' ');
  return '#:~:text=' + citeEncFrag(start) + ',' + citeEncFrag(end);
}

// Returns { fragmentUrl, searchUrl, verified }. verified starts null
// (unknown) — reconcileCitations sets it once the source ping resolves.
function buildCitation(quote, sourceUrl) {
  const q = (quote || '').trim();
  const cite = { fragmentUrl: null, searchUrl: null, verified: null };
  if (!q) return cite;
  cite.searchUrl = 'https://www.google.com/search?q=' + encodeURIComponent('"' + q + '"');
  if (sourceUrl) {
    const base = String(sourceUrl).split('#')[0];
    cite.fragmentUrl = base + makeTextFragment(q);
  }
  return cite;
}

// Fetch the live source page through the n8n proxy and return its visible
// text, normalized. Resolves null on any failure — callers must not depend
// on it. Runs in parallel with the walk; never throws.
async function fetchPageText(url) {
  if (!url) return null;
  try {
    const resp = await fetch(PROXY + encodeURIComponent(url));
    if (!resp.ok) return null;
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.querySelector('article') || doc.querySelector('main') ||
      doc.querySelector('.post-content') || doc.body;
    return citeNorm(el ? el.textContent : '');
  } catch (e) {
    console.warn('citation ping failed:', url, e);
    return null;
  }
}

// Mutate each span's cite.verified in place against fetched page text.
function reconcileCitations(spanMetas, pageText) {
  if (!Array.isArray(spanMetas)) return;
  spanMetas.forEach(sp => {
    if (!sp || !sp.cite) return;
    sp.cite.verified = pageText ? pageText.includes(citeNorm(sp.text)) : false;
  });
}
