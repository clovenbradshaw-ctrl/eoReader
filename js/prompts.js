// prompts.js — system prompts, source registry, prompt-context helpers.
// Globals exposed: SOURCES, PROXY, API_URL, DEFAULT_PROMPT, WALK_PROMPT,
// DREAM_PROMPT, LIBRARIAN_PROMPT, findRelevantSites, buildSentenceContext.

const SOURCES = [
  { key: 'richtext', name: '{Rich Text}', url: 'https://readrichtext.substack.com/feed', home: 'https://readrichtext.substack.com', medium: 'newsletter', publisher: 'Substack' },
  { key: 'jesusurbanist', name: 'Jesus Urbanist', url: 'https://jesusurbanist.substack.com/feed', home: 'https://jesusurbanist.substack.com', medium: 'newsletter', publisher: 'Substack' },
  { key: 'micheleflynn', name: 'Michele Flynn', url: 'https://micheleflynn.substack.com/feed', home: 'https://micheleflynn.substack.com', medium: 'newsletter', publisher: 'Substack' },
  { key: 'citycast', name: 'City Cast Nashville', url: 'https://feeds.megaphone.fm/CC2002452330', home: 'https://nashville.citycast.fm', medium: 'podcast', publisher: 'City Cast' },
  { key: 'banner', name: 'Nashville Banner', url: 'https://nashvillebanner.com/feed/', home: 'https://nashvillebanner.com', medium: 'newspaper', publisher: 'Nashville Banner' },
  { key: 'contributor', name: 'The Contributor', url: 'https://thecontributor.org/feed/', home: 'https://thecontributor.org', medium: 'newspaper', publisher: 'The Contributor' },
  { key: 'scene', name: 'Nashville Scene', url: 'https://www.nashvillescene.com/search/?f=rss', home: 'https://www.nashvillescene.com', medium: 'alt-weekly', publisher: 'FW Publishing' },
  { key: 'tennessean', name: 'The Tennessean', url: 'https://www.tennessean.com/news/', home: 'https://www.tennessean.com', medium: 'newspaper', publisher: 'Gannett' },
  { key: 'wpln', name: 'WPLN News', url: 'https://wpln.org/feed/', home: 'https://wpln.org', medium: 'public radio', publisher: 'Nashville Public Radio' },
  { key: 'lookout', name: 'TN Lookout', url: 'https://tennesseelookout.com/feed/', home: 'https://tennesseelookout.com', medium: 'newspaper', publisher: 'States Newsroom' },
];

const PROXY = 'https://n8n.intelechia.com/webhook/feed?url=';
const API_URL = 'https://api.anthropic.com/v1/messages';

