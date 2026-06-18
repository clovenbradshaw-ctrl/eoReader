// Per-type validators for Anchorage wire format v1.
// Each returns { ok: boolean, errors: string[] }.

const ID_RE     = /^sha256:[a-f0-9]{64}$/;
const ANCHOR_RE = /^ent:[A-Za-z0-9_-]+$/;
const SRC_RE    = /^doc:[A-Za-z0-9_-]+:cl:[A-Za-z0-9_-]+$/;
const ISO_RE    = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SHA_REF   = /^sha256:[a-f0-9]{64}$/;

const SIGMAS = ['latest', 'source_priority', 'agent_priority', 'manual'];

function err(errors, msg) { errors.push(msg); }

export function validateObservation(e) {
  const errors = [];
  if (!ID_RE.test(e.id || '')) err(errors, 'observation.id must be sha256:hex');
  if (!SRC_RE.test(e.src || '')) err(errors, 'observation.src must match doc:N:cl:M');
  if (typeof e.clause !== 'string' || e.clause.length === 0) err(errors, 'observation.clause must be non-empty string');
  if (!Array.isArray(e.phasepost) || e.phasepost.length !== 3) {
    err(errors, 'observation.phasepost must be [mode, domain, object]');
  } else if (!e.phasepost.every(x => typeof x === 'string' && x.length > 0)) {
    err(errors, 'observation.phasepost entries must be non-empty strings');
  }
  for (const k of ['G', 'F', 'P']) {
    if (typeof e[k] !== 'string') err(errors, 'observation.' + k + ' must be string');
  }
  if (!ISO_RE.test(e.ts || '')) err(errors, 'observation.ts must be ISO-8601');
  if (typeof e.agent !== 'string' || e.agent.length === 0) err(errors, 'observation.agent must be non-empty string');
  if (e.emb !== undefined) {
    if (typeof e.emb !== 'object' || e.emb === null) {
      err(errors, 'observation.emb must be object {model: sha256ref}');
    } else {
      for (const [model, ref] of Object.entries(e.emb)) {
        if (typeof model !== 'string' || model.length === 0) err(errors, 'observation.emb keys must be non-empty strings');
        if (typeof ref !== 'string' || !SHA_REF.test(ref)) err(errors, 'observation.emb["' + model + '"] must be sha256:hex');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateAnchor(e) {
  const errors = [];
  if (!ID_RE.test(e.id || '')) err(errors, 'anchor.id must be sha256:hex');
  if (!ANCHOR_RE.test(e.aid || '')) err(errors, 'anchor.aid must match ent:slug');
  if (!SRC_RE.test(e.first_seen || '')) err(errors, 'anchor.first_seen must match doc:N:cl:M');
  return { ok: errors.length === 0, errors };
}

export function validateDef(e) {
  const errors = [];
  if (!ID_RE.test(e.id || '')) err(errors, 'def.id must be sha256:hex');
  if (typeof e.target !== 'string' || e.target.length === 0) err(errors, 'def.target must be non-empty string');
  if (e.operand === undefined) err(errors, 'def.operand is required');
  if (typeof e.agent !== 'string' || e.agent.length === 0) err(errors, 'def.agent must be non-empty string');
  if (!ISO_RE.test(e.ts || '')) err(errors, 'def.ts must be ISO-8601');
  return { ok: errors.length === 0, errors };
}

export function validateHorizon(e) {
  const errors = [];
  if (!ID_RE.test(e.id || '')) err(errors, 'horizon.id must be sha256:hex');
  if (!SIGMAS.includes(e.sigma)) err(errors, 'horizon.sigma must be one of: ' + SIGMAS.join('|'));
  if (e.sigma === 'source_priority' || e.sigma === 'agent_priority') {
    if (!Array.isArray(e.priority) || e.priority.length === 0) {
      err(errors, 'horizon.priority required when sigma=' + e.sigma);
    } else if (!e.priority.every(p => typeof p === 'string' && p.length > 0)) {
      err(errors, 'horizon.priority entries must be non-empty strings');
    }
  }
  if (e.sigma === 'manual') {
    if (typeof e.choice !== 'object' || e.choice === null) {
      err(errors, 'horizon.choice (target -> def_id map) required when sigma=manual');
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateEvent(e) {
  if (!e || typeof e !== 'object') return { ok: false, errors: ['event must be object'] };
  switch (e.type) {
    case 'observation': return validateObservation(e);
    case 'anchor':      return validateAnchor(e);
    case 'def':         return validateDef(e);
    case 'horizon':     return validateHorizon(e);
    default:            return { ok: false, errors: ['unknown event.type: ' + e.type] };
  }
}
