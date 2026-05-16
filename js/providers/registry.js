// providers/registry.js — capability probe + role → provider router.
// Reads the user's policy from localStorage (eo.models.policy), falls back
// to a default that keeps everything on Anthropic until the user opts in.

const PROVIDER_DEFAULT_POLICY = {
  walk:      'anthropic',
  dream:     'anthropic',
  librarian: 'anthropic',
  digest:    'anthropic',
  summary:   'anthropic',
  eva:       'anthropic',
  classify:  'anthropic',
  chat:      'anthropic',
};

const PROVIDER_FALLBACK_ORDER = ['anthropic', 'ollama', 'webllm', 'window-ai'];

const LLMProviders = {
  _byName: {},

  register(provider) {
    this._byName[provider.name] = provider;
  },

  get(name) {
    return this._byName[name] || null;
  },

  all() {
    return Object.values(this._byName);
  },

  // Probe each provider's availability. Returns { name → bool }.
  async probeAll() {
    const out = {};
    for (const p of this.all()) {
      try {
        if (typeof p.probe === 'function') out[p.name] = await p.probe();
        else out[p.name] = !!p.available();
      } catch {
        out[p.name] = false;
      }
    }
    return out;
  },

  getPolicy() {
    try {
      const raw = localStorage.getItem('eo.models.policy');
      if (raw) return { ...PROVIDER_DEFAULT_POLICY, ...JSON.parse(raw) };
    } catch {}
    return { ...PROVIDER_DEFAULT_POLICY };
  },

  setPolicy(policy) {
    const merged = { ...this.getPolicy(), ...policy };
    try { localStorage.setItem('eo.models.policy', JSON.stringify(merged)); } catch {}
    return merged;
  },

  // Per-provider model pinning, e.g. { webllm: 'Llama-3.2-3B-Instruct-q4f16_1-MLC' }.
  getModelPolicyForRole(role) {
    try {
      const raw = localStorage.getItem('eo.models.modelByRole');
      if (raw) {
        const obj = JSON.parse(raw);
        return obj?.[role] || 'auto';
      }
    } catch {}
    return 'auto';
  },

  // The provider name the user configured for this role, ignoring any
  // availability-driven fallback. Used by callers that need to know the
  // intended provider (e.g. to decide whether an Anthropic key is needed).
  configuredProviderName(role) {
    const policy = this.getPolicy();
    return policy[role] || PROVIDER_DEFAULT_POLICY[role] || 'anthropic';
  },

  // Resolve the provider object for a given role, with fallback if the
  // configured provider is unavailable.
  routeFor(role) {
    const chosen = this.configuredProviderName(role);
    const primary = this.get(chosen);
    if (primary && primary.available()) {
      return { provider: primary, fallback: false };
    }
    // The user explicitly configured a non-Anthropic provider (e.g. a local
    // Ollama server). Its availability probe is best-effort and goes stale
    // mid-job; silently falling back here would route processing onto the
    // Anthropic API and burn through its rate limits. Surface the chosen
    // provider so the call fails loudly if it is genuinely down.
    if (primary && chosen !== 'anthropic') {
      return { provider: primary, fallback: false };
    }
    // Anthropic was configured but is unavailable (no API key) — fall back
    // to the first available provider in PROVIDER_FALLBACK_ORDER.
    for (const name of PROVIDER_FALLBACK_ORDER) {
      const p = this.get(name);
      if (p && p.available()) {
        return { provider: p, fallback: true, fallbackFrom: chosen };
      }
    }
    return { provider: primary || null, fallback: false };
  },
};

if (typeof window !== 'undefined') window.LLMProviders = LLMProviders;