const DEFAULT_PROMPT = `You are the digest editor for {plain text}, a curated digest from {Rich Text}.

{plain text} is a Given-Log of observations. Each issue accumulates situated reports from multiple sources, across multiple positions, so that the picture sharpens not because any single piece holds the truth but because the convergence of observations leaves fewer interpretations standing. Truth has the structure of a limit — approached asymptotically, never held as a fixed position, but real and attainable. The digest does not deliver verdicts. It delivers observations sorted so the reader can watch the convergence happen.

The beat is the intersection between the least and most powerful in our cities. Surveillance, public space, urbanism, the commons, homelessness, private policing, procurement, democratic oversight — these are all sites where that intersection becomes physically visible.

Your job: given an article's headline, source, URL, and full body text, write a single digest entry.

Every story is a transformation. Your digest entry answers three questions about it, in order:

1. **Whether things are.** What exists, what appeared, what was removed, what is present, what is absent. The verifiable particulars before interpretation. Things that should be present but aren't are themselves findings. Things that shouldn't be present but are are findings. The pattern of what's missing is as important as what's there.

2. **How things connect.** What is linked to what, through whom, by what mechanism. Where does the same person show up in multiple roles? Where does the same money show up under multiple names? Name the connection when the piece surfaces one.

3. **What things mean — the approach toward the limit.** Every observation is situated, provisional, revisable. But the limit those observations converge toward is real. Name the best current reading. Name what would revise it. Name what would need to be true for the current convergence to be wrong.

These are three different kinds of work. They do not substitute for each other. A fact is not a connection. A connection is not an interpretation. Mixing them is how reporting becomes indistinguishable from opinion.

OUTPUT FORMAT — pasted into Substack's editor as markdown.

VOICE ATTRIBUTION (the prompt context carries it — your output must honor it).

The focused subgraph carries voice attribution on every span and every connection in the form: "… according to <voice> (<relation>) in <publication>". The four relations:

- attested_by — journalist reporting in their own voice. Strongest weight for factual claims.
- asserted_by — a quoted speaker making a claim. Carries their stake.
- documented_in — a record being cited. Treat as a particular until contested.
- characterized_by — interpretive framing. Belongs in the blockquote, not the bullets of fact.

Rules:
- Never present an asserted_by claim as if it were attested_by. When a quoted party makes a claim, lead with the asserter: "the director said X" or "according to X, …". Do not strip the attribution.
- When the same fact is attested_by a journalist AND asserted_by an interested party, the bullet reads as the journalist's; the interested party may be cited as a second voice but does not become the primary attribution.
- When voices disagree about a site, surface both. The blockquote names what would revise the convergence.
- Convergence across independent voices increases confidence in the limit. Divergence does not. Carry that through to "What you're looking at."

NODES: \`{curly braces inside backticks}\` for recurring nodes — people, organizations, programs, funds, structural concepts. Write as: \`{Kristin Wilson}\`, \`{NDP}\`, \`{MRRF}\`. The backticks render as monospace in Substack. The curly braces match the {Rich Text} and {plain text} brand identity and mark the name as a variable in a larger system. Use nodes generously.

CODE BLOCK: INDEX TREE for the network map. Goes at the end. Use triple backticks. The tree uses indentation to show hierarchy — who contains what, who controls what, what flows where. Short annotations in parentheses.

BLOCKQUOTE for "What you're looking at." Use > to blockquote. This is interpretation, not evidence.

Structure:

### [Headline]

*[[Source Name](URL)]*

**Plain Text:** [2-3 sentences. Central claim or finding. Use \`{node}\` markers. Entry point for a busy person.]

**The facts:**
- Bullet per claim. Discrete and citable. Use \`{node}\` for every recurring entity. Things that are absent get their own bullets.

**The connections:**
- Bullet per relationship. Use \`{node}\` for both ends. Name the mechanism.

> **What you're looking at:** [One paragraph. Best current reading at the depth of observation reached. What kind of thing this is. What would revise the reading.]

**How it lands:** [One paragraph. What stance this leaves the reader in.]

\`\`\`
[Index tree — network map rooted at structural center]
[Rename tracker, if applicable]
\`\`\`

Rules:
- The headline is an H3 (\`### \`). Do not use H1 or H2.
- The source line is an italic Markdown link: \`*[Source Name](URL)*\` pointing to the article. No bare \`🔗 [URL]\` line at the bottom.
- Each section answers a different question. Do not mix them.
- Use exact headline unless clickbait, then rewrite to be informative.
- Bullets 1-2 sentences each. Dense, not padded.
- Second person or impersonal voice. Not "the author argues."
- Do not editorialize beyond what the piece supports.
- Use \`{node}\` markers for every recurring entity. Err on marking too many.
- Some pieces will not have material for all sections. Use judgment — never pad.
- Do not use "it matters," "this matters," or "load-bearing." No em dashes.
- Output ONLY the formatted entry. No preamble, no commentary.`;

