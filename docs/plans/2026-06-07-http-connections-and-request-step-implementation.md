# HTTP Connections + Request Step — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a workspace-level reusable HTTP connection library (base URL + secret headers) selectable from the HTTP trigger and a new in-chain "Make HTTP request" step that reuses the trigger's Test + field mapping and requires a test to save.

**Architecture:** Connections live in `GlobalSettings.httpConnections` (persisted via the existing `settings:get/set`, modeled on shared prompts), with the existing HTTP secret seal/mask/decrypt machinery applied at the settings layer. A node (trigger or step) optionally references a connection by `connectionId`; at request time the connection's base URL + decrypted headers merge into the node's resolved request. The new `http-request` step kind reuses the trigger's request/mapping editor (extracted into a shared sub-component) and a new runner that resolves templates → merges connection → executes → maps the response into `steps.<id>.<field>` for downstream nodes. Its output schema is computed dynamically from the step's mapped fields.

**Tech Stack:** TypeScript, Electron (main + renderer), React + shadcn primitives, Electron `safeStorage` for secrets, Vitest, Playwright.

**Design doc:** `docs/plans/2026-06-07-http-connections-and-request-step-design.md`

**Conventions for every task** (same as the schedule-trigger work):
- TDD: failing test first → watch fail → minimal impl → watch pass → commit.
- Verify with targeted `pnpm test <path>` + `pnpm tc:node` / `pnpm tc:web`. Do NOT run the full suite or `tc:cli` for green/red (known unrelated failures).
- oxlint `"curly": "error"` (braces on every if/else). Comment only the *why*, briefly. No `helpers`/`utils` file names. STYLEGUIDE + shadcn for UI. Project types in `.ts` not `.d.ts`.
- Commit after each task.

**Key existing seams (verified):**
- `HttpConnection`/`GlobalSettings`: `src/shared/types.ts` (GlobalSettings @ ~1288; `reviewCommands` @ ~1517).
- Request/secret types: `HttpRequestConfig`, `HttpKeyValue`, `MappedField`, `HttpEndpointConfig` in `src/shared/automations-types.ts`.
- Secrets: `sealHttpKeyValues`/`maskHttpKeyValues`/`decryptHttpRequest`/`sealAutoTriggers` in `src/main/automations/http-endpoint-secrets.ts`; `encryptSecret`/`decryptSecret` in `src/main/secret-encryption.ts`.
- Execute: `executeHttpEndpointRequest` in `src/main/automations/http-endpoint-request.ts`.
- Mapping: `resolveItems`/`flattenItem`/`mapItemToVariables` in `src/shared/http-endpoint-mapping.ts`.
- Test IPC: `runTest(deps, { request, automationId?, autoTriggerId? })` @ `src/main/ipc/http-endpoint.ts:43`; registered `httpEndpoint:test` @ :93.
- Settings IPC: `src/main/ipc/settings.ts` (`settings:get`/`settings:set`); settings slice `src/renderer/src/store/slices/settings.ts`; shared-prompts UI `SidebarPromptCommandsSection.tsx`; reference-by-id in `RunPromptStepCard.tsx`.
- Steps: `StepKind` @ `automations-types.ts:350`, `StepConfig` @ :482, `Step` @ :490. `STEP_KIND_LABELS`/`STEP_KIND_ORDER` @ `chain-editor-modal-state.ts:44/58`. Router `ChainEditorStepCardRouter.tsx` (switch on `step.kind`). Runner dispatch `resolveRunner` in `service.ts`. `StepRunner` in `step-runner.ts`. Step output merge `applyContextPatch` in `chain-executor.ts`. Output schema `SCHEMA_BY_KIND`/`getOutputSchemaForKind` in `automation-step-schemas.ts`; available-vars `getAvailableVariablesAtStep`/`buildTriggerSchema` in `chain-editor-modal-state.ts` (uses `getOutputSchemaForKind(s.kind)` @ :179 — must become step-aware).
- Template engine: `resolveTemplate` in `src/main/automations/template.ts`.

---

## Phase A — Connection model, secrets, merge (backend)

### Task A1: Connection type + settings field + node `connectionId`

**Files:**
- Modify: `src/shared/automations-types.ts` (HttpConnection or import; `connectionId?` on `HttpEndpointConfig`)
- Modify: `src/shared/types.ts` (`GlobalSettings.httpConnections`)
- Test: `src/shared/automations-types.test.ts`

