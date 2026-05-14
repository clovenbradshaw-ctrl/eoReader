// api.js — Anthropic API wrapper.
async function callClaude(systemPrompt, userContent, maxTokens, model) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('no api key');

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData.error?.message || resp.status);
  }

  const data = await resp.json();
  return (data.content?.map(b => b.text || '').join('') || '').trim();
}
