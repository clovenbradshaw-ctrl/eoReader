// api.js — Anthropic API wrapper. callClaudeRaw returns {text, usage, ms, model};
// callClaude preserves the legacy string-returning contract for existing callers.
// opts.signal forwards an AbortSignal so queue.js can cancel in-flight fetches.
//
// systemPrompt and userContent each accept either:
//   - a string  (legacy: sent as a single text block)
//   - an array of content blocks: [{type:'text', text, cache_control?}, ...]
// cache_control: {type:'ephemeral'} on a block tells Anthropic to cache
// everything up to and including that block. Hits return 0.1x input cost;
// writes pay 1.25x. Use cacheBlock()/textBlock() helpers below.

function cacheBlock(text) {
  return { type: 'text', text: String(text || ''), cache_control: { type: 'ephemeral' } };
}

function textBlock(text) {
  return { type: 'text', text: String(text || '') };
}

function normalizeContent(input) {
  if (input == null) return null;
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (Array.isArray(input)) return input.filter(b => b && b.text !== '');
  return [{ type: 'text', text: String(input) }];
}

async function callClaudeRaw(systemPrompt, userContent, maxTokens, model, opts) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('no api key');

  const chosenModel = model || 'claude-sonnet-4-20250514';
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const sysBlocks = normalizeContent(systemPrompt);
  const userBlocks = normalizeContent(userContent) || [{ type: 'text', text: '' }];

  // Anthropic accepts system as a plain string or an array of blocks.
  // When any block carries cache_control we must use the array form.
  const hasSysCache = Array.isArray(sysBlocks) && sysBlocks.some(b => b && b.cache_control);
  const systemField = hasSysCache ? sysBlocks
    : (sysBlocks && sysBlocks.length === 1 && !sysBlocks[0].cache_control
        ? sysBlocks[0].text
        : sysBlocks);

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: chosenModel,
      max_tokens: maxTokens || 1000,
      system: systemField,
      messages: [{ role: 'user', content: userBlocks }],
    }),
    signal: opts && opts.signal ? opts.signal : undefined,
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData.error?.message || resp.status);
  }

  const data = await resp.json();
  const text = (data.content?.map(b => b.text || '').join('') || '').trim();
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  return { text, usage: data.usage || null, model: chosenModel, ms };
}

async function callClaude(systemPrompt, userContent, maxTokens, model, opts) {
  const r = await callClaudeRaw(systemPrompt, userContent, maxTokens, model, opts);
  return r.text;
}
