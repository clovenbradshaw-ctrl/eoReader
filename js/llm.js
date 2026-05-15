// llm.js — provider-agnostic LLM entry point. Every call site routes
// through callLLM({...}); the registry picks the configured provider
// (anthropic / webllm / ollama / window-ai) per role.
//
// opts = {
//   system,           string OR array of content blocks (cache markers ok)
//   user,             string OR array of content blocks
//   maxTokens,
//   role,             'walk' | 'dream' | 'librarian' | 'digest' | 'summary' | 'eva' | 'classify' | 'chat'
//   responseFormat,   'text' | 'json'  — providers with constrained decoding use it
//   temperature,      optional; defaults: json → 0, text → provider default
//   model,            optional explicit model id (per-provider semantics)
//   signal,           AbortSignal
//   onToken,          optional streaming callback
// }
// returns { text, usage, model, provider, ms, cacheStats?, providerFallback? }

async function callLLM(opts) {
  opts = opts || {};
  const role = opts.role || 'chat';
  const { provider, fallback, fallbackFrom } = LLMProviders.routeFor(role);
  if (!provider) {
    throw new Error('no LLM provider available for role ' + role);
  }

  try {
    const r = await provider.call({
      system: opts.system,
      user: opts.user,
      maxTokens: opts.maxTokens,
      role,
      model: opts.model,
      responseFormat: opts.responseFormat,
      temperature: opts.temperature,
      onToken: opts.onToken,
      opts: { signal: opts.signal },
    });
    if (fallback) r.providerFallback = { from: fallbackFrom, to: provider.name };
    return r;
  } catch (e) {
    // Re-throw AbortError as-is so cancellation propagates cleanly.
    if (e?.name === 'AbortError') throw e;
    throw e;
  }
}

// Convenience: shape the legacy {text} return for callers that
// previously used `callClaude` and just need a string.
async function callLLMText(opts) {
  const r = await callLLM(opts);
  return r.text;
}

if (typeof window !== 'undefined') {
  window.callLLM = callLLM;
  window.callLLMText = callLLMText;
}
