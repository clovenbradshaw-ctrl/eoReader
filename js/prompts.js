// ═══════════════════════════════════════════════════════════════
//  System Prompts & Instructions — v3
//
//  Changes from v2:
//    - Content-addressed entity IDs (e_xxxxxxxx@state)
//    - All messages (user + model) are Given-Log entries
//    - New MUTATE prompt for graph operations (fork, merge, correct)
//    - Model is told what it is: an interpreter of a situated graph
//    - Three model calls: READ (user), EXTRACT (background),
//      MUTATE (background, triggered on ambiguity)
// ═══════════════════════════════════════════════════════════════


// ── INTERVALS ────────────────────────────────────────────────

const INTERVALS = {
  ENTITY_HYPOTHESIS:  1,
  GROUP_HYPOTHESIS:   4,
  SECTION_HYPOTHESIS: 12,
  DOCUMENT_HYPOTHESIS: Infinity,
  SESSION_HYPOTHESIS:  Infinity,
  CORPUS_HYPOTHESIS:   5,
};


// ═══════════════════════════════════════════════════════════════
//  Identity: content-addressed hashing
// ═══════════════════════════════════════════════════════════════


/**
 * Mint a permanent entity ID from INS content.
 * Short enough for the model to read and reference.
 */
function mintEntityId(canonical, timestamp) {
  const input = `${canonical.toLowerCase().trim()}::${timestamp}`;
  return 'e_' + sha256(input).slice(0, 8);
}

/**
 * Compute state hash from entity's current graph content.
 * Changes every time any DEF, CON, or hypothesis changes.
 */
function computeStateHash(entityId, graph) {
  const entity = graph.getEntity(entityId);
  const defs = graph.getDefs(entityId)
    .sort((a, b) => a.field.localeCompare(b.field))
    .map(d => `${d.field}=${d.value}`);
  const edges = graph.getEdges(entityId)
    .sort((a, b) => a.to.localeCompare(b.to))
    .map(e => `${e.type}→${e.to}`);
  const input = [
    entityId, entity.terrain, entity.hypothesis || '',
    ...defs, ...edges,
  ].join('|');
  return sha256(input).slice(0, 4);
}

/**
 * Hash a Given-Log entry (user or model message).
 */
function mintGivenId(agent, text, timestamp) {
  const input = `${agent}::${text.slice(0, 100)}::${timestamp}`;
  return 'g_' + sha256(input).slice(0, 8);
}

// sha256 implementation assumed available (SubtleCrypto or import)


// ═══════════════════════════════════════════════════════════════
//  Given-Log: every message is a graph event
// ═══════════════════════════════════════════════════════════════


/**
 * Log a user message to the Given-Log.
 * User messages are phenomena: raw observations, never edited.
 */
function logUserMessage(text, signal, sessionId, turnNumber) {
  return {
    id: mintGivenId('user', text, Date.now()),
    type: 'eo.given',
    agent: 'user',
    mode: 'conversation',
    text: text,
    ner: signal?.ner || null,
    session: sessionId,
    turn: turnNumber,
    timestamp: Date.now(),
  };
}

/**
 * Log a model response to the Given-Log.
 * Model responses are also phenomena (they happened).
 * Their interpretive CONTENT goes to the Meant-Graph via Extract.
 * The response TEXT stays in the Given-Log as a record of what was said.
 *
 * `spans` is the mechanically-collected provenance: the verbatim source
 * spans underneath every hypothesis/DEF the dossier carried into this
 * response. The dossier shows the model hypotheses; `spans` lets us
 * trace each one back to the exact words it was distilled from.
 */
function logModelResponse(text, model, dossierHash, sessionId, turnNumber, spans) {
  return {
    id: mintGivenId('model', text, Date.now()),
    type: 'eo.given',
    agent: `model:${model}`,
    mode: 'response',
    text: text,
    dossierHash: dossierHash, // which projection produced this response
    spans: spans || [],       // verbatim source spans behind the dossier
    session: sessionId,
    turn: turnNumber,
    timestamp: Date.now(),
  };
}

/**
 * Log a document passage to the Given-Log.
 */
