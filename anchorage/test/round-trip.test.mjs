// Phase 1 round-trip test for Anchorage wire format v1.
// Run: node anchorage/test/round-trip.test.mjs
//
// Builds a representative .eodb in memory, serializes it to JSONL bytes,
// parses it back through the strict loader, runs it through the substrate
// importer, switches σ live, and checks every step.

import { makeEvent, verifyId } from '../wire/event.js';
import { validateEvent } from '../wire/schema.js';
import { serializeLog, loadEodb } from '../wire/eodb.js';
import { buildSubstrate, projectAt } from '../wire/importer.js';

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { console.log('ok ' + (++passed) + ' - ' + name); }
  else { console.error('not ok ' + (++failed) + ' - ' + name + (detail ? ' :: ' + detail : '')); }
}

const T0 = '2026-04-24T20:22:54Z';
const T1 = '2026-04-24T20:23:00Z';
const T2 = '2026-04-24T20:24:00Z';

const ev1 = await makeEvent({
  type: 'observation',
  src: 'doc:1:cl:1',
  clause: 'The river is rising.',
  phasepost: ['report', 'environment', 'river'],
  G: 'river', F: 'is rising', P: 'rising-state',
  ts: T0,
  agent: 'anchorage:extract:v3',
  emb: { 'all-MiniLM-L6-v2': 'sha256:' + 'a'.repeat(64), 'multilingual-MiniLM-L12-v2': 'sha256:' + 'b'.repeat(64) }
});
const ev2 = await makeEvent({
  type: 'anchor',
  aid: 'ent:river-truckee',
  first_seen: 'doc:1:cl:1'
});
const ev3 = await makeEvent({
  type: 'def',
  target: 'ent:river-truckee',
  operand: { kind: 'name', value: 'Truckee River' },
  agent: 'anchorage:extract:v3',
  ts: T0
});
const ev4 = await makeEvent({
  type: 'def',
  target: 'ent:river-truckee',
  operand: { kind: 'name', value: 'Tahoe Outlet' },
  agent: 'human:curator-1',
  ts: T1
});
const ev5 = await makeEvent({ type: 'horizon', sigma: 'latest' });

const events = [ev1, ev2, ev3, ev4, ev5];

// 1. every event id matches its content
for (const e of events) ok('id matches content for ' + e.type, await verifyId(e));

// 2. every event passes its schema validator
for (const e of events) {
  const v = validateEvent(e);
  ok('schema validates ' + e.type, v.ok, v.errors.join('; '));
}

// 3. serialize + reparse round-trips losslessly with id verification
const text = serializeLog(events);
const reloaded = await loadEodb(text, { strict: true });
ok('event count round-trips', reloaded.length === events.length);
for (let i = 0; i < events.length; i++) {
  ok('event[' + i + '] (' + events[i].type + ') id stable', reloaded[i].id === events[i].id);
}

// 4. substrate import
const sub = buildSubstrate(reloaded);
ok('1 observation imported', sub.observations.length === 1);
ok('1 anchor imported', sub.anchors.has('ent:river-truckee'));
ok('def stack length 2', (sub.defStacks.get('ent:river-truckee') || []).length === 2);
ok('cell index keyed by phasepost', sub.cellIndex.has('report|environment|river'));

// 5. σ=latest projects to ev4 (the human curator's later DEF)
const proj1 = projectAt(sub, 'ent:river-truckee');
ok('σ=latest selects newest def', !!proj1 && proj1.id === ev4.id);

// 6. σ live-switch to source_priority preferring extractor over curator
const proj2 = projectAt(sub, 'ent:river-truckee', { sigma: 'source_priority', priority: ['anchorage:'] });
ok('σ=source_priority(anchorage:) selects ev3', !!proj2 && proj2.id === ev3.id);

// 7. σ live-switch to agent_priority preferring curator-1 exactly
const proj3 = projectAt(sub, 'ent:river-truckee', { sigma: 'agent_priority', priority: ['human:curator-1'] });
ok('σ=agent_priority(human:curator-1) selects ev4', !!proj3 && proj3.id === ev4.id);

// 8. σ=manual maps directly
const proj4 = projectAt(sub, 'ent:river-truckee', { sigma: 'manual', choice: { 'ent:river-truckee': ev3.id } });
ok('σ=manual selects ev3', !!proj4 && proj4.id === ev3.id);

// 9. tampering with a stored event invalidates its id check
const tampered = JSON.parse(JSON.stringify(reloaded));
tampered[0].clause = 'Different text.';
let detected = false;
try { await loadEodb(serializeLog(tampered), { strict: true }); }
catch { detected = true; }
ok('tampered event detected by strict loader', detected);

// 10. a third DEF added later collapses correctly under σ=latest
const ev6 = await makeEvent({
  type: 'def',
  target: 'ent:river-truckee',
  operand: { kind: 'name', value: 'Truckee Outflow' },
  agent: 'anchorage:extract:v3',
  ts: T2
});
sub.defStacks.get('ent:river-truckee').push(ev6);
const proj5 = projectAt(sub, 'ent:river-truckee', { sigma: 'latest' });
ok('σ=latest after late append selects ev6', !!proj5 && proj5.id === ev6.id);

// 11. canonical hash is order-independent: rewriting field order on disk does not change ids
const reordered = events.map(e => {
  const keys = Object.keys(e).sort().reverse();
  const reorderedEvent = {};
  for (const k of keys) reorderedEvent[k] = e[k];
  return reorderedEvent;
});
const reloadedReordered = await loadEodb(serializeLog(reordered), { strict: true });
let allStable = true;
for (let i = 0; i < events.length; i++) {
  if (reloadedReordered[i].id !== events[i].id) { allStable = false; break; }
}
ok('canonical hash is field-order-independent', allStable);

if (failed > 0) { console.error('\n' + failed + ' test(s) failed.'); process.exit(1); }
else { console.log('\nall ' + passed + ' tests passed.'); }
