# Reusable HTTP Connections + In-Chain HTTP Request Step — Design

**Date:** 2026-06-07
**Status:** Approved, ready for implementation

## Summary

Two related additions to the HTTP automation surface:

1. **Reusable HTTP connection** — a workspace-level record holding the parts you
   want to reuse (base URL + headers, including the secret-bearing auth), entered
   once and **selectable from both the HTTP trigger and the new request step**.
   Lives in Settings, modeled exactly on the "shared prompts" library.
2. **"Make HTTP request" step** — a new chain step kind that reuses the trigger's
   request builder + Test + field-mapping as-is, runs mid-chain, and **requires a
   Test to save** so its mapped variables are available to downstream nodes.

Both are additive and non-breaking; existing HTTP triggers (inline URL + headers)
are untouched and need no migration.

## Decisions (from brainstorming)

1. **Connection scope:** workspace-level library in `GlobalSettings`, edited in a
   Settings section modeled on `SidebarPromptCommandsSection` (shared prompts).
   Referenced **by id**, resolved at render — renaming/rotating never touches
   automation definitions.
2. **Shared vs per-node split:** connection holds `baseUrl` + `headers` (secrets).
   The node keeps `method`, URL **path** (joined to `baseUrl`), **query**, **body**,
   and its own **Test + mapping**. A node may add its own extra headers, merged
   over the connection's (node wins on key conflict).
3. **Optional / non-breaking:** `connectionId` is optional. No connection → node is
   fully inline as today. With a connection → URL field is a *path*, headers come
   from the connection (plus node extras). No migration of existing triggers.
4. **Request step output:** reuse the trigger's exact Test + `itemsPath` + field
   mapping. Single result (first resolved item, or whole body when `itemsPath` is
   null) → mapped variables. **No array fan-out / loop** (would need new
   chain-executor semantics — out of scope).
5. **Test-time variables:** unresolved `{{upstream}}` templates blank out at Test
   time; the connection's auth still applies, so the call authenticates and returns
   the real response shape for mapping. No separate sample-value UI.

## Architecture map (existing seams reused)

- Request model: `HttpRequestConfig` / `HttpKeyValue` / `MappedField`
  (`src/shared/automations-types.ts`).
- Secrets: `sealHttpKeyValues` / `maskHttpKeyValues` / `decryptHttpRequest`
  (`src/main/automations/http-endpoint-secrets.ts`), `encryptSecret`/`decryptSecret`
  (`src/main/secret-encryption.ts`, Electron `safeStorage`).
- Request execution: `executeHttpEndpointRequest`
  (`src/main/automations/http-endpoint-request.ts`) — SSRF guard, 15s timeout, 5MB cap.
- Mapping: `resolveItems` / `flattenItem` / `mapItemToVariables`
  (`src/shared/http-endpoint-mapping.ts`).
- Test IPC: `httpEndpoint:test` / `httpEndpoint:fetchItems` (`src/main/ipc/http-endpoint.ts`).
- Templates: `resolveTemplate` (`src/main/automations/template.ts`), `{{trigger.*}}`,
  `{{steps.<id>.<field>}}`, `{{automation.*}}`.
- Steps/runners: `StepKind` / `Step` / `StepConfig` (`automations-types.ts`),
  `SCHEMA_BY_KIND` (`automation-step-schemas.ts`), `StepRunner` (`step-runner.ts`),
  `resolveRunner` (`service.ts`), step output merge via `applyContextPatch`
  (`chain-executor.ts`).
- Available variables: `buildTriggerSchema` (`chain-editor-modal-state.ts`).
- Shared-prompts template: `GlobalSettings` (`src/shared/types.ts`),
  `settings:get/set` (`src/main/ipc/settings.ts`), settings slice
  (`src/renderer/src/store/slices/settings.ts`), `SidebarPromptCommandsSection.tsx`,
  reference-by-id in `RunPromptStepCard.tsx`.

## 1. Connection data model

```ts
// src/shared/automations-types.ts (or sibling http-connection.ts)
export type HttpConnection = {
  id: string
  displayName: string
  baseUrl: string            // e.g. "https://api.acme.dev"
  headers: HttpKeyValue[]    // reuses the existing secret-capable shape
}
```

Added to `GlobalSettings.httpConnections: HttpConnection[]` (`src/shared/types.ts`),
persisted to `~/.orca/orca-data.json` via the existing `settings:get/set`.

Both the HTTP trigger (`HttpEndpointConfig`) and the new step
(`HttpRequestStepConfig`) gain an optional `connectionId?: string`.

## 2. Secrets (settings layer)

The existing HTTP-trigger secret machinery applied to `httpConnections`:

1. **`settings:set`** — seal each connection's `headers` via `sealHttpKeyValues(incoming, existing)`
   (encrypt fresh secrets; reuse stored ciphertext for masked, correlated by stable `id`).
2. **`settings:get`** — mask via `maskHttpKeyValues` so ciphertext never reaches the renderer.
3. **Request time** (trigger poll / step run / Test) — in main, resolve the connection by id,
   merge `baseUrl` + decrypted headers into the node request, `decryptHttpRequest`, then
   `executeHttpEndpointRequest`. Secrets decrypted only in-process, never echoed back.

A focused addition in `src/main/ipc/settings.ts` (reusing `http-endpoint-secrets.ts`).
Deleting a referenced connection is allowed; a dangling `connectionId` is a clear
save-blocking validation error, not a silent failure. Secrets are machine-bound
(`safeStorage`), consistent with existing trigger secrets — connections don't roam.

