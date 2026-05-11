// chat.js — eoReader's hybrid chat orchestrator.
//
// What lives here (per the design plan in PR description):
//   Part 7: MODEL_BUDGETS table + clipToTokens helper
//   Part 4: Adaptive model router (probeDeviceCaps, pickModel)
//   Part 6: Multi-engine cache (in-page; full Worker isolation is a follow-up)
//   Part 2: Hybrid orchestrator — state-graph nodes (classifyIntent,
//           recentTurnsCard, retrieveSpansByEmbedding, composeChatReply,
//           runChatTurnHybrid)
//
// What lives in index.html (the host):
//   - DOM, STATE, callLLM dispatch, the existing graph-walk pipeline (now
//     `runGraphChatTurn`), embedder, append/update/render functions.
//
// The host wires us up by calling install({...ctx}) once at boot. After
// that, `window.eoChat.runChatTurnHybrid(message)` is the single entry
// point used by the chat-send click handler.

let CTX = null;  // populated by install()

// ─── Part 7: MODEL_BUDGETS ────────────────────────────────────────────
// Single source of truth for per-model input/output caps and rough
// decode throughput. Numbers assume the second call onward (first call
// pays shader-compile / download). Halved for low-tier GPUs; +50% for
// streaming backends. inputCap is "safe room" not "max model context".
export const MODEL_BUDGETS = {
  'Llama-3.2-1B-Instruct-q4f16_1-MLC':  { decodeTokPerSec: 60, inputCap: 1500, outputCap: 400, totalCtx: 2000, needsShaderF16: true  },
  'Llama-3.2-1B-Instruct-q4f32_1-MLC':  { decodeTokPerSec: 50, inputCap: 1000, outputCap: 350, totalCtx: 1400, needsShaderF16: false },
  'Llama-3.2-3B-Instruct-q4f16_1-MLC':  { decodeTokPerSec: 30, inputCap:  600, outputCap: 200, totalCtx:  800, needsShaderF16: true  },
  'Llama-3.2-3B-Instruct-q4f32_1-MLC':  { decodeTokPerSec: 25, inputCap:  400, outputCap: 175, totalCtx:  600, needsShaderF16: false },
  'Qwen2.5-3B-Instruct-q4f16_1-MLC':    { decodeTokPerSec: 30, inputCap:  600, outputCap: 200, totalCtx:  800, needsShaderF16: true  },
  'Qwen2.5-3B-Instruct-q4f32_1-MLC':    { decodeTokPerSec: 25, inputCap:  400, outputCap: 175, totalCtx:  600, needsShaderF16: false },
  'Phi-3.5-mini-instruct-q4f16_1-MLC':  { decodeTokPerSec: 25, inputCap:  400, outputCap: 150, totalCtx:  550, needsShaderF16: true  },
  'Phi-3.5-mini-instruct-q4f32_1-MLC':  { decodeTokPerSec: 18, inputCap:  300, outputCap: 125, totalCtx:  425, needsShaderF16: false },
};

const STREAMING_INPUT_MULTIPLIER = 1.5;
const LOW_TIER_CAP_MULTIPLIER = 0.5;

// 4 chars/token English-text heuristic. Cheap and good enough for budget
// gates — never used for pricing, never for hard truncation past last word.
export function approxTokens(s) {
  if (s == null) return 0;
  return Math.ceil(String(s).length / 4);
}

export function clipToTokens(text, maxTokens, opts = {}) {
  if (!text) return '';
  const max = Math.max(0, Math.floor(maxTokens) || 0);
  if (approxTokens(text) <= max) return text;
  const charBudget = max * 4;
  const head = String(text).slice(0, charBudget);
  // Don't break mid-word when possible.
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > charBudget * 0.7 ? head.slice(0, lastSpace) : head;
  return cut + (opts.suffix ?? ' …[clipped]');
}

