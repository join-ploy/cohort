# Generic HTTP Endpoint Trigger — Design

**Status:** Implemented.
**Date:** 2026-06-06

## Goal

Add a generic **HTTP endpoint** trigger source so any automation can be driven by an
arbitrary polled API, without bespoke per-integration code. The user configures a
request (URL, method, headers, query, body), clicks **Test** to fetch a live sample,
and we auto-derive the downstream trigger variables from that sample. The same saved
endpoint definition powers two **independently toggleable** capabilities:

- **Polling** — the existing `AutoTriggerEngine` polls the endpoint on a per-trigger
  interval and fires a run for each *new* item (deduped on chosen fields), gated so the
  item's chosen date field is later than the trigger's enable time, optionally filtered
  by condition rules.
- **Manual** — the automation appears in Run Now; at run time we fetch the list, the
  operator picks one item, and that item resolves the downstream variables.

This slots into the auto-trigger framework from
`2026-05-22-auto-triggers-design.md` rather than living beside it: a new
`TriggerSourceId` (`'http-endpoint'`), reusing the `Rule` / `Condition` model, the
`AutoTriggerEngine`, the dedup store, the `enabledAt` watermark, and the
`trigger.<source>.*` template namespace.

## What's new vs. the existing trigger sources

`linear-issue` / `github-pr` are **global singletons** with a **static** `fieldCatalog`
and credentials shared app-wide (the Linear token, the GitHub auth). The HTTP source
differs on three axes, and those differences are the whole design:

1. **Per-automation config.** URL, auth, mapping, dedupe/date-gate/interval all live on
   the trigger, not on a registered singleton.
2. **Dynamic field catalog.** The catalog is *derived from a saved Test sample* and
   stored on the trigger, so the condition / dedupe / date-gate pickers and the
   downstream variable panel all read from a persisted snapshot — no live call to edit.
3. **Per-trigger encrypted credentials.** Header/query/body secrets are encrypted at
   rest with the existing `safeStorage` path, scoped to the trigger.

## Key shape

- A trigger of source `'http-endpoint'` carries an `HttpEndpointConfig` plus two
  independent booleans: `pollingEnabled` and `manualEnabled`. Either, both, or (briefly,
  while editing) neither may be on. Both on = the endpoint auto-fires on new items *and*
  can be manually invoked against the same definition.
- The poll-only fields (`dedupeFields`, `dateGateField`, `intervalMs`) apply only to
  polling; the manual-only fields (`labelField`, `subtitleField`) apply only to manual.
- `Rule` conditions and `projectId` targeting are **shared and reused** — conditions
  evaluate against the mapped fields; each rule targets a project. For manual mode,
  conditions *pre-filter* the picker list (with a show-all escape hatch); polling uses
  them as hard match gates (first match wins, as today).
- **Test persists the keys.** The mapped variable names + dot-paths + inferred types +
  sample values, the chosen `itemsPath`, and the `sampleResponse` are saved on the
  trigger and become the single source of truth for "what variables exist."

## Out of scope (this phase)

- **Pagination / cursors.** v1 reads a single response page. A `maxItemsPerPoll` bound
  caps how many items one poll dispatches; if exceeded we log what was dropped (no silent
  truncation).
- **OAuth flows / token refresh.** Static header/query/body secrets only. The user
  supplies whatever bearer/key the API needs.
- **GraphQL-aware helpers.** POST + raw JSON body covers GraphQL mechanically; we don't
  build a query builder.
- **Response transforms / scripting.** Mapping is path-based flatten only; no JS hooks,
  no JSONata.
- **Webhooks / push.** Polling only, consistent with the existing framework's rationale.
- **Re-mapping migration.** If an endpoint's shape drifts, we warn but don't auto-migrate
  variable references.

## Data model

Shared types extend `src/shared/automations-types.ts`.