**Step 1 — failing type test** (append to `automations-types.test.ts`):

```ts
import type { HttpConnection, HttpEndpointConfig } from './automations-types'

it('HttpConnection holds id, displayName, baseUrl, secret-capable headers', () => {
  const c: HttpConnection = {
    id: 'c1', displayName: 'Acme', baseUrl: 'https://api.acme.dev',
    headers: [{ key: 'X-Api-Key', value: 'secret', secret: true }]
  }
  expect(c.baseUrl).toBe('https://api.acme.dev')
  const cfg: Pick<HttpEndpointConfig, 'connectionId'> = { connectionId: 'c1' }
  expect(cfg.connectionId).toBe('c1')
})
```

**Step 2 — run, confirm FAIL:** `pnpm test src/shared/automations-types.test.ts`

**Step 3 — implement.** In `automations-types.ts`, define `HttpConnection` (near `HttpKeyValue`):

```ts
// A reusable HTTP connection: the shared base URL + headers (incl. secrets) that
// multiple http nodes (trigger + request steps) point at, entered once.
export type HttpConnection = {
  id: string
  displayName: string
  baseUrl: string
  headers: HttpKeyValue[]
}
```

Add `connectionId?: string` to `HttpEndpointConfig` (comment: "optional reusable connection; supplies base URL + headers"). In `src/shared/types.ts`, add to `GlobalSettings`:

```ts
  /** Reusable HTTP connections (base URL + secret headers) selectable from
   *  HTTP automation nodes. Secrets sealed/masked like trigger secrets. */
  httpConnections: HttpConnection[]
```

Import `HttpConnection` into `types.ts` from `automations-types` (or define in a sibling `http-connection.ts` if circular — verify import direction; `automations-types` is the natural home).

**Step 4 — run test + `pnpm tc:node && pnpm tc:web`.** Widening `GlobalSettings` with a required field may break object literals that construct full settings (defaults). Find the default settings constant (grep `reviewCommands:` in `src/main` and `src/shared`) and add `httpConnections: []`. Fix every site tc flags.

**Step 5 — commit:** `git add -A && git commit -m "feat(automations): HttpConnection type + settings field + node connectionId"`

---

### Task A2: Connection secret seal/mask at the settings layer

The renderer must never see ciphertext; new secrets must be encrypted on save, masked unchanged ones reused by stable `id`.

**Files:**
- Modify: `src/main/automations/http-endpoint-secrets.ts` (add `sealHttpConnections`/`maskHttpConnections`)
- Modify: `src/main/ipc/settings.ts` (apply on get/set)
- Test: `src/main/automations/http-endpoint-secrets.test.ts`

**Step 1 — failing tests** (mirror the existing `sealHttpKeyValues`/`maskHttpKeyValues` tests in this file):

```ts
import { sealHttpConnections, maskHttpConnections } from './http-endpoint-secrets'

it('seals fresh connection secrets and reuses ciphertext for masked ones by id', () => {
  const prior = [{ id: 'c1', displayName: 'A', baseUrl: 'https://a', headers: [
    { id: 'h1', key: 'X-Key', value: 'CIPHER', secret: true }] }]
  // unchanged secret arrives masked -> reuse CIPHER; new plaintext -> encrypted (not equal to plaintext)
  const incoming = [{ id: 'c1', displayName: 'A', baseUrl: 'https://a', headers: [
    { id: 'h1', key: 'X-Key', value: HTTP_SECRET_MASK, secret: true }] }]
  const sealed = sealHttpConnections(incoming, prior)
  expect(sealed[0].headers[0].value).toBe('CIPHER')
})

it('masks all connection secrets for the renderer', () => {
  const sealed = [{ id: 'c1', displayName: 'A', baseUrl: 'https://a', headers: [
    { id: 'h1', key: 'X-Key', value: 'CIPHER', secret: true }] }]
  const masked = maskHttpConnections(sealed)
  expect(masked[0].headers[0].value).toBe(HTTP_SECRET_MASK)
})
```

**Step 2 — run, confirm FAIL.**

**Step 3 — implement** `sealHttpConnections(incoming, existing)` and `maskHttpConnections(list)` by delegating to the existing `sealHttpKeyValues`/`maskHttpKeyValues` per connection's `headers`, correlating connections by `id` (mirror `sealAutoTriggers`'s by-id correlation). Read `sealAutoTriggers` and follow its shape.

