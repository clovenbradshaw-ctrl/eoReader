// Cell-distribution regression harness.
//
// Compares two extraction passes (e.g. eoreader v2 vs anchorage v3) over the
// same corpus by binning each clause into its (mode, domain, object) cell.
// Reports per-cell deltas, per-clause agreement, and Jensen-Shannon
// divergence on the cell-share distribution.
//
// The 19k consensus corpus is supplied by the caller as an array of records:
//   { clause_id, phasepost: [mode, domain, object] }
// Both passes are matched on clause_id.

export function cellKey(phasepost) {
  return phasepost.map(s => s.toLowerCase().trim()).join('|');
}

export function cellHistogram(records) {
  const h = new Map();
  for (const r of records) {
    const key = cellKey(r.phasepost);
    h.set(key, (h.get(key) || 0) + 1);
  }
  return h;
}

export function distributionDelta(beforeRecords, afterRecords) {
  const before = cellHistogram(beforeRecords);
  const after = cellHistogram(afterRecords);
  const cells = new Set([...before.keys(), ...after.keys()]);

  const perCell = [];
  for (const key of cells) {
    const b = before.get(key) || 0;
    const a = after.get(key) || 0;
    perCell.push({ cell: key, before: b, after: a, delta: a - b });
  }
  perCell.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const beforeById = new Map(beforeRecords.map(r => [r.clause_id, r]));
  let compared = 0, agreed = 0;
  for (const r of afterRecords) {
    const prior = beforeById.get(r.clause_id);
    if (!prior) continue;
    compared++;
    if (cellKey(prior.phasepost) === cellKey(r.phasepost)) agreed++;
  }

  // Jensen-Shannon divergence in bits.
  const totalB = beforeRecords.length || 1;
  const totalA = afterRecords.length || 1;
  let js = 0;
  for (const key of cells) {
    const p = (before.get(key) || 0) / totalB;
    const q = (after.get(key) || 0) / totalA;
    const m = (p + q) / 2;
    if (p > 0) js += 0.5 * p * Math.log2(p / m);
    if (q > 0) js += 0.5 * q * Math.log2(q / m);
  }

  return {
    cells: perCell,
    cellCount: { before: before.size, after: after.size },
    perClause: {
      compared,
      agreed,
      agreement: compared > 0 ? agreed / compared : 0
    },
    jsDivergenceBits: js
  };
}

export function formatDeltaReport(delta, opts = {}) {
  const top = opts.top != null ? opts.top : 25;
  const lines = [];
  lines.push('# Anchorage v3 vs prior — cell-distribution delta');
  lines.push('');
  lines.push('cells before:  ' + delta.cellCount.before);
  lines.push('cells after:   ' + delta.cellCount.after);
  lines.push('JS divergence: ' + delta.jsDivergenceBits.toFixed(4) + ' bits');
  lines.push('per-clause agreement: ' + (delta.perClause.agreement * 100).toFixed(2) + '% (' + delta.perClause.agreed + '/' + delta.perClause.compared + ')');
  lines.push('');
  lines.push('top-' + top + ' cells by |delta|:');
  for (const c of delta.cells.slice(0, top)) {
    lines.push('  ' + c.cell.padEnd(60) + '  before=' + String(c.before).padStart(5) + '  after=' + String(c.after).padStart(5) + '  delta=' + (c.delta > 0 ? '+' : '') + c.delta);
  }
  return lines.join('\n');
}
