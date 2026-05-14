// librarian.js — chat grounded in the index. Builds index context for each
// turn (sites, hypothesis, connections, top spans) and lets Claude answer
// using site IDs as anchors.

async function librarianAsk(question) {
  question = (question || '').trim();
  if (!question) return;
  const apiKey = getApiKey();
  if (!apiKey) { alert('Set your Anthropic API key first'); return; }

  // ensure librarian view is active
  if (currentView !== 'index') toggleGraph();
  if (activeGraphTab !== 'librarian') graphTab('librarian');

  librarianChat.push({ role: 'user', content: question, ts: Date.now() });
  renderLibrarianView();

  // build grounded context: focus on entities matching the question + their 1-hop
  const lower = question.toLowerCase();
  const focused = new Set();
  for (const [id, e] of Object.entries(graph.entities)) {
    const names = [e.canonical, id, ...(e.aliases || [])];
    if (names.some(n => n && n.length > 2 && lower.includes(n.toLowerCase()))) {
      focused.add(id);
      graph.connections.filter(c => c.from === id || c.to === id).forEach(c => {
        focused.add(c.from); focused.add(c.to);
      });
    }
  }

  // if nothing matched, fall back to top-connected entities + most recent
  if (!focused.size) {
    const ids = Object.keys(graph.entities);
    const conCount = id => graph.connections.filter(c => c.from === id || c.to === id).length;
    ids.sort((a, b) => conCount(b) - conCount(a));
    ids.slice(0, 30).forEach(id => focused.add(id));
  }

  const lines = ['INDEX CONTEXT (only refer to sites and spans listed here):', ''];
  for (const id of focused) {
    const e = graph.entities[id];
    if (!e) continue;
    lines.push('Site `' + id + '` — ' + e.canonical + ' (' + e.kind + (e.subtype ? ', ' + e.subtype : '') + ')');
    if (e.hypothesis) lines.push('  hypothesis: ' + e.hypothesis);
    if (e.aliases && e.aliases.length) lines.push('  aliases: ' + e.aliases.join(', '));
    const evs = e.evaHistory || [];
    if (evs.length) lines.push('  evaluations: ' + evs.map(v => v.verdict + (v.note ? ' (' + v.note + ')' : '')).join('; '));
    const spans = (e.spans || []).slice(0, 3);
    spans.forEach(sp => lines.push('  span: "' + (sp.text || '').slice(0, 200) + '" — ' + (sp.sourceTitle || '')));
  }
  lines.push('');
  lines.push('CONNECTIONS:');
  const focusedCons = graph.connections.filter(c => focused.has(c.from) && focused.has(c.to));
  focusedCons.slice(0, 60).forEach(c => {
    const fn = graph.entities[c.from]?.canonical || c.from;
    const tn = graph.entities[c.to]?.canonical || c.to;
    lines.push('  `' + c.from + '` (' + fn + ') --[' + c.relation + ', ' + (c.confidence || '?') + ']--> `' + c.to + '` (' + tn + ')' + (c.evidence ? ' — ' + c.evidence : ''));
  });

  // include recent conversation
  const turns = [];
  const recent = librarianChat.slice(-8);
  for (const t of recent.slice(0, -1)) {
    turns.push((t.role === 'user' ? 'USER: ' : 'LIBRARIAN: ') + t.content);
  }
  turns.push('USER: ' + question);

  const userMsg = lines.join('\n') + '\n\n=== CONVERSATION ===\n' + turns.join('\n\n');

  // placeholder assistant message
  librarianChat.push({ role: 'assistant', content: '…', ts: Date.now(), pending: true });
  renderLibrarianView();

  try {
    const answer = await callClaude(LIBRARIAN_PROMPT, userMsg, 1200);
    const last = librarianChat[librarianChat.length - 1];
    last.content = answer;
    last.pending = false;
  } catch (e) {
    const last = librarianChat[librarianChat.length - 1];
    last.content = '✗ error: ' + e.message;
    last.pending = false;
  }
  renderLibrarianView();
}

function askLibrarianAbout(id) {
  const e = graph.entities[id];
  if (!e) return;
  librarianAsk('Tell me about `' + id + '` — ' + e.canonical + '. What does the index say it is, and what is it connected to?');
}
