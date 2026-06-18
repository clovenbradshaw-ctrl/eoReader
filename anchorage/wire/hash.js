// sha256 with browser (SubtleCrypto) and Node (node:crypto) backends.
// No deps; runs unchanged in either environment.

const isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;

async function sha256Browser(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(buf);
}

async function sha256Node(bytes) {
  const { createHash } = await import('node:crypto');
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

export async function sha256(bytes) {
  return isNode ? sha256Node(bytes) : sha256Browser(bytes);
}

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(bytes) {
  return bytesToHex(await sha256(bytes));
}
