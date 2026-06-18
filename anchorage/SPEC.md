# Anchorage wire format — v1 (LOCKED)

Status: locked 2026-05-04. Changes after lock force re-extraction on every existing corpus, so they require a new wire version.

The `.eodb` file is the single artifact every Anchorage view operates over. Phasepost-addressed observations, anchors, definitions, and horizon events live in one append-only log. Embeddings are stored in content-addressed sidecar files referenced by sha256.

## File container

- Suffix: `.eodb`
- Encoding: UTF-8
- Layout: JSON Lines — one event per `\n`-terminated line.
- Append-only. New events append to the end of the file. Existing lines are never edited or removed; a correction is a new event.

## Canonical encoding (used only as input to the content hash)

Two encodings exist:

1. **Wire encoding** — the JSON written to disk on each line. Field order is not significant; pretty-printing is allowed but discouraged.
2. **Canonical encoding** — used only as input to the content hash. Defined recursively:
   - object → keys sorted lexicographically (UTF-16 code-unit order); fields whose value is `undefined` are dropped; no whitespace.
   - array → element values in order; no whitespace.
   - string → NFC-normalized, then JSON-escaped.
   - number → integer `toString` or `JSON.stringify`; non-finite numbers are rejected.
   - boolean / null → `true|false|null`.

The canonical encoding is then UTF-8 encoded for hashing.

## Event id

Every event has `id`. The id is computed over the event with the `id` field removed:

```
id = "sha256:" + lowercase_hex(SHA-256(canonical_utf8(event \ {id})))
```

Two events with identical content (after canonicalization) have the same id. The strict loader recomputes every id; mismatch is a hard error.

## Event types

Four types, period. There is no separate schema-event type. Schema commitments — "this category exists," "these are its properties," "this category is disjoint from that one" — are DEF events against anchor ids. They share the audit trail, the provenance fields, and the horizon machinery with everything else in the log.

### observation

```
{
  "id":         "sha256:...",
  "type":       "observation",
  "src":        "doc:N:cl:M",
  "clause":     "...",
  "phasepost":  [mode, domain, object],
  "G":          "...",
  "F":          "...",
  "P":          "...",
  "ts":         "ISO-8601",
  "agent":      "anchorage:extract:v3",
  "emb":        { "all-MiniLM-L6-v2": "sha256:...",
                  "multilingual-MiniLM-L12-v2": "sha256:..." }    — optional
}
```

`phasepost` carries the three Site-face coordinates. `G`/`F`/`P` carry the gestalt / form / proposition triple per clause. `emb` references embedding sidecars by content hash; if absent the substrate may compute embeddings on import.

### anchor

```
{ "id":"sha256:...", "type":"anchor", "aid":"ent:slug", "first_seen":"doc:N:cl:M" }
```

Minted at the first appearance of an entity — or of a category. Anchors are the instantiation events; later DEFs attach meaning, structure, relations, or category commitments. Same operator for instances and categories: the substrate does not privilege one over the other.

### def

```
{ "id":"sha256:...", "type":"def", "target":"...", "operand":<json>,
  "agent":"...", "ts":"ISO-8601" }
```

A definition event applied to `target` (typically an anchor id, but any addressable substrate cursor is valid). DEFs accumulate; nothing overwrites. `operand` is an arbitrary JSON value — the substrate projects the stack down to a single value via the active horizon.

Schema commitments live here. "Continuant and Occurrent are disjoint" is a DEF whose target is the relevant anchor and whose operand encodes the disjointness assertion. It is auditable, contestable, and reversible under σ the same as any other DEF. There is no privileged schema log.

### horizon

```
{ "id":"sha256:...", "type":"horizon",
  "sigma":   "latest|source_priority|agent_priority|manual",
  "priority": [...],     — when sigma=source_priority or agent_priority
  "choice":   { ... }    — when sigma=manual: target -> def_id
}
```

The most recent horizon event wins. Switching σ is live and requires no re-extraction; the importer re-projects DEF stacks on demand.

## Embedding sidecars

Embeddings are stored as opaque byte buffers — one file per (clause × model) pair, named by `sha256(bytes)`. The `.eodb` references each sidecar by `sha256:hex` only; the byte layout is per-model and not constrained by this spec. Both `all-MiniLM-L6-v2` and `multilingual-MiniLM-L12-v2` are produced per clause; if one is missing, substrate consumers fall back to whichever is present.

## σ DSL

| sigma             | priority field                  | semantics |
|-------------------|----------------------------------|-----------|
| latest            | —                                | newest by `ts` |
| source_priority   | ordered list of agent prefixes   | first DEF whose `agent` starts with a listed prefix; falls through to `latest` |
| agent_priority    | ordered list of agent strings    | first DEF whose `agent` is exactly listed; falls through to `latest` |
| manual            | `choice: target -> def_id`       | explicit per-target selection; falls through to `latest` for unmapped targets |

Because schema commitments are DEFs, σ also chooses which schema reading is foregrounded. Two analysts can author disagreeing schema DEFs; both are preserved; the active Horizon decides which is rendered. Disagreement is data, not error.

## Versioning

This spec is wire format v1. Adding a new optional field to an existing event type does not bump the version. Adding a new event type, changing the hash, or changing the canonical encoding bumps the version and forces a re-extract.
