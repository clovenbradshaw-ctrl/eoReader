// Event factories + content-addressed id computation.
// id = "sha256:" + hex(sha256(canonical_utf8(event sans id)))

import { canonicalBytes } from './canonical.js';
import { sha256Hex } from './hash.js';

export const EVENT_TYPES = ['observation', 'anchor', 'def', 'horizon'];
export const WIRE_VERSION = 1;

export async function computeId(event) {
  const { id: _drop, ...rest } = event;
  return 'sha256:' + (await sha256Hex(canonicalBytes(rest)));
}

export async function makeEvent(partial) {
  if (!EVENT_TYPES.includes(partial.type)) {
    throw new Error('unknown event type: ' + partial.type);
  }
  const event = { ...partial };
  delete event.id;
  event.id = await computeId(event);
  return event;
}

export async function verifyId(event) {
  return (await computeId(event)) === event.id;
}