**Step 4 — wire into `settings.ts`:** in the `settings:set` handler, if `args.httpConnections` is present, replace it with `sealHttpConnections(args.httpConnections, store.getSettings().httpConnections ?? [])` before `store.updateSettings`. In `settings:get`, return settings with `httpConnections: maskHttpConnections(settings.httpConnections ?? [])`. Add a focused test for the handler if `settings.ts` has a test harness; otherwise rely on the seal/mask unit tests + manual note.

**Step 5 — `pnpm test <secrets test> && pnpm tc:node`.**

**Step 6 — commit:** `feat(automations): seal/mask HTTP connection secrets in settings IPC`

---

### Task A3: Connection-merge helper

**Files:**
- Create: `src/main/automations/http-connection-merge.ts`
- Test: `src/main/automations/http-connection-merge.test.ts`

**Step 1 — failing tests:**

```ts
import { joinConnectionUrl, mergeConnectionRequest } from './http-connection-merge'

it('joins base + path with exactly one slash', () => {
  expect(joinConnectionUrl('https://a.dev', '/x')).toBe('https://a.dev/x')
  expect(joinConnectionUrl('https://a.dev/', '/x')).toBe('https://a.dev/x')
  expect(joinConnectionUrl('https://a.dev', 'x')).toBe('https://a.dev/x')
  expect(joinConnectionUrl('https://a.dev/', '')).toBe('https://a.dev/')
})

it('merges connection base+headers into a node request (node header wins on key)', () => {
  const conn = { id: 'c1', displayName: 'A', baseUrl: 'https://a.dev',
    headers: [{ key: 'X-Key', value: 'k' }, { key: 'X-Conn', value: 'c' }] }
  const req = { method: 'POST', url: '/v1/things',
    headers: [{ key: 'X-Key', value: 'override' }], query: [], body: '{}' }
  const merged = mergeConnectionRequest(req, conn)
  expect(merged.url).toBe('https://a.dev/v1/things')
  expect(merged.headers).toEqual([
    { key: 'X-Conn', value: 'c' }, { key: 'X-Key', value: 'override' }
  ]) // connection headers first, node overrides same key
  expect(merged.query).toEqual([])
})

it('returns the request unchanged when no connection', () => {
  const req = { method: 'GET', url: 'https://x/y', headers: [], query: [] }
  expect(mergeConnectionRequest(req, undefined)).toEqual(req)
})
```

(Adjust the exact merge/ordering semantics to what reads cleanest; the contract: connection base joined to path, connection headers applied then overridden by node headers on key match, query is node-only, no connection → unchanged. Lock whatever you choose in the test.)

**Step 2 — run, confirm FAIL. Step 3 — implement** `joinConnectionUrl(base, path)` and `mergeConnectionRequest(request, connection?)`. Keep it a pure function (no decryption here — caller decrypts after merge).

**Step 4 — `pnpm test <merge test> && pnpm tc:node`. Step 5 — commit:** `feat(automations): http connection base-url + header merge helper`

---

## Phase B — Settings UI

### Task B1: `HttpConnectionsSection` settings UI

**Files:**
- Create: `src/renderer/src/components/settings/HttpConnectionsSection.tsx`
- Modify: a settings pane to render it (see below) + `general-search.ts` (search entry)
- Test: `HttpConnectionsSection.test.tsx` if an RTL precedent exists (`SidebarPromptCommandsSection` has none → likely skip; note it)

**Step 1 — read** `SidebarPromptCommandsSection.tsx` (the exact pattern: list + per-row editor + delete, local-draft-on-blur, emits an `onChange…` callback) and `GeneralPane.tsx` where it's mounted. Read STYLEGUIDE for form/list anatomy.