function logPassage(text, documentId, passageIndex, source) {
  return {
    id: mintGivenId('document', text, Date.now()),
    type: 'eo.given',
    agent: 'system:walker',
    mode: 'document',
    text: text,
    source: source, // { title, url, span: [charStart, charEnd] }
    documentId: documentId,
    passageIndex: passageIndex,
    timestamp: Date.now(),
  };
}


// ═══════════════════════════════════════════════════════════════
//  Prompts: READ (user-facing)
// ═══════════════════════════════════════════════════════════════


const READ_SYSTEM = `You are an interpreter reading a situated knowledge graph.
Entity IDs are content hashes (e_xxxxxxxx). State versions (@xxxx) track changes.
Your responses and the user's messages are both recorded in the graph.

Answer using ONLY the [CTX] block. Say "I don't have that" if insufficient.
Do NOT use outside knowledge.

If an entity reference is ambiguous — a name that could refer to more than one
thing in the graph — say so plainly. Example: "This 'Hardy' may not be the same
as e_3a7f21b4 (Tom Hardy the actor)." The system will handle the resolution.

Reading [CTX]:
  E: hash@state | terrain | edges
  ~: canonical name, aka aliases
  h: current hypothesis
  →←: connection (type) target_hash
  =: field = value
  @: "verbatim source span"
  ⚠: unresolved conflict

Reading [POS]:
  prev: entity hashes from last turn
  topic: what we were discussing
  last: user's previous message`;


const READ_CASUAL = `You are a helpful assistant. Be concise and natural.
Your messages are recorded in a knowledge graph.`;


// ═══════════════════════════════════════════════════════════════
//  Prompts: EXTRACT (background, after READ)
// ═══════════════════════════════════════════════════════════════


const EXTRACT_SYSTEM = `Extract new knowledge from this exchange as a JSON array.
Both the user's message and the model's response are Given-Log entries (IDs provided).
Return [] if nothing new. ONLY valid JSON, no markdown.

Event types:
{"op":"INS","entity":"<canonical>","terrain":"<T>"}
{"op":"CON","from":"<hash>","to":"<hash>","type":"<verb>"}
{"op":"DEF","entity":"<hash>","field":"<attr>","value":"<val>","source":"<given_id>"}
{"op":"EVA","entity":"<hash>","claim":"<field=value>","status":"holds|fails|contested","source":"<given_id>"}

Rules:
- Reference existing entities by their hash (from the register).
- For NEW entities, use "entity" with the canonical name. The system assigns the hash.
- INS creates identity + terrain only. Attributes go in DEF.
- "source" on DEF/EVA = the Given-Log ID of the message that produced this knowledge.
- Skip greetings, filler, restatements of existing context.
- Entity names: lowercase-hyphenated for new canonical names.

Terrains: Entity, Network, Paradigm, Void, Kind, Field, Link, Atmosphere, Lens`;


// ═══════════════════════════════════════════════════════════════
//  Prompts: MUTATE (background, triggered on ambiguity)
//
//  Fires when:
//    - NER finds a name partially matching an entity but context differs
//    - Model response flags ambiguity ("may not be the same as...")
//    - User says "that's not the same X" or "those are the same"
//    - Audit finds DEF conflicts suggesting entity collision
// ═══════════════════════════════════════════════════════════════


const MUTATE_SYSTEM = `You are resolving a graph ambiguity. Examine the evidence and
produce exactly ONE action as JSON. ONLY valid JSON, no markdown.

Actions:

FORK — one entity is actually two:
{"action":"FORK","source":"<hash>","new_canonical":"<name>","reason":"<why>",
 "reassign":[{"def_id":"<id>","reason":"<why this DEF belongs to the new entity>"}]}

MERGE — two entities are actually one:
{"action":"MERGE","keep":"<hash>","absorb":"<hash>","reason":"<why>",
 "new_aliases":["<alias1>"]}

CORRECT — a DEF is wrong:
{"action":"CORRECT","entity":"<hash>","field":"<field>",
 "old_value":"<wrong>","new_value":"<right>","reason":"<why>","source":"<given_id>"}

RECLASSIFY — terrain assignment is wrong:
{"action":"RECLASSIFY","entity":"<hash>","old_terrain":"<T>","new_terrain":"<T>","reason":"<why>"}

NONE — no action needed:
{"action":"NONE","reason":"<why the ambiguity is not real>"}

Always include "reason". The action is logged and must be auditable.`;