// ─── Part 4: device capability probe + router ─────────────────────────
const ROLE_PRIORITIES = {
  classify:     ['Qwen2.5-3B-Instruct-q4f16_1-MLC', 'Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Llama-3.2-1B-Instruct-q4f32_1-MLC'],
  chat:         ['Llama-3.2-3B-Instruct-q4f16_1-MLC', 'Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Llama-3.2-1B-Instruct-q4f32_1-MLC'],
  plan_compile: ['Qwen2.5-3B-Instruct-q4f16_1-MLC', 'Qwen2.5-3B-Instruct-q4f32_1-MLC', 'Llama-3.2-1B-Instruct-q4f16_1-MLC'],
  polish:       ['Llama-3.2-3B-Instruct-q4f16_1-MLC', 'Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Llama-3.2-1B-Instruct-q4f32_1-MLC'],
  summarize:    ['Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Llama-3.2-1B-Instruct-q4f32_1-MLC'],
};

function inferGpuTier(vendor, memGB, isMobile) {
  if (isMobile) return 'low';
  const v = String(vendor || '').toLowerCase();
  if (/(nvidia|apple|amd|radeon)/.test(v) && memGB >= 6) return 'high';
  if (/(intel|adreno|mali|qualcomm)/.test(v)) return 'low';
  return 'mid';
}

export async function probeDeviceCaps() {
  const caps = {
    shaderF16: false,
    gpuVendor: 'unknown',
    gpuTier: 'mid',
    cores: navigator.hardwareConcurrency || 4,
    memGB: navigator.deviceMemory || 4,
    isMobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
    measuredTokPerSec: null,
    probedAt: Date.now(),
  };
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        caps.shaderF16 = adapter.features?.has?.('shader-f16') || false;
        caps.gpuVendor = (adapter.info && adapter.info.vendor) || 'unknown';
      }
    }
  } catch {/* WebGPU unavailable — keep defaults */}
  caps.gpuTier = inferGpuTier(caps.gpuVendor, caps.memGB, caps.isMobile);
  if (caps.memGB < 3) caps.gpuTier = 'low';
  return caps;
}

// Pick the best model for (role, promptTokens, deviceCaps, policy).
// Returns { modelId, inputCap, outputCap, downshifted: bool } or null
// when no candidate is usable (e.g. promptTokens > every cap).
export function pickModel({ role, promptTokens, caps, policy = 'auto', metrics = {}, streaming = false }) {
  const tier = caps?.gpuTier || 'mid';
  const f16ok = !!caps?.shaderF16;

  // Direct pin: policy is a model id.
  let candidates;
  if (policy && MODEL_BUDGETS[policy]) {
    candidates = [policy];
  } else {
    candidates = ROLE_PRIORITIES[role] || ROLE_PRIORITIES.chat;
    if (policy === 'fast') {
      // Prefer 1B variants regardless of role.
      candidates = candidates.filter(id => /-1B-/.test(id)).concat(candidates);
    } else if (policy === 'quality') {
      // Prefer 3B/Phi variants when device allows.
      const heavy = candidates.filter(id => /-3B-|Phi-/.test(id));
      candidates = heavy.concat(candidates);
    }
  }

  for (const modelId of candidates) {
    const b = MODEL_BUDGETS[modelId];
    if (!b) continue;
    if (b.needsShaderF16 && !f16ok) continue;
    if (tier === 'low' && /-3B-|Phi-/.test(modelId)) continue;
    // Apply streaming bonus / low-tier penalty
    let inputCap = b.inputCap;
    let outputCap = b.outputCap;
    if (tier === 'low') { inputCap *= LOW_TIER_CAP_MULTIPLIER; outputCap *= LOW_TIER_CAP_MULTIPLIER; }
    if (streaming) inputCap *= STREAMING_INPUT_MULTIPLIER;
    inputCap = Math.floor(inputCap);
    outputCap = Math.floor(outputCap);
    // Throughput-feedback downshift: if measured tok/s < 60% of table, skip.
    const m = metrics[modelId];
    if (m && m.samples >= 3 && m.avgTokPerSec < b.decodeTokPerSec * 0.6) continue;
    if (promptTokens > inputCap) continue;
    return { modelId, inputCap, outputCap, downshifted: candidates.indexOf(modelId) > 0 };
  }
  // Last-resort floor — pick the smallest q4f32 model regardless of fit.
  const floor = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';
  const fb = MODEL_BUDGETS[floor];
  return { modelId: floor, inputCap: fb.inputCap, outputCap: fb.outputCap, downshifted: true };
}

