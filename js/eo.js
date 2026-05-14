// eo.js — .eo JSONL append-only event format.
// Each line is one event: { ev, ts, prov, hash, payload, span?, source? }.
// Optional event fields the payload may carry (round-trip preserves them
// because stripStandardFields keeps payload open and eoLineToEvent
// spreads it back): voice, voiceRelation, sourceId, bySite, verdictHash.
// Five canonical event kinds map onto the engine's operators:
//   observation -> SIG / DEF (something seen in the text)
//   anchor      -> CON       (a relationship anchored to text)
//   def         -> DEF / REC (definition deepened or revised)
//   rec         -> REC / EVA (pattern recognized, hypothesis adjusted)
//   horizon     -> SNAPSHOT  (a fold result emitted at a point in time)
// Operator -> .eo kind translation:
const EO_KIND_OF = {
  SIG: 'observation', DEF: 'def', CON: 'anchor', EVA: 'rec',
  REC: 'rec', SEG: 'def', FEEDBACK: 'rec', EDIT: 'rec', DELETE: 'rec',
};

function eventToEoLine(ev) {
  return JSON.stringify({
    ev: EO_KIND_OF[ev.op] || 'observation',
    op: ev.op,
    ts: ev.ts,
    prov: ev.provenance || 'source-attested',
    hash: ev.hash,
    payload: stripStandardFields(ev),
    span: ev.span || null,
    source: ev.source || null,
  });
}

function stripStandardFields(ev) {
  const out = { ...ev };
  delete out.ts; delete out.provenance; delete out.hash;
  delete out.span; delete out.source;
  return out;
}

function exportEoJsonl() {
  const lines = [
    JSON.stringify({ ev: 'horizon', ts: Date.now(), prov: 'system-inferred', payload: { kind: 'export-header', format: 'eo-jsonl-v1', siteCount: Object.keys(graph.entities).length, connectionCount: graph.connections.length } }),
  ];
  for (const ev of eventLog) lines.push(eventToEoLine(ev));
  const filename = 'plaintext-' + new Date().toISOString().slice(0, 10) + '.eo.jsonl';
  downloadText(lines.join('\n'), filename, 'application/x-ndjson');
}

function eoLineToEvent(line) {
  const obj = JSON.parse(line);
  if (obj.ev === 'horizon') return null; // skip snapshot markers
  const payload = obj.payload || {};
  const ev = {
    op: obj.op || (obj.ev === 'observation' ? 'SIG' : obj.ev === 'anchor' ? 'CON' : 'DEF'),
    ts: obj.ts || Date.now(),
    provenance: obj.prov || 'source-attested',
    hash: obj.hash,
    span: obj.span || null,
    source: obj.source || null,
    ...payload,
  };
  return ev;
}

async function importEoJsonl(file) {
  const text = await file.text();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const newEvents = [];
  for (const line of lines) {
    try {
      const ev = eoLineToEvent(line);
      if (ev) newEvents.push(ev);
    } catch (e) {
      console.warn('Bad .eo line:', e);
    }
  }
  // merge by hash; rehash if missing
  const seen = new Set(eventLog.map(e => e.hash));
  let added = 0;
  for (const ev of newEvents) {
    if (!ev.hash) ev.hash = hashEvent(ev);
    if (seen.has(ev.hash)) continue;
    eventLog.push(ev);
    seen.add(ev.hash);
    added++;
  }
  eventLog.sort((a, b) => a.ts - b.ts);
  refoldLive();
  saveGraph();
  renderGraphPanel();
  renderLibrary();
  showAlert('Imported ' + added + ' new events. ' + Object.keys(graph.entities).length + ' sites total.');
}

// import legacy plaintext-index-v1/v2 JSON exports as well
async function importIndexJson(file) {
  const text = await file.text();
  let obj;
  try { obj = JSON.parse(text); } catch (e) { await showAlert('Not a valid JSON file'); return; }
  if (obj.format && obj.format.startsWith('plaintext-index')) {
    // seed entities + connections; reconstruct log from them
    obj.sites.forEach(s => {
      if (graph.entities[s.id]) return;
      graph.entities[s.id] = {
        canonical: s.canonical, kind: s.terrain || s.kind || 'Entity',
        subtype: s.subtype || '', aliases: s.aliases || [],
        hypothesis: s.hypothesis || '',
        sources: s.sources || [], firstSeen: s.firstSeen,
        userNotes: s.userNotes || '',
        spans: s.spans || [],
        defHistory: (s.hypothesisEvolution || []).map(h => ({ hypothesis: h.hypothesis, span: h.span, ts: h.timestamp })),
        evaHistory: s.evaHistory || [],
        renames: s.renames || [],
      };
    });
    (obj.connections || []).forEach(c => {
      const exists = graph.connections.some(x => x.from === c.from && x.to === c.to && x.relation === c.relation);
      if (!exists) graph.connections.push({ ...c, provenance: c.provenance || 'source-attested' });
    });
    (obj.sources || []).forEach(s => {
      if (!sources.find(x => x.id === s.id || (x.url && x.url === s.url))) sources.push(s);
    });
    if (Array.isArray(obj.eventLog)) {
      const seen = new Set(eventLog.map(e => e.hash));
      obj.eventLog.forEach(ev => {
        if (!ev.hash) ev.hash = hashEvent(ev);
        if (!seen.has(ev.hash)) { eventLog.push(ev); seen.add(ev.hash); }
      });
      eventLog.sort((a, b) => a.ts - b.ts);
    } else {
      reconstructLogFromGraph();
    }
    saveGraph();
    renderGraphPanel();
    renderLibrary();
    showAlert('Imported index: ' + Object.keys(graph.entities).length + ' sites, ' + graph.connections.length + ' connections.');
    return;
  }
  showAlert('Unrecognized JSON format');
}

function importIndexFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  if (name.endsWith('.jsonl') || name.endsWith('.eo')) importEoJsonl(file);
  else importIndexJson(file);
  event.target.value = '';
}