// ═══════════════════════════════════════════════════════════════
//  Prompts: INGEST (document walk, per passage)
// ═══════════════════════════════════════════════════════════════


const INGEST_SYSTEM = `Extract entities and claims from this passage as a JSON array.
Return [] if nothing extractable. ONLY valid JSON, no markdown.

Entity hashes from the register are e_xxxxxxxx. Reference them for known entities.
For NEW entities use canonical name; the system assigns the hash.

Event types:
{"op":"INS","entity":"<canonical>","terrain":"<T>"}
{"op":"CON","from":"<hash_or_name>","to":"<hash_or_name>","type":"<verb>"}
{"op":"DEF","entity":"<hash_or_name>","field":"<attr>","value":"<val>","span":"<exact words>"}
{"op":"EVA","entity":"<hash_or_name>","claim":"<claim>","status":"holds|fails|contested","span":"<exact words>"}

Example — "Smith, who left Boeing in 2019, now advises the Pentagon on drone policy."
Register has: e_a1b2c3d4 (Boeing) | Entity
[
{"op":"INS","entity":"smith","terrain":"Entity"},
{"op":"DEF","entity":"smith","field":"kind","value":"person","span":"Smith"},
{"op":"DEF","entity":"smith","field":"former_employer","value":"Boeing, left 2019","span":"left Boeing in 2019"},
{"op":"CON","from":"smith","to":"e_a1b2c3d4","type":"former_employee"},
{"op":"DEF","entity":"smith","field":"advisory_role","value":"drone policy","span":"advises the Pentagon on drone policy"}
]

Rules:
- Do NOT re-INS entities from the register. Reference them by hash.
- "span" = EXACT words from the passage.
- INS only mints identity + terrain. All attributes go in DEF.
- Extract ALL entities, connections, claims. Multiple events per passage is normal.
- Rhetoric IS data. Author judgments are EVA events.
- If a name might refer to an existing entity but you are uncertain, flag it:
  {"op":"AMBIG","name":"<name>","candidate":"<hash>","span":"<exact words>"}
  The system will trigger a MUTATE call to resolve it.

Terrains: Entity, Network, Paradigm, Void, Kind, Field, Link, Atmosphere, Lens`;


// ═══════════════════════════════════════════════════════════════
//  Prompts: Hypothesis (one per level, strict nesting)
//
//  Level N sees ONLY level N-1 hypotheses + its own revision history.
//  Level N NEVER sees level N-2 data.
// ═══════════════════════════════════════════════════════════════


const HYPOTHESIS_ENTITY = `Write a one-sentence hypothesis for what this entity is about.
Under 150 characters. Specific enough that future evidence could revise it.
Your prior hypotheses and their triggers are shown below.
Build on the trajectory of understanding. Do not restart from scratch.
Write ONLY the sentence.`;

const HYPOTHESIS_GROUP = `Write a one-sentence hypothesis for what this passage group is about.
You see ONLY entity hypotheses — not their underlying facts.
Under 150 characters. Capture the thread connecting them.
Prior group hypotheses show how the document is developing.
Write ONLY the sentence.`;

const HYPOTHESIS_SECTION = `Write a one-sentence hypothesis for what this section is about.
You see ONLY group hypotheses — not entity detail.
Under 150 characters. Capture the argument or narrative arc.
Prior section hypotheses show the document's shape so far.
Write ONLY the sentence.`;

const HYPOTHESIS_DOCUMENT = `Write a one-sentence hypothesis for what this document is about.
You see ONLY section hypotheses — not group or entity detail.
Under 200 characters. Capture the central finding or argument.
Prior document hypotheses in this corpus situate this document.
Write ONLY the sentence.`;

const HYPOTHESIS_SESSION = `Write a one-sentence hypothesis for what this conversation was about.
Focus on the investigative thread: what was asked, discovered, shifted.
Under 200 characters.
Write ONLY the sentence.`;

const HYPOTHESIS_CORPUS = `Write a one-sentence hypothesis for what this body of work is about.
You see ONLY document and session hypotheses.
Under 200 characters. Capture the overarching inquiry.
Write ONLY the sentence.`;


