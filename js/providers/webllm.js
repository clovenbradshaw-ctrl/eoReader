// providers/webllm.js — in-browser WebLLM (WebGPU) provider.
// Dynamically imports @mlc-ai/web-llm on first use. Reuses chat.js's
// MODEL_BUDGETS / pickModel / probeDeviceCaps if eoChat is installed,
// otherwise falls back to a built-in default model.

const WEBLLM_DEFAULT_MODEL = 'Llama-3.2-3B-Instruct-q4f16_1-MLC';
const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm';

let _webllmModule = null;
const _engines = new Map();   // modelId -> engine
const _loading = new Map();   // modelId -> Promise<engine>
let _caps = null;

async function _loadWebLLM() {
  if (_webllmModule) return _webllmModule;
  _webllmModule = await import(/* webpackIgnore: true */ WEBLLM_CDN);
  return _webllmModule;
}

async function _getEngine(modelId, progress) {
  if (_engines.has(modelId)) return _engines.get(modelId);
  if (_loading.has(modelId)) return _loading.get(modelId);
  const p = (async () => {
    const mod = await _loadWebLLM();
    const engine = await mod.CreateMLCEngine(modelId, {
      initProgressCallback: progress || (() => {}),
    });
    _engines.set(modelId, engine);
    _loading.delete(modelId);
    return engine;
  })();
  _loading.set(modelId, p);
  return p;
}

function _flatten(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (b && b.text) || '').join('');
  }
  return String(content);
}

const WebLLMProvider = {
  name: 'webllm',

  available() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  },

  async probe() {
    if (_caps) return _caps;
    if (typeof window !== 'undefined' && window.eoChat?.probeDeviceCaps) {
      _caps = await window.eoChat.probeDeviceCaps();
    } else {
      _caps = { shaderF16: false, gpuTier: 'mid', isMobile: false };
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) _caps.shaderF16 = adapter.features?.has?.('shader-f16') || false;
      } catch {}
    }
    return _caps;
  },

  // Resolve which model to load for this role.
  async _resolveModel(role, promptText, explicitModel) {
    if (explicitModel) return { modelId: explicitModel };
    const caps = await this.probe();
    if (typeof window !== 'undefined' && window.eoChat?.pickModel) {
      const promptTokens = Math.ceil(_flatten(promptText).length / 4);
      const policy = (LLMProviders?.getModelPolicyForRole?.(role)) || 'auto';
      const picked = window.eoChat.pickModel({ role, promptTokens, caps, policy });
      if (picked?.modelId) return picked;
    }
    return { modelId: WEBLLM_DEFAULT_MODEL };
  },

  async call({ system, user, maxTokens, role, model, opts, responseFormat, temperature, onToken }) {
    if (!this.available()) throw new Error('WebGPU unavailable');

    const sysText = _flatten(system);
    const userText = _flatten(user);
    const resolved = await this._resolveModel(role, sysText + '\n' + userText, model);
    const modelId = resolved.modelId;

    const progress = (typeof window !== 'undefined' && window.eoChat?.getCtx?.()?.onWebLLMProgress)
      || ((p) => { try { console.debug('[webllm]', modelId, p.text || p); } catch {} });

    const t0 = performance.now();
    const engine = await _getEngine(modelId, progress);

    const messages = [];
    if (sysText) messages.push({ role: 'system', content: sysText });
    messages.push({ role: 'user', content: userText });

    const reqBody = {
      messages,
      max_tokens: maxTokens || 512,
      temperature: typeof temperature === 'number'
        ? temperature
        : (responseFormat === 'json' ? 0 : 0.7),
    };
    if (responseFormat === 'json') {
      reqBody.response_format = { type: 'json_object' };
    }

    let text = '';
    let usage = null;

    if (onToken) {
      reqBody.stream = true;
      const stream = await engine.chat.completions.create(reqBody);
      for await (const chunk of stream) {
        if (opts?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          text += delta;
          try { onToken(delta); } catch {}
        }
        if (chunk.usage) usage = chunk.usage;
      }
    } else {
      const resp = await engine.chat.completions.create(reqBody);
      text = resp.choices?.[0]?.message?.content || '';
      usage = resp.usage || null;
    }

    const ms = Math.round(performance.now() - t0);
    return {
      text: (text || '').trim(),
      usage: usage ? {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
      } : null,
      model: modelId,
      provider: 'webllm',
      ms,
      cacheStats: null,
    };
  },

  // WebLLM serializes per engine — running two inferences against the same
  // engine concurrently is a footgun. Keep this at 1.
  concurrency: 1,
};

if (typeof window !== 'undefined' && window.LLMProviders) {
  window.LLMProviders.register(WebLLMProvider);
}