// ─── Part 6: multi-engine cache ───────────────────────────────────────
// In-page WebLLM engines keyed by modelId. Each role gets its preferred
// model lazily. Worker-per-model isolation (true VRAM isolation) is a
// follow-up — for now multiple engines share one WebGPU context, which
// is fine for two small models on a mid-tier GPU.

const ENGINES = new Map();      // modelId -> { engine, lastUsedAt, loading }
const LOAD_PROMISES = new Map();

export async function getEngine(modelId, { progress } = {}) {
  if (ENGINES.has(modelId)) {
    const slot = ENGINES.get(modelId);
    slot.lastUsedAt = Date.now();
    return slot.engine;
  }
  if (LOAD_PROMISES.has(modelId)) return LOAD_PROMISES.get(modelId);
  const p = (async () => {
    if (!CTX || !CTX.loadWebLLMModel) {
      throw new Error('chat.js getEngine: host did not provide loadWebLLMModel()');
    }
    const engine = await CTX.loadWebLLMModel(modelId, progress);
    ENGINES.set(modelId, { engine, lastUsedAt: Date.now() });
    LOAD_PROMISES.delete(modelId);
    return engine;
  })();
  LOAD_PROMISES.set(modelId, p);
  return p;
}

export function knownEngines() {
  return [...ENGINES.keys()];
}

// ─── Part 2: state-graph node helpers ─────────────────────────────────