// ═══════════════════════════════════════════════════════════════
//  Prompts: Write mode
// ═══════════════════════════════════════════════════════════════


const WRITE_OUTLINE = `Create a document outline from the material below.
Return a JSON array:
[{"section":1,"topic":"...","entities":["<hash>"],"move":"INS|CON|DEF|EVA"}]

"move" = rhetorical operation:
  INS = introduce something new to the reader
  CON = reveal a connection between known things
  DEF = establish and support a claim
  EVA = assess whether a claim holds

Order: introduce before connect, connect before claim, claim before evaluate.
Return ONLY the JSON array.`;

const WRITE_SECTION = `Write this section using ONLY the [CTX] block.
Ground every claim in context. Do not editorialize beyond evidence.
2-4 paragraphs.
[READER] shows entities already introduced. Do not re-introduce them.`;


// ═══════════════════════════════════════════════════════════════
//  Prompt Builders
// ═══════════════════════════════════════════════════════════════


/**
 * Build hypothesis prompt. Strict nesting: each level sees only one level below.
 */
function buildHypothesisPrompt(level, id, graph) {
  const children = getChildInputs(level, id, graph);
  const history = graph.getHypothesisHistory(level, id);

  let prompt = children.join('\n');

  if (history.length > 0) {
    prompt += '\n\nPrior hypotheses (oldest first):';
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      prompt += `\n  rev ${i + 1} (${h.after}, ${h.inputCount} inputs): "${h.text}"`;
    }
  }

  return prompt;
}

function getChildInputs(level, id, graph) {
  switch (level) {
    case 'entity': {
      const entity = graph.getEntity(id);
      const defs = graph.getDefs(id);
      const edges = graph.getEdges(id);
      const lines = [`${id}@${computeStateHash(id, graph)} | ${entity.canonical} | ${entity.terrain}`];
      if (defs.length) lines.push(`Facts: ${defs.map(d => `${d.field}="${d.value}"`).join(', ')}`);
      if (edges.length) lines.push(`Connections: ${edges.map(e => `→${e.to} (${e.type})`).join(', ')}`);
      return lines;
    }
    case 'group': {
      const entities = graph.getEntitiesInRange(id.start, id.end);
      return entities.map(e => `${e.id}@${computeStateHash(e.id, graph)} ${e.canonical}: "${e.hypothesis}"`);
    }
    case 'section': {
      const groups = graph.getPassageGroupDEFs(id.start, id.end);
      return groups.map((g, i) => `group ${i + 1} (p${g.start + 1}-${g.end + 1}): "${g.hypothesis}"`);
    }
    case 'document': {
      const sections = graph.getSectionDEFs(id.documentId);
      return sections.map((s, i) => `section ${i + 1}: "${s.hypothesis}"`);
    }
    case 'session': {
      const docs = graph.getSessionDocumentDEFs(id.sessionId);
      const topics = graph.getSessionTopics(id.sessionId);
      return [
        ...docs.map(d => `doc "${d.title}": "${d.hypothesis}"`),
        ...topics.map(t => `topic: "${t}"`),
      ];
    }
    case 'corpus': {
      const docs = graph.getRecentDocumentDEFs(10);
      const sessions = graph.getRecentSessionDEFs(5);
      return [
        ...docs.map(d => `"${d.title}": "${d.hypothesis}"`),
        ...sessions.map(s => `session: "${s.hypothesis}"`),
      ];
    }
    default: return [];
  }
}

function getHypothesisSystemPrompt(level) {
  return {
    entity: HYPOTHESIS_ENTITY, group: HYPOTHESIS_GROUP,
    section: HYPOTHESIS_SECTION, document: HYPOTHESIS_DOCUMENT,
    session: HYPOTHESIS_SESSION, corpus: HYPOTHESIS_CORPUS,
  }[level] || HYPOTHESIS_ENTITY;
}


/**
 * Build Extract prompt with Given-Log IDs for provenance.
 */
function buildExtractPrompt(userMessage, modelResponse, userGivenId, modelGivenId, register) {
  const regStr = register.slice(0, 20).map(e =>
    `${e.id}@${e.stateHash} | ${e.canonical} | ${e.terrain}`
  ).join('\n');

  return `Entity register:\n${regStr}

User [${userGivenId}]: "${userMessage}"
Model [${modelGivenId}]: "${modelResponse}"`;
}