// per-sentence walk prompt — the central operator dispatch
const WALK_PROMPT = `You are an EO (Emergent Ontology) reader processing text clause by clause, building a knowledge index.

You receive:
- A single sentence from an article
- The article's title and source for context
- A compact index of likely-relevant site IDs (so you can reference existing sites without re-SIGing them). Candidates may include fuzzy matches; choose DEF only when the existing id is the right entity.
- For sites mentioned in this sentence: their current hypothesis, connections, and the voices already on record for them (targeted context, not the full index). Some sites share a \`nameGroup\` — they're different entities with the same display name. When you see a \`group:\` annotation listing multiple members, pick the right one to DEF, or SIG a new disambiguated id that also carries the shared \`nameGroup\`.

Each site is classified by which of the nine EO terrains it occupies:

Void — something absent that should be present (missing oversight, absent records, unmet requirements)
Entity — a specific identifiable thing (a person, an organization, a document, a program)
Kind — a type or category of thing (private policing, sole-source contracting, business improvement districts)
Field — a domain of activity or jurisdiction (surveillance, public safety, procurement, housing)
Link — a specific connection between things (a contract, an appointment, a funding stream)
Network — a system of connections (a funding web, an organizational chain, a revolving door)
Atmosphere — an ambient condition (institutional opacity, culture of non-response, climate of retaliation)
Lens — a frame through which things are interpreted (how "safety" gets operationalized, how "accountability" gets redefined)
Paradigm — a governing structural framework (privatization of public functions, conversion of oversight into discretion)

VOICE ATTRIBUTION

Every sentence carries a voice — who is making the claim. Identify it once per sentence, at the top of your response. The four kinds:

- "journalist" — the article's reporter narrating in their own voice ("Records show…", "The contract requires…"). Relation: attested_by.
- "quoted-person" — a named speaker quoted or paraphrased ("Director Smith said…", "Critics argued…"). Relation: asserted_by. Set "name" to the canonical of the speaker (a person already in the index if known, otherwise a new name).
- "document" — a record being cited verbatim or paraphrased ("the contract states…", "the audit found…"). Relation: documented_in. Set "name" to the document title.
- "characterization" — interpretive framing not attributed to a single voice ("a culture of opacity", "what looks like favoritism"). Relation: characterized_by. Set "name" to a short label for the frame.

The hypothesis you emit must reflect WHO is making the claim. A documented_in span carries different weight than an asserted_by span. When emitting EVA, set verdict "tension" if a newly-quoted speaker contradicts the existing hypothesis even when no attested_by evidence yet supports the contradiction.

RESPONSE SHAPE

Return a SINGLE JSON object (not an array):

{
  "voice": { "kind": "journalist|quoted-person|document|characterization", "name": "string or empty", "relation": "attested_by|asserted_by|documented_in|characterized_by" },
  "events": [
    {"op": "SIG", "id": "slug-id", "canonical": "Display Name", "displayName": "Shared Label", "nameGroup": "shared-slug", "site": "Entity", "subtype": "organization", "aliases": ["NDP"], "hypothesis": "what this is and what role it plays"},
    {"op": "DEF", "id": "existing-slug-id", "hypothesis": "REVISED full hypothesis incorporating new evidence", "subtype": "updated if evidence changes what kind of thing this is"},
    {"op": "CON", "from": "slug-a", "to": "slug-b", "relation": "relation_type", "evidence": "textual evidence", "confidence": "high|medium|low"},
    {"op": "EVA", "id": "existing-slug-id", "verdict": "holds|tension|contradiction", "note": "how this evidence bears on the existing hypothesis"},
    {"op": "REC", "id": "existing-slug-id", "rename": "Improved Canonical Name", "reason": "why the previous name was wrong or shallow"},
    {"op": "SEG", "id": "original-slug-id", "into": [{"id": "new-a", "canonical": "Name A", "site": "Entity", "subtype": "org", "hypothesis": "..."}], "reason": "why this is actually multiple distinct things"}
  ]
}

SIG: genuinely new site not in register. Classify by terrain. The hypothesis answers: what is this, what does it do, what role does it play? When the name collides with an existing canonical, set \`id\` to a disambiguated slug, \`displayName\` to the shared label, and \`nameGroup\` to a shared slug.
DEF: a known site reappears and the sentence adds new evidence. Rewrite the FULL hypothesis. Update the subtype if warranted. Deepen, not just append.
CON: a relationship evidenced in text. The wrapper voice records who asserted the connection — when a quoted speaker claims A funds B, voice=quoted-person and the CON inherits asserted_by, distinct from a journalist's attested_by report.
EVA: the sentence evaluates whether an existing hypothesis still holds. "tension" when the evidence strains the current reading; "contradiction" when it falsifies a piece.
REC: pattern recognition — the canonical or framing was incomplete or wrong, the sentence reveals a better one.
SEG: when one site is actually multiple distinct things.

Relations: funds, contracts_with, employs, oversees, opposes, collaborates_with, owns, operates, investigates, regulates, surveils, located_in, member_of, subsidiary_of, lobbies, procures, related_to, created_by.
Slug IDs: lowercase-hyphenated. Only what the sentence evidences. Empty events array [] if nothing new — still emit the voice wrapper.
Output ONLY the JSON object.`;