```ts
export type TriggerSourceId = 'linear-issue' | 'github-pr' | 'http-endpoint' // open union

export type AutoTrigger = {
  id: string
  source: TriggerSourceId
  enabled: boolean
  enabledAt: number                 // ms epoch; the date-gate / backfill watermark
  rules: Rule[]
  repoIds?: string[]                // existing (github-pr)
  http?: HttpEndpointConfig         // NEW — present iff source === 'http-endpoint'
  pollingEnabled?: boolean          // NEW — http only; default true
  manualEnabled?: boolean           // NEW — http only; default false
}

export type HttpEndpointConfig = {
  request: HttpRequestConfig
  itemsPath: string | null          // dot-path to the items array; null = whole body is one item
  fields: MappedField[]             // derived from Test; the persisted variable catalog
  sampleResponse?: unknown          // last Test response, for dry-run + variable panel
  // poll-only:
  dedupeFields: string[]            // dot-paths composing the dedup key
  dateGateField: string | null      // dot-path to the date used as the gate / watermark
  intervalMs?: number               // per-trigger poll cadence; falls back to global
  maxItemsPerPoll?: number          // safety bound; default e.g. 100
  // manual-only:
  labelField?: string               // dot-path shown as the picker's primary label
  subtitleField?: string            // dot-path shown as the picker's secondary line
}

export type HttpRequestConfig = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  headers: HttpKeyValue[]
  query: HttpKeyValue[]
  body?: string                     // raw string (usually JSON); optional
}

// A key/value pair whose value MAY be a secret. When secret, plaintext never
// leaves main: `value` holds ciphertext and `secret` is true.
export type HttpKeyValue = {
  key: string
  value: string                     // plaintext for non-secret; ciphertext when secret
  secret?: boolean
}

export type MappedField = {
  path: string                      // dot-path into an item, e.g. 'author.name', 'labels[0].name'
  variableName: string              // exposed as trigger.http.<variableName>; defaults from path
  enabled: boolean                  // unticked = discovered but not exposed
  type: 'string' | 'number' | 'boolean' | 'date' | 'null' | 'unknown'
  sampleValue: unknown              // captured at Test time; used for hints + dry-run preview
}
```

`AutomationRun` reuses the existing trigger-provenance fields (`triggerSource`,
`triggerAutoTriggerId`, `triggerRuleId`, `triggerEntityId`). For HTTP, `triggerEntityId`
is the composite dedup key (poll) or a manual marker (manual pick).

### Persistence

- `automations.autoTriggers` already a JSON blob — additive; `http` / `pollingEnabled` /
  `manualEnabled` ride along.
- **Secrets** encrypted via `encrypt()` / `decrypt()` in `src/main/persistence.ts`
  (`safeStorage`, base64), same path as the Linear token. Only `HttpKeyValue` values with
  `secret: true` and a secret body are ciphertext at rest.
- Dedup reuses the existing `automation_auto_dedup` table keyed
  `(automationId, autoTriggerId, sourceId, entityId)`.
- Per-trigger `lastPolledAt` extends the engine's existing per-source poll-status map to
  per-trigger granularity for HTTP (so per-trigger intervals can be honored).

### Migration

Additive only. Existing automations load unchanged.

## The Test / Resolve flow (editor heart)

A `httpEndpoint:test` IPC handler (main) performs the configured request with **decrypted**
secrets and returns `{ status, durationMs, body }` — request secrets are **never** echoed
back. On success the renderer:

1. **Auto-detects candidate arrays** in `body` and shows an "Items are here" dropdown:
   each detected array path with its length (top-level `[]`, `data`, `results`,
   `data.items`, …), defaulting to the largest. Plus a **"Whole response is a single
   item"** choice (object case) and a **manual dot-path override** for exotic shapes.
   This is the "flexible mapping" requirement.
2. Takes the **first item** of the chosen array (or the whole body), **flattens to
   dot-paths** (`id`, `author.name`, `labels[0].name`), and **infers a type** per leaf,
   parsing date-looking values (ISO 8601 and numeric epoch s/ms).
3. Renders the **mapping menu**: a checklist where every leaf is exposed as
   `trigger.http.<path>` by default. Each row shows the sample value, an include
   checkbox, and an editable variable name.
4. **Persists** `itemsPath`, `fields[]`, and `sampleResponse` on the trigger. The
   dedupe / date-gate / condition pickers and the variable panel all read this snapshot.
   The Test result surfaces the **parsed date** for the chosen date-gate field so the
   user can confirm it resolves.

## Polling-mode behavior

When `pollingEnabled`, the trigger joins the `AutoTriggerEngine` tick loop
(`src/main/automations/auto-trigger-engine.ts`).

- **Per-trigger interval.** The engine tracks `lastPolledAt` per HTTP trigger and only
  polls when `now - lastPolledAt >= intervalMs` (falling back to the global cadence).
- **`poll(ctx)` for `http-endpoint`** fetches the request, locates the array via
  `itemsPath`, and yields one `CandidateEvent` per item (capped at `maxItemsPerPoll`):
  - `entityId` ← composite **dedup key** from `dedupeFields` (joined + hashed).
  - `updatedAt` ← parsed **date-gate field** (or poll time if none).
  - `fields` ← mapped variables, so the existing `Rule` / `Condition` matcher runs
    unchanged.
  - `payload` ← the raw item, for building `trigger.http.*`.