/**
 * Build Mutate prompt for ambiguity resolution.
 */
function buildMutatePrompt(ambiguity, graph) {
  const { name, candidateHash, span, context } = ambiguity;
  const candidate = graph.getEntity(candidateHash);
  const candidateDefs = graph.getDefs(candidateHash);

  let prompt = `Ambiguous reference: "${name}"`;
  prompt += `\nSource span: "${span}"`;
  if (context) prompt += `\nContext: "${context}"`;

  prompt += `\n\nExisting entity that might match:`;
  prompt += `\n  ${candidateHash}@${computeStateHash(candidateHash, graph)}`;
  prompt += `\n  canonical: ${candidate.canonical}`;
  prompt += `\n  terrain: ${candidate.terrain}`;
  prompt += `\n  h: ${candidate.hypothesis || '?'}`;
  for (const d of candidateDefs.slice(0, 5)) {
    prompt += `\n  = ${d.field}: "${d.value}"`;
  }

  prompt += `\n\nIs "${name}" the same entity as ${candidateHash}, or a different one?`;

  return prompt;
}


// ═══════════════════════════════════════════════════════════════
//  Dossier Builder (with hashes and state versions)
// ═══════════════════════════════════════════════════════════════


function buildDossier(rankedEntities, graph, maxTokens = 350) {
  let budget = maxTokens;
  const blocks = [];

  for (const { entity, tier } of rankedEntities) {
    const stateHash = computeStateHash(entity.id, graph);
    const edges = graph.getEdges(entity.id);
    const defs = graph.getDefs(entity.id);
    const conflicts = graph.getConflicts(entity.id);
    const aliases = entity.aliases?.length ? entity.aliases.join(', ') : null;

    if (tier === 1 && budget >= 65) {
      let b = `E: ${entity.id}@${stateHash} | ${entity.terrain} | ${edges.length}`;
      b += `\n  ~ ${entity.canonical}${aliases ? ', aka ' + aliases : ''}`;
      b += `\n  h: ${(entity.hypothesis || '?').slice(0, 130)}`;
      for (const edge of edges.slice(0, 3)) {
        const dir = edge.from === entity.id ? '→' : '←';
        const target = edge.from === entity.id ? edge.to : edge.from;
        b += `\n  ${dir} ${target} (${edge.type})`;
      }
      let spanDone = false;
      for (const def of defs.slice(0, 3)) {
        b += `\n  = ${def.field}: "${def.value}"`;
        if (def.span && !spanDone) { b += ` @"${def.span.slice(0, 50)}"`; spanDone = true; }
      }
      for (const c of conflicts.slice(0, 1)) {
        b += `\n  ⚠ ${c.field}: "${c.existing}" vs "${c.incoming}"`;
      }
      blocks.push(b);
      budget -= 65;

    } else if (tier === 2 && budget >= 35) {
      let b = `E: ${entity.id}@${stateHash} | ${entity.terrain}`;
      b += `\n  ~ ${entity.canonical}`;
      b += `\n  h: ${(entity.hypothesis || '?').slice(0, 130)}`;
      for (const def of defs.slice(0, 2)) { b += `\n  = ${def.field}: "${def.value}"`; }
      blocks.push(b);
      budget -= 35;

    } else if (budget >= 15) {
      blocks.push(`E: ${entity.id}@${stateHash} | ${entity.terrain}\n  ~ ${entity.canonical}\n  h: ${(entity.hypothesis || '?').slice(0, 100)}`);
      budget -= 15;

    } else { break; }
  }

  return blocks.length > 0
    ? `[CTX]\n${blocks.join('\n\n')}\n[/CTX]`
    : '[CTX]\n(no matching entities)\n[/CTX]';
}


/**
 * Mechanically collect the source spans behind a dossier.
 * The dossier carries hypotheses (the model's reading); this walks the
 * SAME ranked entities and pulls every verbatim span underneath them, so
 * a response can be traced back from hypothesis to original words.
 * No model call — pure graph projection.
 *
 * Returns: [{ entity, field, value, span, source }] where `source` is the
 * Given-Log ID of the message/passage the span came from.
 */