**Step 2 — implement** `HttpConnectionsSection` props `{ httpConnections: HttpConnection[]; onChange: (next: HttpConnection[]) => void }`. Per-row editor: `displayName`, `baseUrl`, and a headers key/value list with a secret toggle (reuse the secret mask UX from `HttpEndpointTriggerCard`'s header rows — extract or mirror; a row whose value is the mask shows masked). Add/delete connections and headers. Local-draft-on-blur like the prompts section. Use shadcn primitives + tokens.

**Step 3 — mount it.** Decide placement to match nav conventions: simplest is in the **Automations** settings pane (search for the automations settings pane component); else alongside shared prompts in `GeneralPane.tsx`:

```tsx
<HttpConnectionsSection
  httpConnections={settings.httpConnections ?? []}
  onChange={(next) => updateSettings({ httpConnections: next })}
/>
```

Add a search entry in `general-search.ts` (mirror `GENERAL_SIDEBAR_PROMPT_SEARCH_ENTRIES`).

**Step 4 — `pnpm tc:web`** (+ any RTL test). **Step 5 — commit:** `feat(settings): HTTP connections management section`

---

## Phase C — Trigger connection picker + Test IPC

### Task C1: Extend the Test IPC for connections + template blanking

**Files:**
- Modify: `src/main/ipc/http-endpoint.ts` (`runTest` args + resolution)
- Modify: its `HttpEndpointIpcDeps` if it needs store access to connections (it has `deps.store`)
- Test: a `runTest` test (create `src/main/ipc/http-endpoint.test.ts` if none; else add)

**Step 1 — failing test:** `runTest(deps, { request, connectionId })` with an injected `execute` spy asserts the executed request has the connection's base URL joined + decrypted headers merged, and that an unresolved `{{x}}` in the URL/query/body is blanked before execution.

**Step 2 — run, confirm FAIL. Step 3 — implement.** Extend `runTest` args to `{ request; automationId?; autoTriggerId?; connectionId? }`. Resolution order:
1. Blank unresolved templates: `resolveTemplate(value, {})` leaves unknown `{{…}}` — confirm `resolveTemplate`'s behavior for unknown paths (read `template.ts`); if it leaves them literal, add a pass that strips unresolved `{{…}}` to '' for the test request only (a small `blankTemplates(request)` helper, or resolve against `{}` if that already blanks). Lock the chosen behavior in the test.
2. If `connectionId`: look up the connection in `deps.store.getSettings().httpConnections`, `mergeConnectionRequest`, then decrypt the connection's headers (they're ciphertext at rest) — reuse `decryptHttpRequest` / `decryptSecret`.
3. Existing `resolveDraftRequest` for the node's own secrets.

**Step 4 — `pnpm test <ipc test> && pnpm tc:node`. Step 5 — commit:** `feat(automations): test IPC merges connection + blanks unresolved templates`

---

### Task C2: Apply connection merge in the trigger's real request paths

The trigger's poll + fetchItems must also merge the connection (not just Test).

**Files:**
- Modify: `src/main/automations/trigger-sources/http-endpoint.ts` (poll) and `src/main/ipc/http-endpoint.ts` (fetchItems) — wherever `decryptHttpRequest(cfg.request)` is called
- Test: extend `http-endpoint.test.ts` (trigger source) for the connection path

**Step 1 — failing test:** an http trigger with `connectionId` set polls/fetches against the merged base URL + connection headers (injected executor asserts the final request).

