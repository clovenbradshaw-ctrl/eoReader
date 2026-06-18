// Substrate importer: builds the in-memory Given-Log structures Anchorage's
// existing UI consumes. Phasepost coordinates map directly into the existing
// internal address space; the importer is mostly wiring.
//
// Output:
//   observations: array of all observation events (in log order)
//   anchors:      Map(aid -> { aid, first_seen })
//   defStacks:    Map(target -> [defs in append order])
//   cellIndex:    Map("mode|domain|object" -> [observation refs])
//   horizon:      most recent horizon event, or default {sigma:'latest'}
//
// Schema DEFs and instance DEFs share the defStacks map. The substrate
// does not separate "schema" from "data"; the renderer subsystem decides
// how to present each DEF based on its target's role.

import { projectDef } from './horizon.js';

const DEFAULT_HORIZON = { sigma: 'latest' };

export function buildSubstrate(events) {
  const observations = [];
  const anchors = new Map();
  const defStacks = new Map();
  const cellIndex = new Map();
  let horizon = DEFAULT_HORIZON;

  for (const e of events) {
    switch (e.type) {
      case 'observation': {
        observations.push(e);
        const key = e.phasepost.join('|');
        if (!cellIndex.has(key)) cellIndex.set(key, []);
        cellIndex.get(key).push(e);
        break;
      }
      case 'anchor':
        if (!anchors.has(e.aid)) anchors.set(e.aid, { aid: e.aid, first_seen: e.first_seen });
        break;
      case 'def': {
        if (!defStacks.has(e.target)) defStacks.set(e.target, []);
        defStacks.get(e.target).push(e);
        break;
      }
      case 'horizon':
        horizon = e;
        break;
    }
  }

  return { observations, anchors, defStacks, cellIndex, horizon };
}

export function projectAt(substrate, target, horizonOverride) {
  const stack = substrate.defStacks.get(target) || [];
  return projectDef(stack, horizonOverride || substrate.horizon);
}

export function projectAll(substrate, horizonOverride) {
  const out = new Map();
  for (const target of substrate.defStacks.keys()) {
    out.set(target, projectAt(substrate, target, horizonOverride));
  }
  return out;
}

export function defStackFor(substrate, target) {
  return (substrate.defStacks.get(target) || []).slice();
}
