// providers/ollama.js — local Ollama (http://localhost:11434) provider.
// Capability-detect via a HEAD on /api/tags; user configures host + model
// in settings (stored under eo.providers.ollama).

const OLLAMA_DEFAULT_HOST = 'http://localhost:11434';
const OLLAMA_DEFAULT_MODEL = 'llama3.2:3b';

function _ollamaConfig() {
  try {
    const raw = localStorage.getItem('eo.providers.ollama');
    if (raw) return JSON.parse(raw);
  } catch {}
  return { host: OLLAMA_DEFAULT_HOST, model: OLLAMA_DEFAULT_MODEL };
}

function _flatten(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && b.text) || '').join('');
  return String(content);
}

let _availableCache = { ts: 0, ok: false };

const OllamaProvider = {
  name: 'ollama',

  // Synchronous availability is best-effort: we cache the result of the
  // last probe(). Default to false until probe runs.
  available() {
    return _availableCache.ok && (Date.now() - _availableCache.ts) < 60_000;
  },

  async probe() {
    const { host } = _ollamaConfig();
    try {
      const resp = await fetch(host.replace(/\/+$/, '') + '/api/tags', { method: 'GET' });
      _availableCache = { ts: Date.now(), ok: resp.ok };
      return resp.ok;
    } catch {
      _availableCache = { ts: Date.now(), ok: false };
      return false;
    }
  },

  async call({ system, user, maxTokens, model, opts, responseFormat, temperature, onToken }) {
    const cfg = _ollamaConfig();
    const host = cfg.host.replace(/\/+$/, '');
    const chosenModel = model || cfg.model;

    const sysText = _flatten(system);
    const userText = _flatten(user);
    const messages = [];
    if (sysText) messages.push({ role: 'system', content: sysText });
    messages.push({ role: 'user', content: userText });

    const body = {
      model: chosenModel,
      messages,
      stream: !!onToken,
      options: {
        num_predict: maxTokens || 512,
        temperature: typeof temperature === 'number'
          ? temperature
          : (responseFormat === 'json' ? 0 : 0.7),
      },
    };
    if (responseFormat === 'json') body.format = 'json';

    const t0 = performance.now();
    const resp = await fetch(host + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error('ollama ' + resp.status + ': ' + err.slice(0, 200));
    }

    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;

    if (onToken) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (opts?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const delta = obj.message?.content || '';
            if (delta) {
              text += delta;
              try { onToken(delta); } catch {}
            }
            if (obj.done) {
              promptTokens = obj.prompt_eval_count || 0;
              completionTokens = obj.eval_count || 0;
            }
          } catch {}
        }
      }
    } else {
      const data = await resp.json();
      text = data.message?.content || '';
      promptTokens = data.prompt_eval_count || 0;
      completionTokens = data.eval_count || 0;
    }

    const ms = Math.round(performance.now() - t0);
    return {
      text: (text || '').trim(),
      usage: { input_tokens: promptTokens, output_tokens: completionTokens },
      model: chosenModel,
      provider: 'ollama',
      ms,
      cacheStats: null,
    };
  },

  concurrency: 1,
};

if (typeof window !== 'undefined' && window.LLMProviders) {
  window.LLMProviders.register(OllamaProvider);
}
