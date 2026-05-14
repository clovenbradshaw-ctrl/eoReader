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

  // summary route delegates to the digest generator so the librarian
  // produces the standardized digest from the graph alone.
  if (routeInfo.route === 'summary') {
    if (routeInfo.matchedEntities && routeInfo.matchedEntities.length) {
      return librarianGenerateSummary(
        { kind: 'entity', ids: routeInfo.matchedEntities },
        { skipModal: true }
      );
    }
    return librarianGenerateSummary({ kind: 'topic', text: question });
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

// Generate a standardized digest entry from a focused subgraph.
// scope: { kind: 'entity'|'terrain'|'topic'|'all', ids?, terrain?, text? }
// opts:  { includeSources, includeConnections, includeNotes, includeSpans, skipModal }
// When called with no args, opens a scope+toggles modal.
async function librarianGenerateSummary(scope, opts) {
  opts = opts || {};

  const apiKey = getApiKey();
  if (!apiKey) { await showAlert('Set your Anthropic API key first'); return; }

  // open scope/toggles modal unless caller passes scope + skipModal
  if (!scope || !opts.skipModal) {
    const presetKind = scope && scope.kind ? scope.kind : 'all';
    const presetTarget = scope
      ? (scope.kind === 'entity' && Array.isArray(scope.ids)
          ? (graph.entities[scope.ids[0]]?.canonical || '')
          : scope.terrain || scope.text || '')
      : '';
    const dialog = await showPrompt({
      title: 'Generate summary from graph',
      submitLabel: 'Generate',
      fields: [
        { name: 'scope', label: 'Scope', type: 'chips',
          options: ['this entity', 'a terrain', 'topic', 'whole index'],
          default: presetKind === 'entity' ? 'this entity' :
                   presetKind === 'terrain' ? 'a terrain' :
                   presetKind === 'topic' ? 'topic' : 'whole index' },
        { name: 'target', label: 'Entity / terrain / topic text', type: 'text',
          placeholder: 'e.g. MNPD, Field, "private policing in Nashville"',
          default: presetTarget },
        { name: 'sources', label: 'Feed sources list to the prompt?', type: 'chips',
          options: ['on', 'off'], default: opts.includeSources === false ? 'off' : 'on' },
        { name: 'connections', label: 'Feed related connections to the prompt?', type: 'chips',
          options: ['on', 'off'], default: opts.includeConnections === false ? 'off' : 'on' },
        { name: 'spans', label: 'Feed evidence spans + processing trail (DEF/EVA/REC)?', type: 'chips',
          options: ['on', 'off'], default: opts.includeSpans === false ? 'off' : 'on' },
        { name: 'notes', label: 'Feed editor notes to the prompt?', type: 'chips',
          options: ['on', 'off'], default: opts.includeNotes === false ? 'off' : 'on' },
        { name: 'framing', label: 'Extra framing (optional)', type: 'textarea',
          placeholder: 'e.g. "focus on procurement", "keep under 250 words"' },
      ],
    });
    if (dialog === null) return;

    const target = (dialog.target || '').trim();
    if (dialog.scope === 'this entity') {
      const ids = [...matchEntitiesInText(target)];
      if (!ids.length) {
        await showAlert('No indexed entity matches "' + target + '". Try a different name or use the "topic" scope.');
        return;
      }
      scope = { kind: 'entity', ids };
    } else if (dialog.scope === 'a terrain') {
      if (!target) { await showAlert('Name a terrain (Entity, Field, Network, Kind, Link, Void, Atmosphere, Lens, Paradigm).'); return; }
      scope = { kind: 'terrain', terrain: target };
    } else if (dialog.scope === 'topic') {
      if (!target) { await showAlert('Type a topic to summarize.'); return; }
      scope = { kind: 'topic', text: target };
    } else {
      scope = { kind: 'all' };
    }
    opts = {
      includeSources: dialog.sources !== 'off',
      includeConnections: dialog.connections !== 'off',
      includeSpans: dialog.spans !== 'off',
      includeNotes: dialog.notes !== 'off',
      framing: (dialog.framing || '').trim(),
    };
  }

  if (currentView !== 'index') toggleGraph();
  if (activeGraphTab !== 'librarian') graphTab('librarian');

  // record the user-facing intent in the chat
  const scopeLabel =
    scope.kind === 'entity' ? 'entity: ' + (scope.ids || []).map(id => graph.entities[id]?.canonical || id).join(', ') :
    scope.kind === 'terrain' ? 'terrain: ' + scope.terrain :
    scope.kind === 'topic' ? 'topic: ' + scope.text :
    'whole index';
  const togglesLabel = [
    'sources:' + (opts.includeSources === false ? 'off' : 'on'),
    'connections:' + (opts.includeConnections === false ? 'off' : 'on'),
    'spans:' + (opts.includeSpans === false ? 'off' : 'on'),
    'notes:' + (opts.includeNotes === false ? 'off' : 'on'),
  ].join(', ');
  librarianChat.push({ role: 'user', content: 'Generate summary — ' + scopeLabel + ' (' + togglesLabel + (opts.framing ? '; framing: ' + opts.framing : '') + ')', ts: Date.now() });
  renderLibrarianView();

  const built = buildLibrarianDigestContext(scope, opts);
  if (!built.focused.length) {
    const msg = { role: 'assistant', content: 'No indexed sites match that scope yet — process an article first or broaden the scope.', ts: Date.now() };
    librarianChat.push(msg);
    renderLibrarianView();
    return;
  }

  const framingSystemBlock = opts.framing
    ? '---\nEDITORIAL OVERRIDE FOR THIS DIGEST\n'
      + 'The instructions below come from the editor for this single summary only. They take priority over the defaults wherever they conflict.\n\n'
      + opts.framing
      + '\n---'
    : '';

  // Headline + Source line: derive a topic line and a source list from the
  // focused subgraph, since there's no single article driving this digest.
  const headlineGuess =
    scope.kind === 'entity' ? (graph.entities[scope.ids[0]]?.canonical || scope.ids[0]) :
    scope.kind === 'terrain' ? scope.terrain + ' — index summary' :
    scope.kind === 'topic' ? scope.text :
    'Index summary';
  const sourcesLine = built.sources.length
    ? built.sources.slice(0, 6).map(s => s.url ? '[' + (s.title || s.url) + '](' + s.url + ')' : (s.title || '')).filter(Boolean).join(' · ')
    : '';

  const framingHeader = [
    '=== DIGEST FROM GRAPH TRAVERSAL ===',
    'Produce the standardized digest exactly as the system prompt specifies. There is no single article — the focused subgraph below (hypotheses, processing trail, connections, spans, sources) is your only evidence. Quote spans verbatim; do not fabricate quotations beyond what is provided.',
    '',
    'Headline topic: ' + headlineGuess + ' (rewrite for clarity if useful — still ### H3).',
    'Source line (use as the italic Markdown source line; if empty, use "Source: index, multiple feeds"): *' + (sourcesLine || 'Source: index, multiple feeds') + '*',
    '',
    '=== FOCUSED SUBGRAPH ===',
    built.context,
  ].join('\n');

  const assistantMsg = { role: 'assistant', content: '…', ts: Date.now(), pending: true };
  librarianChat.push(assistantMsg);
  renderLibrarianView();

  const step = {
    ts: assistantMsg.ts,
    question: 'GENERATE SUMMARY — ' + scopeLabel,
    routeInfo: { route: 'summary', matchedEntities: built.focused, signals: { metaScore: 0, connectionScore: 0, summaryScore: 1, namedHits: built.focused.length, tokens: 0 } },
    composition: built.composition,
    focused: built.focused,
    contextPreview: built.context,
    usage: null, ms: null, model: null, suggestions: [],
  };
  step.composition.estimatedInputTokens = estimateTokens(getPrompt()) + estimateTokens(framingHeader);

  try {
    const baseSystem = getPrompt();
    const systemPrompt = framingSystemBlock ? baseSystem + '\n\n' + framingSystemBlock : baseSystem;
    const r = await callClaudeRaw(systemPrompt, framingHeader, 2000);
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

  step.suggestions = analyzeLibrarianStep(step);
  librarianTelemetryLog.push(step);
  librarianSuggestions.push({ ts: Date.now(), turnTs: step.ts, fromLLM: false, items: step.suggestions });
  assistantMsg.telemetry = step;

  renderLibrarianView();
  maybeRunLLMEva(step);
}

// Convenience: generate a summary scoped to a specific entity id.
function librarianSummarizeEntity(id) {
  if (!graph.entities[id]) return;
  return librarianGenerateSummary({ kind: 'entity', ids: [id] });
}
