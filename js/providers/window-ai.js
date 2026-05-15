// providers/window-ai.js — Chrome's built-in on-device model (Gemini Nano)
// via the window.ai (a.k.a. window.LanguageModel) API. Capability-detected
// at boot. No JSON-constrained mode — we suffix the prompt to coerce JSON.

function _flatten(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && b.text) || '').join('');
  return String(content);
}

function _hostApi() {
  // The API has gone through several names during preview. Probe in order:
  //   window.LanguageModel (current as of late 2025)
  //   window.ai.languageModel (older)
  if (typeof window === 'undefined') return null;
  if (window.LanguageModel) return window.LanguageModel;
  if (window.ai?.languageModel) return window.ai.languageModel;
  return null;
}

let _availability = null;

const WindowAIProvider = {
  name: 'window-ai',

  available() {
    return !!_hostApi();
  },

  async probe() {
    const api = _hostApi();
    if (!api) return false;
    try {
      if (typeof api.availability === 'function') {
        _availability = await api.availability();
      } else if (typeof api.capabilities === 'function') {
        const caps = await api.capabilities();
        _availability = caps?.available || caps?.status || null;
      }
      return _availability === 'available' || _availability === 'readily';
    } catch {
      return false;
    }
  },

  async call({ system, user, maxTokens, opts, responseFormat, temperature, onToken }) {
    const api = _hostApi();
    if (!api) throw new Error('window.ai LanguageModel not available');

    const sysText = _flatten(system);
    let userText = _flatten(user);
    if (responseFormat === 'json') {
      userText += '\n\nOutput ONLY a valid JSON value. No prose, no code fences, no explanation.';
    }

    const t0 = performance.now();
    const session = await api.create({
      initialPrompts: sysText ? [{ role: 'system', content: sysText }] : undefined,
      temperature: typeof temperature === 'number'
        ? temperature
        : (responseFormat === 'json' ? 0 : 0.7),
      topK: 3,
    });

    let text = '';
    try {
      if (onToken && typeof session.promptStreaming === 'function') {
        const stream = session.promptStreaming(userText, { signal: opts?.signal });
        for await (const chunk of stream) {
          if (opts?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          // Older API yields cumulative text; newer yields deltas. Detect.
          const delta = chunk.startsWith(text) ? chunk.slice(text.length) : chunk;
          text = chunk.startsWith(text) ? chunk : text + chunk;
          if (delta) { try { onToken(delta); } catch {} }
        }
      } else {
        text = await session.prompt(userText, { signal: opts?.signal });
      }
    } finally {
      try { session.destroy?.(); } catch {}
    }

    const ms = Math.round(performance.now() - t0);
    return {
      text: (text || '').trim(),
      usage: null,  // window.ai doesn't surface token counts
      model: 'gemini-nano',
      provider: 'window-ai',
      ms,
      cacheStats: null,
    };
  },

  concurrency: 1,
};

if (typeof window !== 'undefined' && window.LLMProviders) {
  window.LLMProviders.register(WindowAIProvider);
}
