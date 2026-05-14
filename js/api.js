// api.js — Anthropic API wrapper. callClaudeRaw returns {text, usage, ms, model};
// callClaude preserves the legacy string-returning contract for existing callers.
// opts.signal forwards an AbortSignal so queue.js can cancel in-flight fetches.
async function callClaudeRaw(systemPrompt, userContent, maxTokens, model, opts) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('no api key');

  const chosenModel = model || 'claude-sonnet-4-20250514';
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
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