function collectDossierSpans(rankedEntities, graph) {
  const spans = [];
  for (const { entity } of rankedEntities) {
    for (const def of graph.getDefs(entity.id)) {
      if (!def.span) continue;
      spans.push({
        entity: entity.id,
        field: def.field,
        value: def.value,
        span: def.span,
        source: def.source || null,
      });
    }
  }
  return spans;
}


function buildPosition(lastTurn) {
  if (!lastTurn) return '';
  return `[POS]
prev: ${lastTurn.entities.slice(0, 5).join(', ')}
topic: ${lastTurn.topic}
last: "${lastTurn.userMessage.slice(0, 80)}"
[/POS]`;
}


function buildRegister(entities, graph) {
  return `[REGISTER — do not re-INS these]\n` +
    entities.map(e =>
      `${e.id}@${computeStateHash(e.id, graph)} | ${e.canonical}${e.aliases?.length ? ' | aka: ' + e.aliases.join(', ') : ''} | ${e.terrain}`
    ).join('\n');
}


function buildReaderCursor(introduced) {
  if (introduced.length <= 10) {
    return `[READER]\nIntroduced: ${introduced.join(', ')}\n[/READER]`;
  }
  const recent = introduced.slice(-5);
  return `[READER]\n${introduced.length} entities introduced. Recent: ${recent.join(', ')}\n[/READER]`;
}


// ═══════════════════════════════════════════════════════════════
//  MUTATE Trigger Detection (mechanical)
// ═══════════════════════════════════════════════════════════════


/**
 * Check if a MUTATE call should fire.
 * Scans model response + extract events for ambiguity signals.
 * Returns array of ambiguity objects to resolve.
 */
function detectMutationTriggers(modelResponse, extractEvents, signal, graph) {
  const triggers = [];

  // 1. Model flagged ambiguity in response text
  const ambigPatterns = [
    /may not be the same as (e_[a-f0-9]{8})/gi,
    /might be (?:a )?different (?:from |than )(e_[a-f0-9]{8})/gi,
    /not (?:the same|identical) (?:as |to )(e_[a-f0-9]{8})/gi,
    /could refer to (?:either|another)/gi,
  ];
  for (const pattern of ambigPatterns) {
    const match = pattern.exec(modelResponse);
    if (match) {
      triggers.push({
        type: 'model_flagged',
        text: match[0],
        candidateHash: match[1] || null,
        span: modelResponse.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40),
      });
    }
  }

  // 2. Ingest emitted an AMBIG event
  for (const evt of extractEvents) {
    if (evt.op === 'AMBIG') {
      triggers.push({
        type: 'ingest_ambig',
        name: evt.name,
        candidateHash: evt.candidate,
        span: evt.span,
      });
    }
  }

  // 3. NER found a name that partially matches but context is different
  const allNames = [
    ...(signal?.ner?.people || []),
    ...(signal?.ner?.places || []),
    ...(signal?.ner?.orgs || []),
  ];
  for (const name of allNames) {
    const partial = graph.searchEntities(name.toLowerCase());
    if (partial.length === 1) {
      const match = partial[0];
      // Same name but different terrain signals possible collision
      const nerType = signal.ner.people.includes(name) ? 'person'
        : signal.ner.places.includes(name) ? 'place'
        : 'org';
      const entityKind = graph.getDef(match.id, 'kind')?.value;
      if (entityKind && entityKind !== nerType) {
        triggers.push({
          type: 'type_mismatch',
          name: name,
          candidateHash: match.id,
          expectedType: nerType,
          actualType: entityKind,
        });
      }
    }
  }

  // 4. User explicitly corrected ("that's not the same", "those are the same")
  // Handled by the Gate classifying the message as a correction intent.
  // Not detected here — the calling code checks for correction patterns
  // and calls MUTATE directly.

  return triggers;
}


// ═══════════════════════════════════════════════════════════════
//  MUTATE Event Application
// ═══════════════════════════════════════════════════════════════


/**
 * Apply a MUTATE action to the graph.
 * Every mutation is logged as an event with full provenance.
 */
