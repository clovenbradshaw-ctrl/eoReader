# Anchorage

Phasepost-addressed observation logs with editable definitions and pluggable upper-ontology renderers. Combines the existing Anchorage browser tool with the eoreader extraction pipeline. Product spec: `build.md`. Wire format: `anchorage/SPEC.md` (locked v1).

## Layout

```
anchorage/
  SPEC.md              — wire format v1 (locked)
  wire/
    canonical.js       — canonical JSON (sorted keys, NFC, no whitespace)
    hash.js            — sha256 (browser SubtleCrypto + node:crypto)
    event.js           — event factories + content-addressed id
    schema.js          — per-type validators
    eodb.js            — JSONL log reader/writer + strict loader
    horizon.js         — σ DSL projection (4 cases)
    importer.js        — substrate importer
    index.js           — barrel
  extract/
    prompt.js          — anchorage:extract:v3 prompt (G, F, P, phasepost)
    regression.js      — cell-distribution delta + JS divergence
  test/
    round-trip.test.mjs   — Phase 1 round-trip (extraction → .eodb → substrate)
    regression.test.mjs   — regression-stats self-test
    run.html              — browser test runner
```

## Run tests (Node)

```
node anchorage/test/round-trip.test.mjs
node anchorage/test/regression.test.mjs
```

## Run tests (browser)

Serve the repo root and open `anchorage/test/run.html`.

## Phase 2 — regression on the 19k corpus

The regression module ingests two arrays of `{clause_id, phasepost}` records — one for the prior eoreader v2 pass and one for the new anchorage:extract:v3 pass — and reports per-cell deltas, per-clause agreement, and JS divergence on the cell-share distribution.

```js
import { extractClause } from './extract/prompt.js';
import { distributionDelta, formatDeltaReport } from './extract/regression.js';

const v3 = [];
for (const c of corpus19k) {
  const out = await extractClause(client, c.text);
  v3.push({ clause_id: c.clause_id, phasepost: out.phasepost });
}
const delta = distributionDelta(priorV2, v3);
console.log(formatDeltaReport(delta, { top: 50 }));
```

`client` is repository-supplied: in proveo it routes through the existing fold/segment workers; in eoreader it routes through Transformers.js. The prompt and parser are shared.

## Note on schema

Schema commitments are DEF events against anchor ids — same log, same audit trail, same σ. There is no separate ontology authoring path. A renderer (BFO, schema.org) is a function from the populated capacity ground to a target format; it does not author categories, it projects them. See `SPEC.md` § "Event types".