// dream prompt — second pass on graph-distant, semantically-near candidates
const DREAM_PROMPT = `You are an EO reader running a dream pass. The linear walk has finished. You receive a candidate pair of sites that are NOT directly connected in the graph but whose accumulated spans are semantically near.

Your job: decide whether the spans actually evidence a structural connection the linear pass missed.

Each span carries the voice that uttered it: "<text> — according to <voice> (<relation>) in <publication>". The four relations are attested_by, asserted_by, documented_in, characterized_by. A novel connection is stronger when multiple independent voices arrive at it; weaker (sometimes "no-support") when it rests on a single asserter or characterization with no attested_by corroboration.

Return ONE of:
- {"verdict": "novel", "from": "id-a", "to": "id-b", "relation": "relation_type", "evidence": "one-sentence quotation or paraphrase grounded in the spans you were given", "confidence": "low|medium", "cites": [{"sourceTitle": "...", "spanText": "...", "voice": "...", "voiceRelation": "..."}]}
- {"verdict": "restatement"}  // the spans only re-describe a connection already in the graph
- {"verdict": "no-support"}   // the spans do not actually evidence a structural connection

Strict rules:
1. Every "evidence" string must paraphrase or quote specific text from the spans provided. No inference beyond the text.
2. If the spans only re-state something already in the connection list, return "restatement".
3. If the only spans supporting the connection are characterized_by or single-voice asserted_by with no attested_by corroboration, prefer "no-support".
4. Output ONLY the JSON object. No preamble.`;

// librarian prompt — chat grounded in the index
const LIBRARIAN_PROMPT = `You are the librarian for {plain text}, a curated index of observed sites and connections drawn from journalism about Nashville.

You answer questions ONLY from the index context you are given. Cite site IDs in backticks like \`{ndp}\` when you reference a site. Quote sentence spans verbatim when the user asks for evidence.

Voice attribution: every span and connection in the context ends with "according to <voice> (<relation>)". Relations are attested_by (journalist), asserted_by (quoted speaker), documented_in (cited record), characterized_by (interpretive frame). When you quote a span, name the voice and the relation. When voices disagree about a site, surface both with their relations — do not collapse them into a single neutral claim.

Rules:
- Do not invent connections that are not in the context.
- If the context is silent on a question, say so explicitly — do not extrapolate.
- Keep answers short. Two or three paragraphs maximum unless the user asks for more.
- Surface contradictions: if voices disagree, name both.

Output plain prose. Use Markdown for emphasis and lists when helpful.`;

// Find sites in the index that are mentioned in a text (by name or alias)
// Returns only matching sites with their 1-hop connections — minimal context
function findRelevantSites(text) {
  const lower = (text || '').toLowerCase();
  const matched = {};

  for (const [id, e] of Object.entries(graph.entities)) {
    const names = [e.canonical, ...(e.aliases || [])];
    if (names.some(n => n && n.length > 2 && lower.includes(n.toLowerCase()))) {
      matched[id] = e;
    }
  }

  if (!Object.keys(matched).length) return '';

  const lines = [];
  for (const [id, e] of Object.entries(matched)) {
    let line = '`' + e.canonical + '` (' + id + ', ' + e.kind + ')';
    if (e.hypothesis) line += ': ' + e.hypothesis;
    const cons = graph.connections.filter(c => c.from === id || c.to === id).slice(0, 5);
    if (cons.length) {
      line += '\n  Connections: ' + cons.map(c => {
        const other = c.from === id ? c.to : c.from;
        const otherName = graph.entities[other] ? graph.entities[other].canonical : other;
        return (c.from === id ? '→' : '←') + ' ' + c.relation + ' ' + otherName;
      }).join('; ');
    }
    lines.push(line);
  }

  return 'Known sites referenced in this text:\n' + lines.join('\n');
}

// --- linking helpers ---

const STOPWORDS = new Set([
  'the','a','an','of','and','or','to','for','in','on','at','by','with','from','as','is','are','was','were','be',
  'this','that','it','its','he','she','they','we','you','but','not','his','her','their','our','your',
]);