- **Date gate.** An item fires only if its date-gate field parses to a time **strictly
  later than `enabledAt`** — exactly the existing watermark semantics; historical items
  never backfill. A missing/unparseable date-gate value **fails closed** (won't fire) and
  is flagged in poll status.
- **Dedup.** Reuses `automation_auto_dedup`; an item fires **once**, restart-safe.
- **Conditions.** Each `Rule`'s conditions evaluate against `fields`; an item fires
  (targeting that rule's `projectId`) only on **dedup AND date-gate AND conditions**.
  One run per qualifying item.
- **Failures.** Non-2xx or unreachable logs a poll error, advances `lastPolledAt`,
  dispatches nothing, leaves the dedup store clean — auto-recovers when healthy.

## Manual-mode behavior

When `manualEnabled`, the automation appears in Run Now with a run-time picker.

- Run Now calls `httpEndpoint:fetchItems` (main, decrypted secrets), which performs the
  request and returns the located array mapped through `fields[]` as
  `{ id, label, subtitle, variables, rawItem }[]`.
- The renderer shows a **picker dialog**: `labelField` as the primary label (default:
  first string-typed mapped field), `subtitleField` (default: the date-gate field) as a
  secondary line, and a search box for long lists.
- If the trigger has `Rule` conditions, they **pre-filter** the list by default with a
  **"show all"** escape hatch — manual selection is the final say.
- On pick, the item's mapped variables resolve into `run.context.trigger.http.*` exactly
  as a polled run would, dispatching against the rule/automation `projectId`.
- **Dedup and date-gate do NOT apply** to a manual pick — the operator explicitly chose
  the item, so we honor it even if old or previously seen.
- Reuses the existing manual plumbing (`TriggerConfig` / `automations:runNow`); the HTTP
  picker is an added run-time step before dispatch, analogous to the Linear-ticket /
  project pickers.

## Downstream variables & template integration

- Mapped keys surface as **`trigger.http.<variableName>`**, same namespace system as the
  existing sources.
- **`AvailableVariablesPanel`** gains an `http` branch built from the trigger's saved
  `fields[]`, showing each variable with its sample value as a hint, insertable into any
  step.
- **Template dry-run** (`src/renderer/src/lib/template-dry-run.ts`) validates
  `{{trigger.http.*}}` against the saved keys, flagging typos at edit time and rendering a
  realistic preview from `sampleValue`.
- At runtime, `buildTriggerContext()` (`service.ts`) populates `run.context.trigger.http`
  from the actual polled/picked item, keyed by the same variable names — so the sample
  value seen while building and the real value at run time occupy identical paths.
- **Re-Test drift.** We diff the new shape against saved keys and **warn** about any
  now-missing variable that existing steps reference, rather than silently dropping it.

## Credential encryption, security & SSH

- **What's secret:** header values (`Authorization`, `X-Api-Key`, …), secret-bearing
  query params, and a secret body. Encrypted at rest via `encrypt()` / `decrypt()` in
  `src/main/persistence.ts` (`safeStorage`), falling back to plaintext only when
  `safeStorage` is unavailable — matching current behavior.
- **Plaintext never leaves main.** The renderer sends a value to save; main encrypts it.
  On edit the renderer shows a masked `•••• (set)` placeholder and only re-encrypts when
  the user changes it. Test / poll / fetch decrypt **inside main** right before the
  request.
- **Never echoed.** Decrypted secrets and raw `Authorization` headers are not returned in
  any IPC payload. Test returns the **body** (for mapping) but strips request secrets from
  anything echoed back.
- **SSH use case.** Polling runs in the scheduler-owner main process on the host where the
  automation lives, so a remote/SSH workspace polls from the controlling host. Secrets
  stay host-side; nothing secret crosses the E2EE RPC channel.
- **Request safety.** Arbitrary user URLs are expected (the user owns their endpoints), so
  we don't block private ranges — but we enforce `http`/`https` only, a request
  **timeout**, a **response-size cap**, and a **redirect limit** to avoid hangs and
  runaway memory.

## Edge cases & error handling

- **Empty array / missing `itemsPath`** → poll yields zero events (no error); manual
  picker shows an empty state.
- **Item lacks dedupe field** → dedup key falls back to hashing the whole item.
- **Item lacks / can't parse date-gate field** → poll fails the gate **closed** (won't
  fire); flagged in poll status. (Manual is unaffected — gate doesn't apply.)
- **Huge result sets** → response-size cap + `maxItemsPerPoll`; dropped count logged.
- **Endpoint shape drifts** → re-Test diff warns about referenced-but-missing variables.
- **Auth failure (401/403)** vs **transient (5xx/timeout)** → both skip dispatch, surface
  in poll status, never pollute the dedup store; auto-recover when healthy.
- **`safeStorage` unavailable** → secrets stored plaintext (existing fallback), same as
  the Linear token today.

## Testing strategy

### Pure-function tests (highest leverage)
- Array auto-detection + `itemsPath` resolution (top-level array, nested, whole-object,
  override, missing path).
- Flatten-to-dot-paths over nested objects + arrays; type inference incl. date parsing
  (ISO, epoch s, epoch ms, invalid).
- Composite dedup-key building over one and multiple `dedupeFields`; stable hashing.
- Date-gate vs `enabledAt` comparison (strictly-later; missing/unparseable fails closed).
- Condition matching over mapped fields (reuses existing `evalCondition` tests).
- Secret encrypt/decrypt round-trip and the masked-placeholder save path (changed vs
  unchanged value).

### Engine tests
- Per-trigger interval gating: a trigger isn't polled before `intervalMs` elapses.
- One-run-per-new-item; restart-safe dedup; gate rejects pre-`enabledAt` items.
- `maxItemsPerPoll` bound respected; dropped count logged.
- A failing fetch advances `lastPolledAt`, dispatches nothing, leaves dedup clean.

### Manual-flow tests
- `fetchItems` maps the list + labels/subtitles correctly.
- Condition pre-filter with show-all toggle.
- Pick resolves to `trigger.http.*` and dispatches against the right project.

### Security tests
- Assert no decrypted secret (header value, body) appears in any IPC response — Test,
  fetchItems, list/get automation.
- Masked placeholder round-trips without re-encrypting an unchanged secret.

### Component tests (`renderToStaticMarkup`)
- Test flow: array dropdown options from a sample; mapping checklist renders rows with
  sample values; toggle/rename updates `fields[]`.
- Dedupe / date-gate / label pickers populate from saved `fields[]`.
- `AvailableVariablesPanel` shows the `http` branch with sample-value hints.
- Polling vs manual toggles independently enable their respective config sections.

### Verification commands
Per repo norms: `pnpm tc:node` + `pnpm tc:web` and targeted `vitest` on the new modules.
(The full suite and `tc:cli` have known unrelated failures.)

## Risks

1. **Arbitrary-URL SSRF.** Mitigated to the extent practical (scheme allow-list, timeout,
   size cap, redirect limit) but we intentionally allow private ranges since users target
   internal/self-hosted APIs. Document the trust model.
2. **Secret leakage via echoed responses.** The single most important invariant; covered
   by dedicated security tests asserting no plaintext secret crosses IPC outward.
3. **Endpoint shape drift breaking variables.** Re-Test diff warns rather than silently
   dropping; downstream `{{trigger.http.id}}` can't quietly break.
4. **Rate limits on third-party APIs.** Per-trigger interval lets the user back off a hot
   endpoint; failures don't pollute dedup so recovery is automatic.
5. **Date parsing ambiguity** (e.g. epoch seconds vs ms, locale strings). Test surfaces
   the parsed date so the user confirms the gate before saving; fail-closed on unparseable.
6. **Large responses** exhausting memory. Hard response-size cap before parse.
7. **Dynamic catalog staleness** between Test and live data. The persisted snapshot is the
   contract; drift is surfaced on re-Test, not silently reconciled.

## Deviations from plan

Notable adaptations made during implementation; none change the design's intent.

- **Positional secret resolution.** `resolveDraftRequestSecrets` (and `sealHttpKeyValues`)
  pair masked secrets to their saved ciphertext by **index**, not by key name. Key-based
  matching cross-contaminated a same-named header and query param (and broke on renames);
  positional pairing keeps each carrier's secret distinct and survives key renames.
- **Per-trigger poll clock wired in `index.ts`.** The engine's `httpLastPoll` /
  `httpLastPollSet` deps reuse the existing in-memory `autoTriggerWatermarks` map with an
  `http|<triggerId>` key prefix rather than introducing a separate store.
- **`AutoTriggerCard` dispatcher split.** The http branch is rendered via an extracted
  dispatcher component (not an early `return` inside the original card body) to satisfy
  React's rules-of-hooks (the two source variants call different hooks).
- **`buildDedupKey` JSON-encodes** the chosen field values (e.g. `[1]`) instead of
  space-joining them, giving a collision-safe, type-preserving entity id.
- **ISO-strict date parsing.** `parseDateValue` accepts epoch seconds/ms and
  `Date.parse`-able strings and fails closed on anything else, so the date gate never
  silently passes an unparseable value.
- **Un-secret clears the mask.** Toggling a header/query/body off `secret` while it still
  shows the mask sentinel clears the value rather than persisting the literal mask as
  plaintext — guarding against a mask string leaking into a real request.
