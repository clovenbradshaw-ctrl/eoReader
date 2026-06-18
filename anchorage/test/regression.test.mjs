// Self-test for the cell-distribution regression module.
// Run: node anchorage/test/regression.test.mjs

import { distributionDelta, formatDeltaReport, cellHistogram } from '../extract/regression.js';

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) console.log('ok ' + (++passed) + ' - ' + name);
  else { console.error('not ok ' + (++failed) + ' - ' + name + (detail ? ' :: ' + detail : '')); }
}

const before = [
  { clause_id: 'c1', phasepost: ['report', 'environment', 'river'] },
  { clause_id: 'c2', phasepost: ['claim', 'politics', 'mayor'] },
  { clause_id: 'c3', phasepost: ['question', 'finance', 'budget'] },
  { clause_id: 'c4', phasepost: ['report', 'environment', 'river'] }
];
const after = [
  { clause_id: 'c1', phasepost: ['report', 'environment', 'river'] },
  { clause_id: 'c2', phasepost: ['claim', 'politics', 'mayor'] },
  { clause_id: 'c3', phasepost: ['claim', 'finance', 'budget'] },
  { clause_id: 'c4', phasepost: ['report', 'environment', 'water'] }
];

const d = distributionDelta(before, after);
ok('per-clause compared = 4', d.perClause.compared === 4);
ok('per-clause agreed = 2', d.perClause.agreed === 2);
ok('agreement = 0.5', Math.abs(d.perClause.agreement - 0.5) < 1e-9);
ok('JS divergence non-negative', d.jsDivergenceBits >= 0);

const h = cellHistogram(before);
ok('histogram counts duplicates', h.get('report|environment|river') === 2);

// Identical passes → zero divergence and 100% agreement
const d2 = distributionDelta(before, before);
ok('identical passes have agreement 1.0', Math.abs(d2.perClause.agreement - 1.0) < 1e-9);
ok('identical passes have JS divergence 0', d2.jsDivergenceBits < 1e-12);

const report = formatDeltaReport(d, { top: 5 });
ok('report contains JS divergence line', report.includes('JS divergence'));

if (failed > 0) { console.error('\n' + failed + ' test(s) failed.'); process.exit(1); }
else { console.log('\nall ' + passed + ' tests passed.'); }
