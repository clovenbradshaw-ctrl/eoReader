// Canonical JSON encoding for content-addressed events.
// Keys sorted lexicographically; no whitespace; UTF-8 byte output for hashing.
// Strings: NFC-normalized.
//
// The canonical encoder is used ONLY as input to the content hash. The wire
// encoding written to .eodb files is regular JSON; field order on disk does
// not affect the id.

export function canonicalString(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number not allowed in canonical encoding');
    return Number.isInteger(value) ? value.toString() : JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (Array.isArray(value)) return '[' + value.map(canonicalString).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalString(value[k])).join(',') + '}';
  }
  throw new Error('unsupported type for canonical encoding: ' + typeof value);
}

export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalString(value));
}
