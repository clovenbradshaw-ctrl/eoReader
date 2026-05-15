// librarian.js — chat grounded in the index. Routes each question mechanically
// (meta → catalog only, entity/connection → focused subgraph, broad → top-degree
// fallback with catalog), captures real token usage from the API, and hands each
// step to the analyzer for DEF/EVA/REC suggestions. The LLM is only invoked to
// produce prose; all traversal is local.

async function librarianAsk(question) {
  question = (question || '').trim();
  if (!question) return;
  const apiKey = getApiKey();
  if (!apiKey) { await showAlert('Set your Anthropic API key first'); return; }

  if (currentView !== 'index') toggleGraph();
  if (activeGraphTab !== 'librarian') graphTab('librarian');

  // 1. mechanical routing
  const routeInfo = routeLibrarianQuestion(question);

  // summary route hands off to the dedicated "chat with docs" view —
  // picks get seeded from the matched scope, then the user can ask follow-ups
  // there with full source-toggle control.
  if (routeInfo.route === 'summary') {
    if (routeInfo.matchedEntities && routeInfo.matchedEntities.length) {
      return openSummaryFromScope({ kind: 'entity', ids: routeInfo.matchedEntities }, question);
    }
    return openSummaryFromScope({ kind: 'topic', text: question }, question);
  }

  librarianChat.push({ role: 'user', content: question, ts: Date.now() });
  renderLibrarianView();

  // 2. mechanical context build
  const built = buildLibrarianContextMechanical(question, routeInfo);

  // 3. conversation (small, capped)
  const turns = [];
  const recent = librarianChat.slice(-8);
  for (const t of recent.slice(0, -1)) {
    turns.push((t.role === 'user' ? 'USER: ' : 'LIBRARIAN: ') + t.content);
  }
  turns.push('USER: ' + question);

  const userMsg = built.context + '\n\n=== CONVERSATION ===\n' + turns.join('\n\n');
  built.composition.conversationTurns = recent.length;
  built.composition.estimatedInputTokens = estimateTokens(LIBRARIAN_PROMPT) + estimateTokens(userMsg);

  // placeholder assistant message — telemetry attaches once the call returns
  const assistantMsg = { role: 'assistant', content: '…', ts: Date.now(), pending: true };
  librarianChat.push(assistantMsg);
  renderLibrarianView();

  const step = {
    ts: assistantMsg.ts,
    question,
    routeInfo,
    composition: built.composition,
    focused: built.focused,
    contextPreview: built.context,
    usage: null,
    ms: null,
    model: null,
    suggestions: [],
  };

  try {
    const r = await callClaudeRaw(LIBRARIAN_PROMPT, userMsg, 1200);
    assistantMsg.content = r.text;
    assistantMsg.pending = false;
    step.usage = r.usage;
    step.ms = r.ms;
    step.model = r.model;
  } catch (e) {
    assistantMsg.content = '✗ error: ' + e.message;
    assistantMsg.pending = false;
    step.error = e.message;
  }

  // 4. mechanical analysis (DEF/EVA/REC) — always runs, never costs tokens
  step.suggestions = analyzeLibrarianStep(step);
  librarianTelemetryLog.push(step);
  librarianSuggestions.push({ ts: Date.now(), turnTs: step.ts, fromLLM: false, items: step.suggestions });
  assistantMsg.telemetry = step;

  renderLibrarianView();

  // 5. threshold LLM EVA pass — fires only when local rules flag tension or
  // input tokens exceed the LLM-analyzer threshold. Updates the panel async.
  maybeRunLLMEva(step);
}

function askLibrarianAbout(id) {
  const e = graph.entities[id];
  if (!e) return;
  librarianAsk('Tell me about `' + id + '` — ' + e.canonical + '. What does the index say it is, and what is it connected to?');
}

// Legacy entry point — preserved so older callers still work, but routes
// into the new "chat with docs" view rather than running the digest inline.
async function librarianGenerateSummary(scope, opts) {
  opts = opts || {};
  await openSummaryFromScope(scope, null, opts);
  return;
}

// Seed summaryPicks from a scope description, open the chat-with-docs
// view, and (if a question was provided) ask it. Used by:
//   - librarianAsk summary-route hand-off,
//   - the entity page "chat with docs" button,
//   - legacy librarianGenerateSummary callers.
async function openSummaryFromScope(scope, question, opts) {
  scope = scope || { kind: 'all' };
  opts = opts || {};

  // Resolve entity ids from the scope.
  const entityIds = new Set();
  if (scope.kind === 'entity' && Array.isArray(scope.ids)) {
    scope.ids.forEach((id) => { if (graph.entities[id]) entityIds.add(id); });
  } else if (scope.kind === 'topic' && scope.text) {
    if (typeof matchEntitiesInText === 'function') {
      [...matchEntitiesInText(scope.text)].forEach((id) => entityIds.add(id));
    }
  }

  if (entityIds.size) {
    summaryPicks.entityIds = new Set([...summaryPicks.entityIds, ...entityIds]);
  }
  if (opts.includeSources != null) summaryPicks.includeSources = opts.includeSources !== false;
  if (opts.includeNotes != null)   summaryPicks.includeNotes   = opts.includeNotes !== false;
  if (opts.framing) summaryPicks.framing = opts.framing;

  if (typeof switchToSummarizeView === 'function') switchToSummarizeView();

  if (question && typeof summaryAsk === 'function') {
    return summaryAsk(question);
  }
}

// Convenience for the entity-detail "chat with docs" button.
function openSummaryWithEntity(id) {
  if (!graph.entities[id]) return;
  return openSummaryFromScope({ kind: 'entity', ids: [id] });
}

// Back-compat: any remaining callers of librarianSummarizeEntity.
function librarianSummarizeEntity(id) {
  return openSummaryWithEntity(id);
}