function applyMutation(action, graph, triggerId) {
  const event = {
    timestamp: Date.now(),
    triggeredBy: triggerId,
    action: action.action,
    reason: action.reason,
  };

  switch (action.action) {
    case 'FORK': {
      const newId = mintEntityId(action.new_canonical, Date.now());
      event.op = 'SEG';
      event.sourceEntity = action.source;
      event.newEntity = newId;
      event.newCanonical = action.new_canonical;
      event.reassignments = action.reassign || [];

      // Create new entity
      const source = graph.getEntity(action.source);
      graph.createEntity(newId, {
        canonical: action.new_canonical,
        terrain: source.terrain,
        forkedFrom: action.source,
      });

      // Reassign specified DEFs
      for (const r of event.reassignments) {
        graph.reassignDef(r.def_id, action.source, newId);
      }
      break;
    }

    case 'MERGE': {
      event.op = 'CON';
      event.type = 'same_as';
      event.keep = action.keep;
      event.absorb = action.absorb;
      event.newAliases = action.new_aliases || [];

      // Move all DEFs and edges from absorbed to keeper
      graph.mergeEntities(action.keep, action.absorb);

      // Add aliases
      for (const alias of event.newAliases) {
        graph.addAlias(action.keep, alias);
      }
      break;
    }

    case 'CORRECT': {
      event.op = 'DEF';
      event.entity = action.entity;
      event.field = action.field;
      event.oldValue = action.old_value;
      event.newValue = action.new_value;

      graph.writeDef(action.entity, action.field, action.new_value, {
        source: action.source,
        supersedes: graph.getDef(action.entity, action.field)?.id,
      });
      break;
    }

    case 'RECLASSIFY': {
      event.op = 'SEG';
      event.entity = action.entity;
      event.oldTerrain = action.old_terrain;
      event.newTerrain = action.new_terrain;

      graph.updateTerrain(action.entity, action.new_terrain);
      break;
    }

    case 'NONE':
      event.op = 'NUL';
      break;
  }

  // Log the mutation event itself
  graph.appendEvent(event);
  return event;
}


// ═══════════════════════════════════════════════════════════════
//  Auto-commit Tiers
// ═══════════════════════════════════════════════════════════════


function commitTier(event, graph) {
  switch (event.op) {
    case 'CON': return event.type === 'same_as' ? 'PROMPT' : 'AUTO';
    case 'SEG': return 'PROMPT'; // forks and reclassifications need consent
    case 'DEF': {
      const existing = graph.getDef(event.entity, event.field);
      if (existing && existing.value !== event.value) return 'PROMPT';
      return 'AUTO';
    }
    case 'INS': return 'PROMPT';
    case 'EVA': return event.status === 'contested' ? 'PROMPT' : 'AUTO';
    case 'REC': return 'REQUIRE';
    default: return 'AUTO';
  }
}


// ═══════════════════════════════════════════════════════════════
//  Consolidation Gates
// ═══════════════════════════════════════════════════════════════


function shouldConsolidate(state) {
  const elapsed = Date.now() - (state.lastConsolidation || 0);
  if (elapsed < 24 * 60 * 60 * 1000) return false;
  if ((state.sessionsSinceConsolidation || 0) < INTERVALS.CORPUS_HYPOTHESIS) return false;
  if (state.consolidationLock) return false;
  return true;
}


// ═══════════════════════════════════════════════════════════════
//  Token Budget Reference
// ═══════════════════════════════════════════════════════════════
//
//  Three model calls per knowledge-bearing turn:
//
//    READ:     ~900 tokens  (system 120 + CTX 350 + POS 80 + user 50 + response 300)
//    EXTRACT:  ~400 tokens  (system 130 + register 100 + exchange 100 + events 70)
//    MUTATE:   ~300 tokens  (system 100 + entity detail 100 + action 100)
//              (only if ambiguity detected, most turns: 0)
//
//  Non-knowledge-bearing turn:
//    READ:     ~200 tokens  (casual system 15 + user 50 + response 135)
//    EXTRACT:  0
//    MUTATE:   0
//
//  Walk (per passage):
//    INGEST:   ~500 tokens  (system 200 + register 100 + passage 100 + events 100)
//    ENTITY HYP: ~100 tokens per touched entity
//    GROUP HYP:  ~80 tokens (every 4 passages)
//    SECTION HYP: ~60 tokens (every 12 passages)
//
// ═══════════════════════════════════════════════════════════════