export function recentTurnsCard(n = 2, perTurnChars = 240) {
  const turns = (CTX?.getChatTurns?.() || []).slice(-n);
  if (!turns.length) return '';
  const lines = ['Recent turns:'];
  for (const t of turns) {
    const q = (t.question || '').slice(0, 160);
    let a;
    if (t.summary)        a = String(t.summary).slice(0, perTurnChars);
    else if (t.answerText) a = String(t.answerText).slice(0, perTurnChars);
    else if (t.answer)    a = stripHtml(t.answer).slice(0, perTurnChars);
    else                  a = '(pending)';
    lines.push(`Q: ${q}`);
    lines.push(`A: ${a}`);
  }
  return lines.join('\n');
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Light vocab card — entity canonicals only, no aliases. Cheaper than
// the full buildVocabCard() the plan compiler uses.
export function vocabCardLight(maxEntities = 16) {
  if (!CTX?.STATE?.entities) return '';
  const items = [];
  for (const [id, info] of CTX.STATE.entities) {
    if (CTX.isEntityActive && !CTX.isEntityActive(id)) continue;
    items.push(info.canonical);
    if (items.length >= maxEntities) break;
  }
  if (!items.length) return '';
  return 'Known entities: ' + items.join(', ');
}

// Span retrieval. The plan calls for span-level vectors with optional
// reranker; we fall back to the existing entity centroids + their best
// spans as the floor (per plan's "fallback to entity centroids" note).
export async function retrieveSpansByEmbedding(message, k = 5) {
  if (!CTX?.resolveEntitiesByEmbedding || !CTX?.getSpansForEntity) return [];
  let cands;
  try {
    cands = await CTX.resolveEntitiesByEmbedding(message, Math.max(k, 3));
  } catch { return []; }
  if (!cands?.length) return [];
  const out = [];
  for (const c of cands) {
    const spans = (CTX.getSpansForEntity(c.id) || []).slice(0, 2);
    for (const s of spans) {
      const text = String(s.text || s.spanText || '').slice(0, 220);
      if (!text) continue;
      out.push({
        spanText: text,
        entityId: c.id,
        entityName: c.info?.canonical || c.id,
        sourceId: s.sourceId || null,
        score: c.score,
      });
      if (out.length >= k) return out;
    }
  }
  return out;
}

function spansCardFromList(spans) {
  if (!spans?.length) return '';
  const lines = ['Relevant spans from the corpus:'];
  for (const s of spans) {
    lines.push(`- [${s.entityName}] ${s.spanText}`);
  }
  return lines.join('\n');
}

// ─── classifyIntent ───────────────────────────────────────────────────
// Returns { kind, needs_graph, confidence, reason, source: 'llm'|'heuristic' }.
const CLASSIFY_SYSTEM = `You are a chat-intent classifier for a corpus-grounded assistant. Output ONE JSON object — no prose, no fences.

Schema:
{"kind":"chat|meta|clarify|overview|portrait|relation_probe|attribute_probe|search","needs_graph":true|false,"confidence":0.0,"reason":"<<=12 words>"}

Rules:
- kind="chat" for casual conversation / greeting / opinion / smalltalk → needs_graph=false.
- kind="meta" for "summarize that", "what did you mean", "in two sentences" → needs_graph=false.
- kind="clarify" if the user's last message is a question about a previous turn → needs_graph=false.
- kind="overview" if the user wants a corpus summary → needs_graph=true.
- kind="portrait" for "tell me about <X>" / "who is X" → needs_graph=true.
- kind="relation_probe" for "who/what did X V" → needs_graph=true.
- kind="attribute_probe" for "how is X V" → needs_graph=true.
- kind="search" for keyword lookups → needs_graph=true.
- confidence is your self-rated 0–1 belief in this classification.`;

const HEURISTIC_GRAPH_RE = /\b(who|what|where|when|how|which|tell me about|summarize|summary|overview|relate|connect|relationship|how many|list|find)\b/i;
const META_RE = /\b(summarize that|in two sentences|what did you mean|rephrase|simpler|tldr|tl;dr|recap)\b/i;

function heuristicClassify(message) {
  const m = String(message || '');
  if (META_RE.test(m)) return { kind: 'meta', needs_graph: false, confidence: 0.55, reason: 'meta phrasing', source: 'heuristic' };
  if (m.length < 30 && !HEURISTIC_GRAPH_RE.test(m)) {
    return { kind: 'chat', needs_graph: false, confidence: 0.4, reason: 'short, no question word', source: 'heuristic' };
  }
  if (HEURISTIC_GRAPH_RE.test(m)) {
    return { kind: 'search', needs_graph: true, confidence: 0.45, reason: 'question-like', source: 'heuristic' };
  }
  return { kind: 'chat', needs_graph: false, confidence: 0.4, reason: 'default', source: 'heuristic' };
}

export async function classifyIntent(message, recentTurnsTxt = '') {
  if (!CTX?.callLLM || !CTX?.isLLMReady?.()) return heuristicClassify(message);

  const userMsg = (recentTurnsTxt ? `${recentTurnsTxt}\n\n` : '') +
                  `User just said:\n${clipToTokens(message, 200, { suffix: '…' })}\n\nReturn the JSON object only.`;
  let raw;
  try {
    raw = await CTX.callLLM(CLASSIFY_SYSTEM, userMsg, { role: 'classify', maxTokens: 80 });
  } catch (e) {
    if (CTX.log) CTX.log('classifyIntent LLM error', e?.message);
    return heuristicClassify(message);
  }
  const parsed = parseFirstJson(raw);
  if (!parsed) return heuristicClassify(message);
  const validKinds = new Set(['chat','meta','clarify','overview','portrait','relation_probe','attribute_probe','search']);
  if (!validKinds.has(parsed.kind)) return heuristicClassify(message);
  return {
    kind: parsed.kind,
    needs_graph: parsed.kind !== 'chat' && parsed.kind !== 'meta' && parsed.kind !== 'clarify' && parsed.needs_graph !== false,
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 80) : '',
    source: 'llm',
  };
}

function parseFirstJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      if (--depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ─── composeChatReply ─────────────────────────────────────────────────
const CHAT_SYSTEM = `You are eoReader's chat. The user has a corpus loaded and the system has a typed knowledge graph over it. Answer briefly and conversationally. If the question would need structured graph data you can't see, say so plainly — the system will walk the graph for follow-up turns when needed. Don't invent corpus facts; if a fact isn't in the spans you were shown, say you don't know.`;

export async function composeChatReply({ message, classifier, recentTurnsTxt, vocabTxt, spansTxt }) {
  if (!CTX?.callLLM || !CTX?.isLLMReady?.()) {
    return {
      text: "I can chat — but no LLM backend is available right now. Configure one in settings, or ask a structural question and I'll walk the graph instead.",
      modelUsed: null,
    };
  }
  const sys = CHAT_SYSTEM;
  // Build the user message inside a budget of ~1000 input tokens total.
  const parts = [];
  if (recentTurnsTxt) parts.push(clipToTokens(recentTurnsTxt, 200));
  if (classifier?.kind !== 'meta' && spansTxt) parts.push(clipToTokens(spansTxt, 300));
  if (vocabTxt) parts.push(clipToTokens(vocabTxt, 180));
  parts.push(`User: ${clipToTokens(message, 200, { suffix: ' …[truncated]' })}`);
  const userMsg = parts.filter(Boolean).join('\n\n');

  let text;
  try {
    text = await CTX.callLLM(sys, userMsg, { role: 'chat', maxTokens: 350 });
  } catch (e) {
    return { text: `I hit an error talking to the model: ${e?.message || e}`, modelUsed: null, error: true };
  }
  return { text: (text || '').trim(), modelUsed: 'chat' };
}

// ─── runChatTurnHybrid — the orchestrator ─────────────────────────────
// Returns a "turn" shape compatible with the existing transcript renderer:
//   { turnId, question, cursor, framing, compiled, plans, answer, summary,
//     pending_disambiguation, usedCompiler, timestamp,
//     route, classifier, evidenceSpans, modelUsed }
//
// Behaviour:
//   - All non-LLM views (recent turns, vocab card, span retrieval) run in
//     parallel with the classifier LLM call.
//   - Confidence < 0.55 → safe-default to 'chat' route.
//   - If route is 'chat'/'meta'/'clarify': compose conversational reply.
//   - Otherwise: defer to the host's runGraphChatTurn (existing pipeline).
export async function runChatTurnHybrid(message, opts = {}) {
  const turnId = 'turn-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
  const t0 = Date.now();

  const recentTurnsTxt = recentTurnsCard(2, 220);

  // Step 1: parallel reads. The classifier LLM call runs in parallel with
  // no-LLM memory views (span retrieval, vocab card). We deliberately
  // don't await onClassifier — it's a UI hint, fire-and-forget.
  const classifierPromise = classifyIntent(message, recentTurnsTxt).then(c => {
    try { opts.onClassifier?.(c); } catch (e) { CTX?.log?.('onClassifier hook threw', e?.message); }
    return c;
  });
  const [classifier, spans, vocabTxt] = await Promise.all([
    classifierPromise,
    retrieveSpansByEmbedding(message, 5).catch(() => []),
    Promise.resolve(vocabCardLight(16)),
  ]);

  // Step 2: gate. Low confidence → safe default to 'chat' route.
  let route;
  let lowConfidence = false;
  if (classifier.confidence < 0.55) {
    route = 'chat';
    lowConfidence = true;
  } else if (classifier.needs_graph) {
    route = classifier.kind;  // overview / portrait / relation_probe / attribute_probe / search
  } else {
    route = 'chat';  // chat / meta / clarify
  }
  // Re-fire the hint with the resolved route so the UI can swap pending
  // text accurately even if confidence overrode needs_graph.
  try { opts.onClassifier?.({ ...classifier, resolvedRoute: route, lowConfidence }); } catch {}

  const spansTxt = spansCardFromList(spans);

  // Step 3: branch.
  if (route === 'chat' || route === 'meta' || route === 'clarify') {
    const reply = await composeChatReply({ message, classifier, recentTurnsTxt, vocabTxt, spansTxt });
    return {
      turnId,
      question: message,
      cursor: opts.cursor ?? CTX?.STATE?.activeCursor ?? null,
      framing: opts.framing ?? CTX?.STATE?.activeFraming ?? 'uniform',
      compiled: null,
      plans: [],
      // Wrap reply in the same template wrapper the renderer uses.
      // The LLM emits light markdown (**bold**, bullets, headings); render
      // it to HTML so it doesn't show up as raw asterisks in the transcript.
      answer: `<div class="templated chat-reply">${formatMarkdown(reply.text)}${lowConfidence ? '<p class="muted">(low classifier confidence — replied conversationally)</p>' : ''}</div>`,
      answerText: reply.text,
      summary: null,
      summaryWarning: null,
      pending_disambiguation: false,
      usedCompiler: false,
      timestamp: Date.now(),
      route,
      classifier,
      evidenceSpans: spans,
      modelUsed: reply.modelUsed,
      latencyMs: Date.now() - t0,
    };
  }

  // Graph branch — defer to host.
  if (!CTX?.runGraphChatTurn) {
    return {
      turnId, question: message, compiled: null, plans: [],
      answer: '<p class="templated">Graph backend missing — host did not provide runGraphChatTurn.</p>',
      timestamp: Date.now(), route, classifier, evidenceSpans: spans, latencyMs: Date.now() - t0,
    };
  }
  const graphTurn = await CTX.runGraphChatTurn(message, opts.cursor ?? CTX?.STATE?.activeCursor, opts.framing ?? CTX?.STATE?.activeFraming, opts);
  // Decorate with hybrid metadata.
  graphTurn.route = route;
  graphTurn.classifier = classifier;
  graphTurn.evidenceSpans = spans;
  graphTurn.latencyMs = Date.now() - t0;
  return graphTurn;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Minimal markdown → HTML for chat replies. Escapes first, then transforms
// bold, italic, inline code, headings, and bullet lists. Block-aware: blank
// lines separate paragraphs; a run of `- ` / `* ` lines becomes a <ul>.
function inlineMd(s) {
  return s
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+?)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+?)`/g, '<code>$1</code>');
}

function formatMarkdown(src) {
  if (!src) return '';
  const text = escapeHtml(String(src).replace(/\r\n/g, '\n'));
  const lines = text.split('\n');
  const out = [];
  let para = [];
  let list = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inlineMd(para.join(' ')) + '</p>'); para = []; }
  };
  const flushList = () => {
    if (list.length) { out.push('<ul>' + list.map(li => '<li>' + inlineMd(li) + '</li>').join('') + '</ul>'); list = []; }
  };
  const bulletRe = /^\s*[-*]\s+(.+)$/;
  const headingRe = /^(#{1,6})\s+(.+)$/;
  for (const line of lines) {
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const m = line.match(bulletRe);
    if (m) { flushPara(); list.push(m[1]); continue; }
    const h = line.match(headingRe);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); continue; }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('');
}

// ─── install / boot ───────────────────────────────────────────────────
// Host calls this once at boot with the bridge object. Required keys:
//   STATE                — read-only access to STATE.entities, activeCursor, etc.
//   isLLMReady()
//   callLLM(sys, user, { role, maxTokens, opts })
//   isEntityActive(id)
//   resolveEntitiesByEmbedding(text, k)
//   getSpansForEntity(id)              — returns [{text, sourceId}, ...]
//   getChatTurns()                     — returns CHAT_TURNS array
//   runGraphChatTurn(message, cursor, framing, opts)
//   loadWebLLMModel(modelId, progress) — used by getEngine cache
//   log?(msg, ...args)                 — optional debug sink
export function install(ctx) {
  CTX = ctx;
}

// Convenience accessors for host-side code that wants to introspect.
export function getCtx() { return CTX; }

// Public API surfaces a stable namespace.
const api = {
  install,
  runChatTurnHybrid,
  classifyIntent,
  composeChatReply,
  retrieveSpansByEmbedding,
  recentTurnsCard,
  vocabCardLight,
  pickModel,
  probeDeviceCaps,
  getEngine,
  knownEngines,
  clipToTokens,
  approxTokens,
  MODEL_BUDGETS,
};

if (typeof window !== 'undefined') window.eoChat = api;
export default api;
