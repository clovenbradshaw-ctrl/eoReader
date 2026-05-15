// providers/anthropic.js — Anthropic provider for callLLM.
// Wraps callClaudeRaw and honors cache_control markers natively.
// No streaming for now (Anthropic streaming would require SSE parsing;
// none of the existing call sites use onToken on the cloud path).

const AnthropicProvider = {
  name: 'anthropic',

  available() {
    try { return !!getApiKey(); } catch { return false; }
  },

  async call({ system, user, maxTokens, model, opts, responseFormat }) {
    // For json roles, force the model toward strict JSON by suffixing the
    // system message. (Anthropic has no response_format param; this is the
    // pragmatic equivalent and what our prompts already say.)
    let sys = system;
    if (responseFormat === 'json' && typeof sys === 'string') {
      sys = sys + '\n\nReturn ONLY valid JSON. No prose, no code fences.';
    }
    const r = await callClaudeRaw(sys, user, maxTokens, model, opts);
    return {
      text: r.text,
      usage: r.usage,
      model: r.model,
      provider: 'anthropic',
      ms: r.ms,
      cacheStats: r.usage ? {
        read: r.usage.cache_read_input_tokens || 0,
        write: r.usage.cache_creation_input_tokens || 0,
      } : null,
    };
  },

  // Anthropic queue concurrency cap (matches existing QUEUE_MAX_CONCURRENCY default).
  concurrency: 3,
};

if (typeof window !== 'undefined' && window.LLMProviders) {
  window.LLMProviders.register(AnthropicProvider);
}