**Step 2 — implement:** before `decryptHttpRequest`, if `cfg.connectionId`, resolve the connection from the store and `mergeConnectionRequest`, then decrypt (merge connection headers which are themselves ciphertext — ensure they're decrypted too; a single `decryptHttpRequest` over the merged request works if connection header ciphertext lives in `value` with `secret: true`). Thread store/connection access through the source deps if needed (the source factory `makeHttpEndpointSource` may need a `getConnections` dep — mirror how other sources get deps).

**Step 3 — run + `pnpm tc:node`. Step 4 — commit:** `feat(automations): http trigger honors connection at poll/fetch time`

---

### Task C3: Connection picker on the trigger card

**Files:**
- Modify: `HttpEndpointTriggerCard.tsx` (+ thread `httpConnections` into it)
- Modify: wherever the trigger card is rendered (TriggersModal / AutoTriggerCard chain) to pass `httpConnections` from the settings slice
- Test: `HttpEndpointTriggerCard.test.tsx`

**Step 1 — failing test:** selecting a connection sets `trigger.http.connectionId`; the URL field switches to path-mode labeling; clearing returns to inline.

**Step 2 — implement** a connection `Select`/combobox (by id, options from `httpConnections`, plus "(none) — inline"). When set, label the URL input "Path" and show "Headers + from <connection>". Persist `connectionId` via the existing onChange. Thread `httpConnections` from the settings slice down to the card (read `settings?.httpConnections ?? []` in the automations editor entry, pass through props — mirror `reviewCommands`).

**Step 3 — `pnpm test <card test> && pnpm tc:web`. Step 4 — commit:** `feat(automations): connection picker on HTTP trigger card`

---

## Phase D — The "Make HTTP request" step

### Task D1: Step type widening (keep tc green incl. renderer)

**Files:**
- Modify: `src/shared/automations-types.ts` (`StepKind`, `HttpRequestStepConfig`, `StepConfig`)
- Modify: `src/shared/automation-step-schemas.ts` (`SCHEMA_BY_KIND` placeholder)
- Modify: `chain-editor-modal-state.ts` (`STEP_KIND_LABELS`, `STEP_KIND_ORDER`)
- Modify: `ChainEditorStepCardRouter.tsx` (interim case so the switch stays exhaustive)
- Test: `src/shared/automations-types.test.ts`

**Step 1 — failing test:** assert `'http-request'` is a `StepKind` and `HttpRequestStepConfig` has `{ connectionId?, request, itemsPath, fields, sampleResponse? }`.

**Step 2 — implement type:**

```ts
export type StepKind = … | 'http-request'

export type HttpRequestStepConfig = {
  connectionId?: string
  request: HttpRequestConfig
  itemsPath: string | null
  fields: MappedField[]
  sampleResponse?: unknown
}
// add HttpRequestStepConfig to the StepConfig union
```

**Step 3 — fix every exhaustive site tc flags:**
- `SCHEMA_BY_KIND['http-request'] = {}` (placeholder; the real schema is computed dynamically in Task D5 — comment why).
- `STEP_KIND_LABELS['http-request'] = 'HTTP request'`; add `'http-request'` to `STEP_KIND_ORDER` (sensible position).
- Router switch: add `case 'http-request'` rendering an INTERIM placeholder (e.g. `<StepCardChrome …>HTTP request — editor coming in D6</StepCardChrome>` or reuse a minimal block) so `tc:web` stays green now; the full card lands in Task D6. Comment that it's interim.
- `resolveRunner` is an if-chain (non-exhaustive) — no change needed yet.

**Step 4 — `pnpm test <types test> && pnpm tc:node && pnpm tc:web`** all green. **Step 5 — commit:** `feat(automations): add 'http-request' step kind + config`

---

### Task D2: Extract the shared request + mapping editor

The `http-endpoint-card-state` reducers operate on `AutoTrigger`; the step config is `HttpRequestStepConfig`. Extract a reusable editor over the common slice so both cards share it (DRY).

**Files:**
- Create: `src/renderer/src/components/automations/editor/HttpRequestEditor.tsx` (the shared request-builder + Test + mapping UI)
- Possibly create: `src/renderer/src/components/automations/editor/http-request-editor-state.ts` (reducers over the common slice `{ connectionId?, request, itemsPath, fields, sampleResponse }`)
- Modify: `HttpEndpointTriggerCard.tsx` to consume the shared editor (no behavior change)
- Test: `HttpEndpointTriggerCard.test.tsx` must still pass; add `HttpRequestEditor.test.tsx` if useful

**Step 1 — read** `HttpEndpointTriggerCard.tsx` + `http-endpoint-card-state.ts` to identify the request-builder + Test + mapping block (method/url/headers/query/body, Test button, itemsPath + discovered fields + enable/rename). 

**Step 2 — extract** `HttpRequestEditor` taking the common slice `value: { connectionId?; request; itemsPath; fields; sampleResponse? }`, `onChange(next)`, `httpConnections`, and a `test(request, connectionId?)` callback (calls the IPC). Move/duplicate the relevant reducers to operate on this slice (NOT `AutoTrigger`). The connection picker (Task C3) belongs here so both cards get it for free — refactor C3's picker into this editor if cleaner.

**Step 3 — refactor `HttpEndpointTriggerCard`** to render `<HttpRequestEditor value={sliceFromTrigger(trigger.http)} onChange={writeBackToTrigger} … />` plus the trigger-only bits (dedup, dateGate, interval, polling/manual toggles, picker label/subtitle) AROUND it. The trigger card's existing tests must still pass (this is a pure refactor).

**Step 4 — `pnpm test HttpEndpointTriggerCard.test.tsx && pnpm tc:web`** green. **Step 5 — commit:** `refactor(automations): shared HttpRequestEditor for trigger + step`

---

### Task D3: `http-request` runner

**Files:**
- Create: `src/main/automations/runners/http-request-runner.ts`
- Test: `src/main/automations/runners/http-request-runner.test.ts`

**Step 1 — failing tests** (mirror an existing runner test, e.g. `create-worktree-runner.test.ts`, for the StepRunner harness):
- Resolves `{{trigger.http.q}}` in url/query/body against `ctx.context` before executing (injected `execute` spy asserts resolved values).
- Merges connection base+headers when `config.connectionId` set (inject connections via deps).
- Maps the response: `resolveItems(body, itemsPath)` → single item (first, or whole body when null) → `mapItemToVariables(item, fields)`; returns `contextPatch: { steps: { [step.id]: vars } }`, `outcome: 'done'`, `status: 'succeeded'`.
- Non-2xx → `outcome:'failed'`/`status:'failed'` with an error; honors nothing extra (the executor returns status; treat >=400 as failure).

**Step 2 — run, confirm FAIL. Step 3 — implement** `HttpRequestRunner implements StepRunner` with deps `{ execute?: (req) => Promise<HttpEndpointResponse>; getConnection?: (id) => HttpConnection | undefined; now }`. `tick(ctx)`:
1. `config = ctx.step.config as HttpRequestStepConfig`.
2. Resolve templates in `request.url`/each query/header value/`body` via `resolveTemplate(v, ctx.context)`.
3. If `connectionId`: `mergeConnectionRequest(resolved, getConnection(id))`.
4. `decryptHttpRequest(merged)` → `execute`.
5. Map response → `mappedVars`; `return { outcome:'done', status:'succeeded', output: mappedVars, contextPatch:{ steps:{ [ctx.step.id]: mappedVars } } }`.
6. On status >= 400 or thrown error → `{ outcome:'failed', status:'failed', error }`.

**Step 4 — `pnpm test <runner test> && pnpm tc:node`. Step 5 — commit:** `feat(automations): http-request step runner`

---

### Task D4: Register the runner

**Files:** Modify `src/main/automations/service.ts` (construct + `resolveRunner`), and wherever runner deps (connections) are sourced.

**Step 1 — test:** if `service.test.ts` covers `resolveRunner`, assert `'http-request'` resolves to the runner; else verify via a small integration. **Step 2 — implement:** construct `this.httpRequestRunner = new HttpRequestRunner({ now, getConnection: (id) => this.store.getSettings().httpConnections?.find(c => c.id === id), execute: undefined })`; add `if (kind === 'http-request') return this.httpRequestRunner`. **Step 3 — `pnpm tc:node` + relevant tests. Step 4 — commit:** `feat(automations): register http-request runner`

---

### Task D5: Dynamic output schema (downstream variables)

**Files:**
- Modify: `src/shared/automation-step-schemas.ts` (a step-aware schema fn)
- Modify: `chain-editor-modal-state.ts` (use it at `:179`)
- Test: `automation-step-schemas.test.ts` + `chain-editor-modal-state.test.ts`

**Step 1 — failing test:** an `http-request` step with enabled mapped fields `[{variableName:'id',type:'string',enabled:true}, …]` yields a `steps.<id>` schema of `{ id: 'string', … }`; disabled fields excluded; and a downstream `{{steps.<id>.id}}` template dry-run resolves (no "unknown variable" error).

**Step 2 — implement** `getOutputSchemaForStep(step: Step): OutputSchema` that returns `getOutputSchemaForKind(step.kind)` for all kinds EXCEPT `http-request`, where it builds `{ [f.variableName]: f.type === 'number' ? 'number' : 'string' }` from `step.config.fields.filter(f => f.enabled)` (mirror the http-trigger special-case in `buildTriggerSchema`). In `chain-editor-modal-state.ts:179`, replace `getOutputSchemaForKind(s.kind)` with `getOutputSchemaForStep(s)`.

**Step 3 — run tests + `pnpm tc:node && pnpm tc:web`. Step 4 — commit:** `feat(automations): dynamic downstream schema for http-request step`

---

### Task D6: `HttpRequestStepCard` (replace the interim placeholder)

**Files:**
- Create: `HttpRequestStepCard.tsx`
- Modify: `ChainEditorStepCardRouter.tsx` (real case + `httpConnections` prop), `ChainEditorModal.tsx` (thread `httpConnections`), `AutomationsPage.tsx` (read from settings slice), `RunPromptStepCard`-style prop plumbing
- Test: `HttpRequestStepCard.test.tsx`

**Step 1 — read** an existing step card (`RunCommandStepCard.tsx`) for the StepCardChrome wiring + the router/modal prop threading (how `reviewCommands` flows `AutomationsPage → ChainEditorModal → router → card`).

**Step 2 — implement** `HttpRequestStepCard` = `<StepCardChrome …>` wrapping `<HttpRequestEditor value={config} onChange={onConfigChange} httpConnections={…} test={…} />`. It reuses the shared editor from D2 entirely (connection picker + request + Test + mapping). Thread `httpConnections` through the router (new prop) and modal from the settings slice (mirror `reviewCommands`). Replace the interim router case from D1.

**Step 3 — `pnpm test HttpRequestStepCard.test.tsx && pnpm tc:web`. Step 4 — commit:** `feat(automations): HTTP request step card`

---

### Task D7: "Test required to save" + dangling-connection validation

**Files:**
- Modify: `chain-editor-modal-state.ts` (`computeAllErrors`)
- Test: `chain-editor-modal-state.test.ts`

**Step 1 — failing tests:** a chain with an `http-request` step that has NO `sampleResponse` or zero enabled fields produces a save-blocking error; with a `sampleResponse` + ≥1 enabled field it's valid. A step (or trigger) whose `connectionId` isn't in `httpConnections` produces a "connection not found" error.

**Step 2 — implement** in `computeAllErrors`: loop steps; for `kind === 'http-request'`, push an error unless `config.sampleResponse !== undefined && config.fields.some(f => f.enabled)`; and push an error when `config.connectionId` is set but absent from the passed `httpConnections`. (Thread `httpConnections` into `computeAllErrors` if not already available — it already receives `repos`; add a param or read from a passed settings object. Mirror the existing param style.) Also validate the trigger's `connectionId` similarly.

**Step 3 — run tests + `pnpm tc:web`. Step 4 — commit:** `feat(automations): require test mapping to save http-request step`

---

### Task D8: End-to-end test

**Files:** Create `tests/e2e/http-request-step.spec.ts` (mirror `tests/e2e/http-trigger-card.spec.ts`).

**Step 1 — write** an e2e that: opens automations editor; adds an HTTP connection via settings (or seeds one); adds an `http-request` step; picks the connection; runs Test (stub/point at a controllable endpoint as the http-trigger e2e does — read how that spec provides a test response); maps a field; confirms a downstream node can reference `{{steps.<id>.<field>}}`; and that save is blocked until the step is tested. Keep assertions deterministic (presence, not exact dynamic values), matching the sibling spec's depth/scope. If the e2e harness can't reach a real endpoint, follow exactly how `http-trigger-card.spec.ts` handles the Test call.

**Step 2 — run:** `pnpm test:e2e -- http-request-step`. **Step 3 — commit:** `test(e2e): HTTP request step + connection flow`

---

## Final verification

```bash
pnpm tc:node && pnpm tc:web
pnpm test \
  src/shared/automations-types.test.ts \
  src/main/automations/http-endpoint-secrets.test.ts \
  src/main/automations/http-connection-merge.test.ts \
  src/main/ipc/http-endpoint.test.ts \
  src/main/automations/trigger-sources/http-endpoint.test.ts \
  src/main/automations/runners/http-request-runner.test.ts \
  src/shared/automation-step-schemas.test.ts \
  src/renderer/src/components/automations/editor/chain-editor-modal-state.test.ts \
  src/renderer/src/components/automations/editor/HttpEndpointTriggerCard.test.tsx \
  src/renderer/src/components/automations/editor/HttpRequestStepCard.test.tsx \
  src/renderer/src/components/settings/HttpConnectionsSection.test.tsx
pnpm test:e2e -- http-request-step
```

Then superpowers:requesting-code-review before merging.

## Notes / deferred (YAGNI)

- No array fan-out / loop in the chain (single result per request step).
- No auth presets (bearer/basic/api-key helpers) — plain headers cover it.
- Connections are `safeStorage`-bound (don't roam across machines), as today.
- No migration of existing inline triggers — connection is purely opt-in.
