// Anchorage extraction prompt v3.
//
// Replaces the three-axis label output from eoreader v2 with
// (G, F, P, phasepost) per clause, where phasepost = [mode, domain, object].
// The three vocabulary-free questions for phasepost are preserved from v2;
// the (G, F, P) ask is additive and orthogonal. The regression harness
// (extract/regression.js) verifies that Site-face cell distributions match
// v2 within noise on the 19k consensus corpus before downstream phases.

export const PROMPT_VERSION = 'anchorage:extract:v3';

export const SYSTEM_PROMPT = `You are an extractor producing structured observations from arbitrary text. For each clause you receive, produce one JSON object with exactly these fields:

  phasepost  [mode, domain, object]   three short strings (one to three words each)
  G          string                   the gestalt the clause invokes (the entity-of-attention as the speaker holds it; one short noun phrase)
  F          string                   the form: how the clause carries that gestalt (one short verbal-or-relational phrase)
  P          string                   the proposition: what is asserted of the gestalt (one short propositional phrase)

The three questions for phasepost — answer each in your own words. No controlled vocabulary. No fixed list. No category names from any prior schema.

  mode    "What kind of move is this clause making?"
  domain  "What region of life or talk does it belong to?"
  object  "What is the clause primarily about?"

Output: a single JSON object on one line. No prose. No markdown. No reasoning. Required keys: phasepost, G, F, P. Unknown values are still strings — answer with your best short guess; do not output null.`;

export function buildUserPrompt(clause, opts = {}) {
  const ctx = opts.context
    ? '\n\nSurrounding context (for disambiguation only; do not extract from it):\n' + opts.context
    : '';
  return 'Clause:\n' + clause + ctx;
}

const REQUIRED = ['phasepost', 'G', 'F', 'P'];

export function parseExtractResponse(text) {
  const trimmed = (text || '').trim();
  const stripped = trimmed.replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
  let obj;
  try { obj = JSON.parse(stripped); }
  catch (e) { throw new Error('extractor returned non-JSON: ' + e.message); }
  for (const k of REQUIRED) {
    if (obj[k] === undefined) throw new Error('extractor response missing required field: ' + k);
  }
  if (!Array.isArray(obj.phasepost) || obj.phasepost.length !== 3) {
    throw new Error('phasepost must be a length-3 array');
  }
  for (let i = 0; i < 3; i++) {
    if (typeof obj.phasepost[i] !== 'string' || obj.phasepost[i].length === 0) {
      throw new Error('phasepost[' + i + '] must be non-empty string');
    }
  }
  for (const k of ['G', 'F', 'P']) {
    if (typeof obj[k] !== 'string') throw new Error(k + ' must be string');
  }
  return {
    phasepost: obj.phasepost.map(s => s.trim()),
    G: obj.G.trim(),
    F: obj.F.trim(),
    P: obj.P.trim()
  };
}

// Caller wiring point. `client` must implement: async chat({system, user}) -> string.
// Repository-specific clients (browser Transformers.js, node fetch, etc.) plug in here.
export async function extractClause(client, clause, opts = {}) {
  const text = await client.chat({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(clause, opts)
  });
  return parseExtractResponse(text);
}