## 3. Connection merge

At request time (shared helper, e.g. `src/main/automations/http-connection-merge.ts`):
- **URL:** `joinUrl(connection.baseUrl, node.request.url)` — tolerant slash handling
  (exactly one `/` between base and path); when no connection, `node.request.url` is used verbatim.
- **Headers:** `connection.headers` then `node.request.headers` (node overrides on key conflict).
- **Query:** node-only (query is per-node/dynamic).
- Decryption happens after merge, before execution.

## 4. "Make HTTP request" step

```ts
export type StepKind = … | 'http-request'

export type HttpRequestStepConfig = {
  connectionId?: string
  request: HttpRequestConfig       // method, url (=path when connection set), headers, query, body
  itemsPath: string | null
  fields: MappedField[]            // Test-discovered mapping
  sampleResponse?: unknown
}
```

Strict subset of `HttpEndpointConfig` — **no** `dedupeFields` / `dateGateField` /
`intervalMs` / `maxItemsPerPoll` / picker `label/subtitle` (polling + manual-picker
concepts that don't apply to a one-shot in-chain call).

**Runner** (`src/main/automations/runners/http-request-runner.ts`, `StepRunner`):
1. Resolve `{{…}}` templates in url/query/headers/body against `ctx.context`
   (`resolveTemplate`).
2. Merge connection (base URL + decrypted headers) if `connectionId` set; `decryptHttpRequest`.
3. `executeHttpEndpointRequest` (existing guards).
4. Map response like the trigger: `resolveItems(body, itemsPath)` → single result
   (first item, or whole body when `itemsPath` null) → `mapItemToVariables(item, fields)`.
5. Return `contextPatch: { steps: { [step.id]: mappedVars } }`.

Non-2xx / network error → step `failed`, honoring the step's existing
`onFailure: halt | continue` and `timeoutSeconds`.

Wire in `service.ts` `resolveRunner('http-request')`; inject a test-overridable executor.

## 5. Downstream variables + "Test required to save" + editor

- **Dynamic output schema:** the available-variables computation special-cases an
  `http-request` step to read its own enabled `fields` (mirroring the http-trigger
  special-case in `buildTriggerSchema`), so downstream nodes see
  `steps.<id>.<fieldName>` in `{{…}}` autocomplete. (`SCHEMA_BY_KIND` stays static for
  other kinds; this one is computed from config.)
- **Test required to save:** `computeAllErrors` (`chain-editor-modal-state.ts`) marks an
  `http-request` step invalid until it has a Test mapping (`sampleResponse` + ≥1 enabled
  field). Dangling `connectionId` is likewise an error.
- **Editor — `HttpRequestStepCard`:** connection picker (combobox over `httpConnections`,
  by id; sets URL field to *path* mode + "headers + from <connection>"), the reused
  request builder + Test + field-mapping (reusing `http-endpoint-card-state` reducers and
  shared sub-components extracted from `HttpEndpointTriggerCard`). Registered in
  `STEP_KIND_LABELS` / `STEP_KIND_ORDER` + the step-card router; `httpConnections` threaded
  `AutomationsPage → ChainEditorModal → router → card` from the settings slice (like
  `reviewCommands`).
- **Trigger card:** add the same connection picker to `HttpEndpointTriggerCard`
  (sets `HttpEndpointConfig.connectionId`, path-mode URL, connection headers).
- **Test IPC:** extend `httpEndpoint:test` to accept optional `connectionId` (merge base
  URL + decrypted headers) and to blank unresolved `{{…}}` before firing.

## 6. Settings UI

`HttpConnectionsSection.tsx` (parallel to `SidebarPromptCommandsSection.tsx`):
list + per-row editor (displayName, baseUrl, headers key/value with secret toggle +
mask) + delete; local-draft-on-blur; emits `updateSettings({ httpConnections })`.
Placed in a Settings pane (the Automations pane, or General alongside shared prompts —
decide during implementation to match nav conventions) + a search entry.

## 7. Testing

- `http-endpoint-secrets` — connection seal/mask path (fresh → encrypted; masked →
  reuses ciphertext by id; get never leaks ciphertext).
- `http-connection-merge` — base+path join (slashes), header override, query
  composition, dangling-connection error.
- `http-request-runner` — template resolution; connection merge + decrypt + execute
  (injected executor); response mapped → `contextPatch.steps.<id>`; non-2xx → failed
  honoring `onFailure`; timeout.
- available-variables — `http-request` step contributes `steps.<id>.<field>` downstream.
- `chain-editor-modal-state` — step invalid until Test mapping; dangling connection error.
- `HttpConnectionsSection` — list/add/edit/delete; secret mask; emits updateSettings.
- `HttpRequestStepCard` — connection picker → path-mode; Test populates fields;
  fields surface downstream.
- e2e (mirror `http-trigger-card.spec.ts`) — add connection in settings; add
  http-request step; pick connection; Test → map field; downstream node references
  `{{steps.<id>.field}}`; save blocked until tested.

Verification: `pnpm tc:node` + `pnpm tc:web` + targeted vitest + the e2e
(full suite / `tc:cli` have known-unrelated failures).

## Deferred (YAGNI)

- Array fan-out (run downstream once per response item) — needs new chain-executor
  loop semantics; out of scope.
- Per-connection auth presets (bearer/basic/api-key helpers) — plain headers cover it;
  add later if asked.
- Connection roaming across machines — secrets are `safeStorage`-bound, as today.
