// .eodb is JSONL: one wire-encoded event per line, UTF-8, append-only.
// In-memory representation is a flat array.

import { validateEvent } from './schema.js';
import { computeId } from './event.js';

export function serializeEvent(event) {
  return JSON.stringify(event);
}

export function serializeLog(events) {
  return events.map(serializeEvent).join('\n') + (events.length ? '\n' : '');
}

export function parseLog(text) {
  const lines = text.split('\n').filter(l => l.length > 0);
  return lines.map((line, i) => {
    try { return JSON.parse(line); }
    catch (e) { throw new Error('line ' + (i + 1) + ': invalid JSON: ' + e.message); }
  });
}

export async function loadEodb(text, { strict = true } = {}) {
  const events = parseLog(text);
  if (!strict) return events;
  for (let i = 0; i < events.length; i++) {
    const v = validateEvent(events[i]);
    if (!v.ok) throw new Error('event ' + (i + 1) + ' (' + (events[i].type || '?') + '): ' + v.errors.join('; '));
    const expected = await computeId(events[i]);
    if (expected !== events[i].id) {
      throw new Error('event ' + (i + 1) + ' id mismatch: stored=' + events[i].id + ' computed=' + expected);
    }
  }
  return events;
}

export async function appendEvent(events, event) {
  const v = validateEvent(event);
  if (!v.ok) throw new Error(v.errors.join('; '));
  const expected = await computeId(event);
  if (expected !== event.id) throw new Error('appendEvent: id ' + event.id + ' != content hash ' + expected);
  events.push(event);
  return events;
}