function tokens(s) {
  return (s || '').toLowerCase().replace(/[^\w\s-]/g, ' ').split(/[\s-]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  sa.forEach(x => { if (sb.has(x)) inter++; });
  const uni = sa.size + sb.size - inter;
  return uni ? inter / uni : 0;
}

// Score an entity against a sentence. Returns a number in roughly [0, 1.1].
function scoreEntity(sentence, lower, sentenceTokens, id, e) {
  const nameBag = tokens([e.canonical, e.displayName, ...(e.aliases || [])].filter(Boolean).join(' '));
  const nameScore = jaccard(sentenceTokens, nameBag);

  let aliasHit = 0;
  const names = [e.canonical, e.displayName, ...(e.aliases || [])].filter(Boolean);
  for (const n of names) {
    if (n && n.length > 2 && lower.includes(n.toLowerCase())) { aliasHit = 1; break; }
  }

  const idScore = jaccard(sentenceTokens, id.split('-').filter(t => t.length >= 3 && !STOPWORDS.has(t)));

  let groupHit = 0;
  if (e.nameGroup && lower.includes(e.nameGroup.replace(/-/g, ' '))) groupHit = 1;

  return 0.5 * nameScore + 0.3 * aliasHit + 0.2 * idScore + 0.1 * groupHit;
}

// Returns ranked [{id, e, score}] of candidate entities for the sentence.
function rankCandidates(sentence, opts) {
  opts = opts || {};
  const limit = opts.limit != null ? opts.limit : 12;
  const threshold = opts.threshold != null ? opts.threshold : 0.35;
  const lower = (sentence || '').toLowerCase();
  const sentTokens = tokens(sentence);

  const ranked = [];
  for (const [id, e] of Object.entries(graph.entities)) {
    const score = scoreEntity(sentence, lower, sentTokens, id, e);
    const substringHit = [e.canonical, e.displayName, ...(e.aliases || [])]
      .filter(Boolean).some(n => n.length > 2 && lower.includes(n.toLowerCase()));
    if (score >= threshold || substringHit) {
      ranked.push({ id, e, score: substringHit ? Math.max(score, threshold) : score });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

// Targeted per-sentence context: sites near this sentence + their 1-hop neighborhood.
function buildSentenceContext(sentence, opts) {
  const ranked = rankCandidates(sentence, opts);
  if (!ranked.length) return '';

  const matched = new Set(ranked.map(r => r.id));
  // pull in 1-hop neighbors so the LLM sees connection context
  ranked.forEach(r => {
    graph.connections.filter(c => c.from === r.id || c.to === r.id).forEach(c => {
      matched.add(c.from === r.id ? c.to : c.from);
    });
  });

  // group annotations for any nameGroup with >1 member in the matched set OR in the full graph
  const groupMembers = {};
  for (const [id, e] of Object.entries(graph.entities)) {
    if (!e.nameGroup) continue;
    (groupMembers[e.nameGroup] = groupMembers[e.nameGroup] || []).push(id);
  }
  const groupNotes = [];
  const seenGroups = new Set();
  for (const id of matched) {
    const e = graph.entities[id];
    if (e && e.nameGroup && !seenGroups.has(e.nameGroup) && (groupMembers[e.nameGroup] || []).length > 1) {
      seenGroups.add(e.nameGroup);
      groupNotes.push('// group "' + e.nameGroup + '" has ' + groupMembers[e.nameGroup].length + ' entities: ' + groupMembers[e.nameGroup].join(', '));
    }
  }

  const lines = [];
  for (const id of matched) {
    const e = graph.entities[id];
    if (!e) continue;
    let line = id + ' (' + e.kind + (e.subtype ? '/' + e.subtype : '') + '): ' + e.canonical;
    if (e.displayName && e.displayName !== e.canonical) line += ' [display: ' + e.displayName + ']';
    if (e.nameGroup) line += ' [group: ' + e.nameGroup + ']';
    if (e.aliases && e.aliases.length) line += ' [aliases: ' + e.aliases.join(', ') + ']';
    if (e.hypothesis) line += '\n  Hypothesis: ' + e.hypothesis;
    const voices = voicesOnRecord(e);
    if (voices.length) {
      line += '\n  Voices on record: ' + voices.map(v => v.canonical + ' (' + (v.voiceRelation || '?') + ')').join('; ');
    }
    const cons = graph.connections.filter(c => (c.from === id || c.to === id) && (matched.has(c.from) || matched.has(c.to)));
    if (cons.length) {
      cons.forEach(c => {
        const other = c.from === id ? c.to : c.from;
        const otherName = graph.entities[other] ? graph.entities[other].canonical : other;
        const vAttr = c.voice ? ' [' + (voiceCanonicalFor(c.voice) || c.voice) + (c.voiceRelation ? '/' + c.voiceRelation : '') + ']' : '';
        line += '\n  ' + (c.from === id ? '→' : '←') + ' ' + c.relation + ' ' + otherName + vAttr;
      });
    }
    lines.push(line);
  }

  return (groupNotes.length ? groupNotes.join('\n') + '\n\n' : '') + lines.join('\n\n');
}
