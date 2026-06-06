# Generic HTTP Endpoint Trigger — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-automation `http-endpoint` trigger source that polls an arbitrary HTTP API (and/or is manually picked), derives downstream trigger variables from a live Test sample, dedupes + date-gates polled items, and encrypts auth secrets at rest.

**Architecture:** A new `TriggerSource` (`'http-endpoint'`) slots into the existing `AutoTriggerEngine`/`Rule`/dedup framework. Unlike the global `linear-issue`/`github-pr` sources, its config (URL, auth, field mapping, dedupe/date-gate/interval) lives on the `AutoTrigger` itself, and its condition field catalog is derived from a persisted Test snapshot. Two independent capability flags — `pollingEnabled` and `manualEnabled` — share one endpoint definition. Request secrets are sealed (encrypted) at the IPC boundary, masked when sent to the renderer, and decrypted in-main only when a request fires.

**Tech Stack:** TypeScript, Electron (main + preload + React renderer), `safeStorage` encryption, global `fetch`, Vitest, `tsgo` typecheck.

**Design doc:** `docs/plans/2026-06-06-http-endpoint-trigger-design.md`

**Verification (per repo norms):** Use `pnpm tc:node`, `pnpm tc:web`, and targeted `pnpm test <file>`. The full `pnpm test` suite and `pnpm tc:cli` have known unrelated failures — do not gate on them.

---

## Conventions for the executor

- **Worktree only.** All paths are relative to the current worktree `/Users/mikesnow/orca/workspaces/orca/dreamy_puma_2jcrv`. Never edit the main repo.
- **TDD.** Every behavior gets a failing test first. Run it red, implement minimally, run it green, commit.
- **Comments.** Per `AGENTS.md`: add a one-line `// Why:` comment only for non-obvious constraints. Don't narrate mechanism.
- **Typecheck before each commit** with `pnpm tc:node` (main/shared) and `pnpm tc:web` (renderer) as relevant to the files touched.
- **Test command:** `pnpm test <path-to-test-file>` runs one Vitest file (the `--config config/vitest.config.ts` is baked into the script).
- **No `helpers`/`utils` filenames** — name files after the concept (`AGENTS.md` rule).

---

## Phase 0 — Shared types & secret-encryption foundation

### Task 0.1: Extend `TriggerSourceId` and add HTTP types

**Files:**
- Modify: `src/shared/automations-types.ts:190` (the `TriggerSourceId` union) and add new types near the `AutoTrigger` block (after line 245).

**Step 1: Add `'http-endpoint'` to the union.**

At `src/shared/automations-types.ts:188-190`, change:

```ts
// Auto-trigger source identifiers. Each source has its own poller wiring;
// extra sources will be added here as they come online.
export type TriggerSourceId = 'linear-issue' | 'github-pr' | 'http-endpoint'
```

**Step 2: Add the HTTP config types.** Insert after the `AutoTrigger` type (after line 245):

```ts
// --- Generic HTTP endpoint trigger ---------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

// A request key/value (header or query param). When `secret` is true the value
// is ciphertext at rest, the masked sentinel when sent to the renderer, and is
// only ever decrypted in-main right before a request fires.
export type HttpKeyValue = {
  key: string
  value: string
  secret?: boolean
}

export type HttpRequestConfig = {
  method: HttpMethod
  url: string
  headers: HttpKeyValue[]
  query: HttpKeyValue[]
  // Raw request body (usually JSON). `secret: true` encrypts it like a header.
  body?: string
  bodySecret?: boolean
}

export type MappedFieldType = 'string' | 'number' | 'boolean' | 'date' | 'null' | 'unknown'

// One discovered leaf from the Test sample. `path` is the dot-path into an item
// (e.g. 'author.name', 'labels[0].name'); `variableName` is the flat key the
// step templates reference as `trigger.http.<variableName>`.
export type MappedField = {
  path: string
  variableName: string
  enabled: boolean
  type: MappedFieldType
  sampleValue: unknown
}

export type HttpEndpointConfig = {
  request: HttpRequestConfig
  // Dot-path to the items array; null = the whole response body is one item.
  itemsPath: string | null
  fields: MappedField[]
  // Last Test response, persisted so the dry-run/variable panel work offline.
  sampleResponse?: unknown
  // Poll-only:
  dedupeFields: string[] // dot-paths composing the dedup key
  dateGateField: string | null // dot-path whose parsed date must beat enabledAt
  intervalMs?: number // per-trigger cadence; falls back to the global interval
  maxItemsPerPoll?: number // safety bound; default 100
  // Manual-only:
  labelField?: string // dot-path shown as the picker's primary label
  subtitleField?: string // dot-path shown as the picker's secondary line
}

// Masked sentinel sent to the renderer in place of an encrypted secret value.
export const HTTP_SECRET_MASK = '••••••••'

// One item returned by httpEndpoint:fetchItems for the manual run-time picker.
export type HttpEndpointItem = {
  key: string // dedup key (or index) — React list key + selection id
  label: string
  subtitle: string
  vars: Record<string, unknown> // mapped variables → becomes trigger.http.*
}
```

**Step 3: Extend `AutoTrigger`.** At `src/shared/automations-types.ts:236-245`, add three optional fields:

```ts
export type AutoTrigger = {
  id: string
  source: TriggerSourceId
  enabled: boolean
  enabledAt: number
  rules: Rule[]
  repoIds?: string[]
  // http-endpoint only. `enabled` is the master switch; these gate the two
  // independent capabilities over the same endpoint definition.
  http?: HttpEndpointConfig
  pollingEnabled?: boolean
  manualEnabled?: boolean
}
```

**Step 4: Extend `RunNowPayload`.** At `src/shared/automations-types.ts:158-164`, add the `http` branch:

```ts
export type RunNowPayload = {
  linear?: { issue: LinearIssuePayload }
  github?: { pr: GithubPrPayload }
  // Mapped variables from a polled/picked HTTP item → run.context.trigger.http.
  http?: Record<string, unknown>
  projectId?: string
}
```

**Step 5: Typecheck.**

Run: `pnpm tc:node`
Expected: PASS (no call sites consume the new fields yet).

**Step 6: Commit.**

```bash
git add src/shared/automations-types.ts
git commit -m "feat(automations): add http-endpoint trigger shared types"
```

---

### Task 0.2: Extract reusable secret encryption

`src/main/persistence.ts` has module-private `encrypt`/`decrypt` (lines 53-88) that we need to reuse without exporting the whole store module's internals. Extract them into a concept-named module and have persistence delegate.

**Files:**
- Create: `src/main/secret-encryption.ts`
- Modify: `src/main/persistence.ts:53-88`
- Test: `src/main/secret-encryption.test.ts`

**Step 1: Write the failing test.**

```ts
// src/main/secret-encryption.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import { encryptSecret, decryptSecret } from './secret-encryption'

describe('secret-encryption (safeStorage unavailable)', () => {
  it('returns plaintext unchanged when encryption is unavailable', () => {
    expect(encryptSecret('token-123')).toBe('token-123')
    expect(decryptSecret('token-123')).toBe('token-123')
  })

  it('treats empty values as passthrough', () => {
    expect(encryptSecret('')).toBe('')
    expect(decryptSecret('')).toBe('')
  })
})
```

**Step 2: Run red.**

Run: `pnpm test src/main/secret-encryption.test.ts`
Expected: FAIL — `Cannot find module './secret-encryption'`.

**Step 3: Implement.**

```ts
// src/main/secret-encryption.ts
import { safeStorage } from 'electron'

// safeStorage-backed string encryption shared by the persistence store and the
// http-endpoint trigger. Falls back to plaintext when the OS keychain is
// unavailable (e.g. headless Linux CI) so values are never lost.
export function encryptSecret(plaintext: string): string {
  if (!plaintext || !safeStorage.isEncryptionAvailable()) {
    return plaintext
  }
  try {
    return safeStorage.encryptString(plaintext).toString('base64')
  } catch (err) {
    console.error('[secret-encryption] encryption failed:', err)
    return plaintext
  }
}

export function decryptSecret(ciphertext: string): string {
  if (!ciphertext || !safeStorage.isEncryptionAvailable()) {
    return ciphertext
  }
  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
  } catch {
    // Why: a decrypt failure usually means the value predates encryption or the
    // keychain changed — fall back to the raw string rather than losing it.
    console.warn('[secret-encryption] decryption failed — returning value as-is.')
    return ciphertext
  }
}
```

**Step 4: Run green.**

Run: `pnpm test src/main/secret-encryption.test.ts`
Expected: PASS.

**Step 5: Make persistence delegate.** In `src/main/persistence.ts`, replace the bodies of the private `encrypt`/`decrypt` (lines 53-76) with delegations, keeping the local names so existing call sites are untouched:

```ts
import { encryptSecret, decryptSecret } from './secret-encryption'
// ...
function encrypt(plaintext: string): string {
  return encryptSecret(plaintext)
}
function decrypt(ciphertext: string): string {
  return decryptSecret(ciphertext)
}
```

(Leave `encryptOptionalSecret`/`decryptOptionalSecret` as-is — they call the local `encrypt`/`decrypt`.)

**Step 6: Typecheck + run the persistence-adjacent tests.**

Run: `pnpm tc:node`
Expected: PASS.

**Step 7: Commit.**

```bash
git add src/main/secret-encryption.ts src/main/secret-encryption.test.ts src/main/persistence.ts
git commit -m "refactor(main): extract reusable safeStorage secret encryption"
```

---

## Phase 1 — Pure mapping functions (shared, highest leverage)

These are pure, IO-free, and imported by **both** the renderer (Test preview) and main (poll/fetch). Put them in `src/shared/` so there's one implementation.

### Task 1.1: Array detection + item resolution

**Files:**
- Create: `src/shared/http-endpoint-mapping.ts`
- Test: `src/shared/http-endpoint-mapping.test.ts`

**Step 1: Write failing tests** for `detectArrayPaths` and `resolveItems`:

```ts
// src/shared/http-endpoint-mapping.test.ts
import { describe, it, expect } from 'vitest'
import { detectArrayPaths, resolveItems } from './http-endpoint-mapping'

describe('detectArrayPaths', () => {
  it('finds a top-level array', () => {
    expect(detectArrayPaths([1, 2, 3])).toEqual([{ path: '', length: 3 }])
  })
  it('finds nested arrays by dot-path, largest first', () => {
    const body = { meta: { ids: [1] }, data: { results: [1, 2, 3] } }
    expect(detectArrayPaths(body)).toEqual([
      { path: 'data.results', length: 3 },
      { path: 'meta.ids', length: 1 }
    ])
  })
  it('returns [] when there is no array', () => {
    expect(detectArrayPaths({ a: 1 })).toEqual([])
  })
})

describe('resolveItems', () => {
  it('returns the array at the path', () => {
    expect(resolveItems({ data: [{ id: 1 }] }, 'data')).toEqual([{ id: 1 }])
  })
  it('treats a null itemsPath as a single whole-body item', () => {
    expect(resolveItems({ id: 1 }, null)).toEqual([{ id: 1 }])
  })
  it('returns [] when the path is missing or not an array', () => {
    expect(resolveItems({ data: 5 }, 'data')).toEqual([])
    expect(resolveItems({}, 'nope')).toEqual([])
  })
})
```

**Step 2: Run red.** `pnpm test src/shared/http-endpoint-mapping.test.ts` → FAIL (module missing).

**Step 3: Implement** (start the file):

```ts
// src/shared/http-endpoint-mapping.ts
// Pure, IO-free mapping between an HTTP response and trigger variables.
// Shared by the renderer Test preview and the main-process poller.

export type ArrayCandidate = { path: string; length: number }

// Walk the body collecting every array, keyed by dot-path (''=top level),
// sorted largest-first so the editor can default to the most likely item list.
export function detectArrayPaths(body: unknown): ArrayCandidate[] {
  const out: ArrayCandidate[] = []
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      out.push({ path, length: node.length })
      return // Why: don't descend into array elements — element fields aren't item lists.
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, path ? `${path}.${k}` : k)
      }
    }
  }
  visit(body, '')
  return out.sort((a, b) => b.length - a.length)
}

export function resolveItems(body: unknown, itemsPath: string | null): unknown[] {
  if (itemsPath === null) {
    return body === undefined ? [] : [body]
  }
  const at = itemsPath === '' ? body : getByPath(body, itemsPath)
  return Array.isArray(at) ? at : []
}
```

Add `getByPath` (also used later) supporting dotted + bracket-indexed paths:

```ts
// Resolve 'a.b[0].c' against a nested object. Returns undefined on any miss.
export function getByPath(root: unknown, path: string): unknown {
  if (path === '') return root
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1') // labels[0] -> labels.0
    .split('.')
    .filter((s) => s.length > 0)
  let cur: unknown = root
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}
```

**Step 4: Run green.** `pnpm test src/shared/http-endpoint-mapping.test.ts` → PASS.

**Step 5: Commit.**

```bash
git add src/shared/http-endpoint-mapping.ts src/shared/http-endpoint-mapping.test.ts
git commit -m "feat(automations): http endpoint array detection + item resolution"
```

### Task 1.2: Date parsing + type inference

**Step 1: Add failing tests** (append to the test file):

```ts
import { parseDateValue, inferFieldType } from './http-endpoint-mapping'

describe('parseDateValue', () => {
  it('parses ISO 8601', () => {
    expect(parseDateValue('2026-06-06T10:00:00Z')).toBe(Date.parse('2026-06-06T10:00:00Z'))
  })
  it('parses epoch seconds and milliseconds', () => {
    expect(parseDateValue(1_700_000_000)).toBe(1_700_000_000_000)
    expect(parseDateValue(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
  it('returns null for unparseable values', () => {
    expect(parseDateValue('not a date')).toBeNull()
    expect(parseDateValue(null)).toBeNull()
    expect(parseDateValue({})).toBeNull()
  })
})

describe('inferFieldType', () => {
  it('classifies primitives and dates', () => {
    expect(inferFieldType('2026-06-06T10:00:00Z')).toBe('date')
    expect(inferFieldType('hello')).toBe('string')
    expect(inferFieldType(42)).toBe('number')
    expect(inferFieldType(true)).toBe('boolean')
    expect(inferFieldType(null)).toBe('null')
  })
})
```

**Step 2: Run red.** Expected FAIL (exports missing).

**Step 3: Implement** (append to `http-endpoint-mapping.ts`):

```ts
// Heuristic epoch boundary: values below this are treated as seconds, above as
// milliseconds. ~ Sat 2001-09-09 in seconds / 1973 in ms — safely splits the two.
const EPOCH_MS_THRESHOLD = 100_000_000_000

export function parseDateValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < EPOCH_MS_THRESHOLD ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? null : t
  }
  return null
}

export function inferFieldType(value: unknown): MappedFieldType {
  if (value === null) return 'null'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return parseDateValue(value) !== null ? 'date' : 'string'
  return 'unknown'
}
```

Add the import of `MappedFieldType` at the top:

```ts
import type { MappedFieldType } from './automations-types'
```

**Step 4: Run green.** PASS.

**Step 5: Commit.**

```bash
git add src/shared/http-endpoint-mapping.ts src/shared/http-endpoint-mapping.test.ts
git commit -m "feat(automations): http endpoint date parsing + type inference"
```

### Task 1.3: Flatten an item into discovered fields

**Step 1: Failing test:**

```ts
import { flattenItem, defaultVariableName } from './http-endpoint-mapping'

describe('flattenItem', () => {
  it('flattens nested objects and arrays into dot/bracket paths', () => {
    const item = { id: 7, author: { name: 'Ada' }, labels: [{ name: 'bug' }] }
    const fields = flattenItem(item)
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]))
    expect(byPath['id'].type).toBe('number')
    expect(byPath['author.name'].sampleValue).toBe('Ada')
    expect(byPath['labels[0].name'].type).toBe('string')
  })
  it('defaults every field enabled with a sanitized variable name', () => {
    const [f] = flattenItem({ 'author.name': 'x' })
    expect(f.enabled).toBe(true)
    expect(f.variableName).toBe(defaultVariableName('author.name'))
  })
})

describe('defaultVariableName', () => {
  it('sanitizes dots and brackets to underscores', () => {
    expect(defaultVariableName('labels[0].name')).toBe('labels_0_name')
  })
})
```

**Step 2: Run red.** FAIL.

**Step 3: Implement** (append):

```ts
import type { MappedField, MappedFieldType } from './automations-types'

// Flat key from a path: trigger.http.<variableName> can't contain dots/brackets
// without nesting, so collapse them to underscores for the default name.
export function defaultVariableName(path: string): string {
  return path.replace(/\[(\d+)\]/g, '_$1').replace(/\./g, '_')
}

const MAX_FLATTEN_DEPTH = 6 // Why: bound pathological deeply-nested payloads.

export function flattenItem(item: unknown): MappedField[] {
  const out: MappedField[] = []
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_FLATTEN_DEPTH) return
    if (Array.isArray(node)) {
      node.forEach((el, i) => visit(el, `${path}[${i}]`, depth + 1))
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, path ? `${path}.${k}` : k, depth + 1)
      }
      return
    }
    // Leaf (primitive or null).
    if (path !== '') {
      out.push({
        path,
        variableName: defaultVariableName(path),
        enabled: true,
        type: inferFieldType(node),
        sampleValue: node
      })
    }
  }
  visit(item, '', 0)
  return out
}
```

**Step 4: Run green.** PASS.

**Step 5: Commit.**

```bash
git add src/shared/http-endpoint-mapping.ts src/shared/http-endpoint-mapping.test.ts
git commit -m "feat(automations): flatten http items into discovered fields"
```

### Task 1.4: Dedup key, variable mapping, date gate

**Step 1: Failing tests:**

```ts
import { buildDedupKey, mapItemToVariables, evaluateDateGate } from './http-endpoint-mapping'

describe('buildDedupKey', () => {
  it('joins the chosen field values', () => {
    expect(buildDedupKey({ id: 7, k: 'a' }, ['id', 'k'])).toBe('7 a')
  })
  it('falls back to a stable hash of the whole item when no fields resolve', () => {
    const a = buildDedupKey({ x: 1 }, [])
    const b = buildDedupKey({ x: 1 }, [])
    expect(a).toBe(b)
    expect(a).not.toBe(buildDedupKey({ x: 2 }, []))
  })
})

describe('mapItemToVariables', () => {
  it('emits only enabled fields keyed by variableName', () => {
    const fields = [
      { path: 'id', variableName: 'id', enabled: true, type: 'number' as const, sampleValue: 1 },
      { path: 'x', variableName: 'x', enabled: false, type: 'string' as const, sampleValue: '' }
    ]
    expect(mapItemToVariables({ id: 9, x: 'no' }, fields)).toEqual({ id: 9 })
  })
})

describe('evaluateDateGate', () => {
  const enabledAt = Date.parse('2026-06-01T00:00:00Z')
  it('passes when the gate field is later than enabledAt', () => {
    expect(evaluateDateGate({ at: '2026-06-02T00:00:00Z' }, 'at', enabledAt)).toBe(true)
  })
  it('fails closed when later-or-equal is not met', () => {
    expect(evaluateDateGate({ at: '2026-05-30T00:00:00Z' }, 'at', enabledAt)).toBe(false)
  })
  it('fails closed when the field is missing/unparseable', () => {
    expect(evaluateDateGate({}, 'at', enabledAt)).toBe(false)
    expect(evaluateDateGate({ at: 'nope' }, 'at', enabledAt)).toBe(false)
  })
  it('passes everything when no gate field is configured', () => {
    expect(evaluateDateGate({}, null, enabledAt)).toBe(true)
  })
})
```

**Step 2: Run red.** FAIL.

**Step 3: Implement** (append):

```ts
const KEY_SEP = ' '

export function buildDedupKey(item: unknown, dedupeFields: string[]): string {
  const parts = dedupeFields
    .map((f) => getByPath(item, f))
    .filter((v) => v !== undefined && v !== null)
  if (parts.length === 0) {
    return `hash:${stableHash(item)}` // Why: keep dedup working even when chosen fields are absent.
  }
  return parts.map((v) => String(v)).join(KEY_SEP)
}

export function mapItemToVariables(
  item: unknown,
  fields: MappedField[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.enabled) out[f.variableName] = getByPath(item, f.path)
  }
  return out
}

// Returns true if the item passes the gate (fail-closed on missing/unparseable
// when a field is configured; no gate when dateGateField is null).
export function evaluateDateGate(
  item: unknown,
  dateGateField: string | null,
  enabledAt: number
): boolean {
  if (dateGateField === null) return true
  const parsed = parseDateValue(getByPath(item, dateGateField))
  if (parsed === null) return false
  return parsed > enabledAt
}

// Small deterministic string hash (FNV-1a) — order-independent JSON is not
// required because object key order is stable for a given producer.
function stableHash(value: unknown): string {
  const json = JSON.stringify(value) ?? ''
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}
```

**Step 4: Run green.** PASS.

**Step 5: Typecheck both projects** (this file is shared):

Run: `pnpm tc:node && pnpm tc:web`
Expected: PASS.

**Step 6: Commit.**

```bash
git add src/shared/http-endpoint-mapping.ts src/shared/http-endpoint-mapping.test.ts
git commit -m "feat(automations): http dedup key, variable mapping, date gate"
```

---

## Phase 2 — HTTP request execution + secret sealing (main)

### Task 2.1: Request executor with safety bounds

**Files:**
- Create: `src/main/automations/http-endpoint-request.ts`
- Test: `src/main/automations/http-endpoint-request.test.ts`

**Step 1: Failing tests** (inject a fake `fetch` via deps for determinism):

```ts
// src/main/automations/http-endpoint-request.test.ts
import { describe, it, expect } from 'vitest'
import { executeHttpEndpointRequest } from './http-endpoint-request'
import type { HttpRequestConfig } from '../../shared/automations-types'

const base: HttpRequestConfig = { method: 'GET', url: 'https://api.test/items', headers: [], query: [] }

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch
}

describe('executeHttpEndpointRequest', () => {
  it('returns parsed JSON body + status', async () => {
    const res = await executeHttpEndpointRequest(base, { fetchImpl: fakeFetch([{ id: 1 }]) })
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ id: 1 }])
  })

  it('appends query params to the URL', async () => {
    let seenUrl = ''
    const spy = (async (url: string) => {
      seenUrl = url
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    await executeHttpEndpointRequest(
      { ...base, query: [{ key: 'a', value: '1' }] },
      { fetchImpl: spy }
    )
    expect(seenUrl).toContain('a=1')
  })

  it('rejects non-http(s) schemes', async () => {
    await expect(
      executeHttpEndpointRequest({ ...base, url: 'file:///etc/passwd' }, { fetchImpl: fakeFetch({}) })
    ).rejects.toThrow(/scheme/i)
  })
})
```

**Step 2: Run red.** FAIL.

**Step 3: Implement:**

```ts
// src/main/automations/http-endpoint-request.ts
import type { HttpRequestConfig } from '../../shared/automations-types'

export type HttpEndpointResponse = {
  status: number
  durationMs: number
  body: unknown
}

export type ExecuteOpts = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 5_000_000 // 5 MB response cap

// Performs one request with the secrets ALREADY decrypted in `request`. Enforces
// scheme allow-list, timeout, and a response-size cap. The caller decrypts.
export async function executeHttpEndpointRequest(
  request: HttpRequestConfig,
  opts: ExecuteOpts = {}
): Promise<HttpEndpointResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`)
  }
  for (const q of request.query) {
    if (q.key) url.searchParams.append(q.key, q.value)
  }
  const headers = new Headers()
  for (const h of request.headers) {
    if (h.key) headers.set(h.key, h.value)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const started = now()
  try {
    const res = await fetchImpl(url.toString(), {
      method: request.method,
      headers,
      body: request.method === 'GET' ? undefined : request.body,
      redirect: 'follow',
      signal: controller.signal
    })
    const text = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES)
    const body = parseMaybeJson(text)
    return { status: res.status, durationMs: now() - started, body }
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const text = await res.text()
  if (text.length > maxBytes) {
    throw new Error(`Response exceeded ${maxBytes} bytes`)
  }
  return text
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text // Why: non-JSON endpoints still return a usable string body.
  }
}
```

**Step 4: Run green.** `pnpm test src/main/automations/http-endpoint-request.test.ts` → PASS.

**Step 5: Commit.**

```bash
git add src/main/automations/http-endpoint-request.ts src/main/automations/http-endpoint-request.test.ts
git commit -m "feat(automations): http endpoint request executor with safety bounds"
```

### Task 2.2: Seal / mask / decrypt secrets

**Files:**
- Create: `src/main/automations/http-endpoint-secrets.ts`
- Test: `src/main/automations/http-endpoint-secrets.test.ts`

This module brokers between the renderer (masked) and disk (ciphertext), and decrypts for a live request. Encryption is mocked-out in tests via the `secret-encryption` module (identity when safeStorage is off), so assert the **mask/reuse** logic, not the crypto.

**Step 1: Failing tests:**

```ts
// src/main/automations/http-endpoint-secrets.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false }
}))

import {
  sealHttpKeyValues,
  maskHttpKeyValues,
  decryptHttpRequest
} from './http-endpoint-secrets'
import { HTTP_SECRET_MASK } from '../../shared/automations-types'

const secret = (value: string) => ({ key: 'Authorization', value, secret: true as const })

describe('sealHttpKeyValues', () => {
  it('encrypts a freshly typed secret (plaintext != mask)', () => {
    const [out] = sealHttpKeyValues([secret('Bearer abc')], [])
    expect(out.value).toBe('Bearer abc') // identity encryption in test
    expect(out.secret).toBe(true)
  })
  it('reuses the existing ciphertext when the incoming value is the mask', () => {
    const existing = [secret('CIPHER')]
    const [out] = sealHttpKeyValues([secret(HTTP_SECRET_MASK)], existing)
    expect(out.value).toBe('CIPHER')
  })
  it('leaves non-secret pairs untouched', () => {
    const [out] = sealHttpKeyValues([{ key: 'X', value: 'plain' }], [])
    expect(out).toEqual({ key: 'X', value: 'plain' })
  })
})

describe('maskHttpKeyValues', () => {
  it('replaces secret values with the mask', () => {
    expect(maskHttpKeyValues([secret('CIPHER')])[0].value).toBe(HTTP_SECRET_MASK)
  })
})

describe('decryptHttpRequest', () => {
  it('decrypts secret header/query/body values', () => {
    const req = decryptHttpRequest({
      method: 'GET',
      url: 'https://x',
      headers: [secret('CIPHER')],
      query: []
    })
    expect(req.headers[0].value).toBe('CIPHER') // identity decryption in test
  })
})
```

**Step 2: Run red.** FAIL.

**Step 3: Implement:**

```ts
// src/main/automations/http-endpoint-secrets.ts
import { encryptSecret, decryptSecret } from '../secret-encryption'
import {
  HTTP_SECRET_MASK,
  type HttpKeyValue,
  type HttpRequestConfig
} from '../../shared/automations-types'

// On save: encrypt freshly typed secrets; reuse stored ciphertext when the
// renderer sent back the mask (i.e. the user didn't change it).
export function sealHttpKeyValues(
  incoming: HttpKeyValue[],
  existing: HttpKeyValue[]
): HttpKeyValue[] {
  return incoming.map((kv) => {
    if (!kv.secret) return kv
    if (kv.value === HTTP_SECRET_MASK) {
      const prior = existing.find((e) => e.key === kv.key && e.secret)
      return { ...kv, value: prior?.value ?? '' }
    }
    return { ...kv, value: encryptSecret(kv.value) }
  })
}

// On read for the renderer: never expose ciphertext or plaintext secrets.
export function maskHttpKeyValues(values: HttpKeyValue[]): HttpKeyValue[] {
  return values.map((kv) => (kv.secret ? { ...kv, value: HTTP_SECRET_MASK } : kv))
}

// In-main, just before a request: turn ciphertext back into plaintext.
export function decryptHttpRequest(request: HttpRequestConfig): HttpRequestConfig {
  return {
    ...request,
    headers: request.headers.map((h) => (h.secret ? { ...h, value: decryptSecret(h.value) } : h)),
    query: request.query.map((q) => (q.secret ? { ...q, value: decryptSecret(q.value) } : q)),
    body: request.bodySecret && request.body ? decryptSecret(request.body) : request.body
  }
}
```

**Step 4: Run green.** PASS.

**Step 5: Add automation-level seal/mask helpers** (operate on a whole `AutoTrigger[]`). Append to the same file:

```ts
import type { AutoTrigger } from '../../shared/automations-types'

// Seal every http-endpoint trigger's request secrets against the prior saved
// triggers (matched by trigger id) so unchanged masked values keep their ciphertext.
export function sealAutoTriggers(
  next: AutoTrigger[] | undefined,
  prior: AutoTrigger[] | undefined
): AutoTrigger[] | undefined {
  if (!next) return next
  return next.map((t) => {
    if (t.source !== 'http-endpoint' || !t.http) return t
    const priorReq = prior?.find((p) => p.id === t.id)?.http?.request
    return {
      ...t,
      http: {
        ...t.http,
        request: {
          ...t.http.request,
          headers: sealHttpKeyValues(t.http.request.headers, priorReq?.headers ?? []),
          query: sealHttpKeyValues(t.http.request.query, priorReq?.query ?? []),
          body: sealBody(t.http.request, priorReq)
        }
      }
    }
  })
}

function sealBody(req: HttpRequestConfig, prior?: HttpRequestConfig): string | undefined {
  if (!req.bodySecret || req.body === undefined) return req.body
  if (req.body === HTTP_SECRET_MASK) return prior?.body
  return encryptSecret(req.body)
}

export function maskAutoTriggers(triggers: AutoTrigger[] | undefined): AutoTrigger[] | undefined {
  if (!triggers) return triggers
  return triggers.map((t) => {
    if (t.source !== 'http-endpoint' || !t.http) return t
    return {
      ...t,
      http: {
        ...t.http,
        request: {
          ...t.http.request,
          headers: maskHttpKeyValues(t.http.request.headers),
          query: maskHttpKeyValues(t.http.request.query),
          body: t.http.request.bodySecret && t.http.request.body ? HTTP_SECRET_MASK : t.http.request.body
        }
      }
    }
  })
}
```

**Step 6: Add tests** for `sealAutoTriggers`/`maskAutoTriggers` round-trip (non-http triggers pass through untouched; http secrets get masked/resealed). Run red → implement is already done → green.

**Step 7: Typecheck + commit.**

```bash
pnpm tc:node
git add src/main/automations/http-endpoint-secrets.ts src/main/automations/http-endpoint-secrets.test.ts
git commit -m "feat(automations): seal/mask/decrypt http endpoint request secrets"
```

---

## Phase 3 — Trigger source + per-trigger engine polling

### Task 3.1: The `http-endpoint` trigger source

**Files:**
- Create: `src/main/automations/trigger-sources/http-endpoint.ts`
- Test: `src/main/automations/trigger-sources/http-endpoint.test.ts`
- Modify: `src/main/automations/trigger-sources/types.ts` (extend `PollCtx`)

**Step 1: Extend `PollCtx`** in `types.ts:3-9` so the source can read per-trigger config:

```ts
import type { ConditionOp, HttpEndpointConfig, TriggerSourceId } from '../../../shared/automations-types'

export type PollCtx = {
  since: number
  hostId: string
  repoIds?: string[]
  // Set by the engine for the per-trigger http-endpoint source; ignored by
  // the global linear/github sources.
  http?: HttpEndpointConfig
  now?: number
}
```

**Step 2: Failing test** for the source's `poll`:

```ts
// src/main/automations/trigger-sources/http-endpoint.test.ts
import { describe, it, expect } from 'vitest'
import { makeHttpEndpointSource } from './http-endpoint'
import type { HttpEndpointConfig } from '../../../shared/automations-types'

const cfg = (over: Partial<HttpEndpointConfig> = {}): HttpEndpointConfig => ({
  request: { method: 'GET', url: 'https://api.test/items', headers: [], query: [] },
  itemsPath: 'data',
  fields: [
    { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 0 },
    { path: 'updated', variableName: 'updated', enabled: true, type: 'date', sampleValue: '' }
  ],
  dedupeFields: ['id'],
  dateGateField: 'updated',
  ...over
})

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('http-endpoint source', () => {
  it('yields one event per item past the date gate, deduped by id', async () => {
    const body = {
      data: [
        { id: 1, updated: '2026-06-05T00:00:00Z' },
        { id: 2, updated: '2026-05-01T00:00:00Z' } // before enabledAt → gated out
      ]
    }
    const source = makeHttpEndpointSource({
      execute: async () => ({ status: 200, durationMs: 1, body }),
      now: () => Date.parse('2026-06-06T00:00:00Z')
    })
    const events = await collect(
      source.poll({ since: Date.parse('2026-06-01T00:00:00Z'), hostId: 'local', http: cfg() })
    )
    expect(events.map((e) => e.entityId)).toEqual(['1'])
    expect(events[0].fields).toEqual({ id: 1, updated: '2026-06-05T00:00:00Z' })
  })

  it('caps items at maxItemsPerPoll', async () => {
    const data = Array.from({ length: 5 }, (_, i) => ({ id: i, updated: '2026-06-05T00:00:00Z' }))
    const source = makeHttpEndpointSource({
      execute: async () => ({ status: 200, durationMs: 1, body: { data } }),
      now: () => Date.parse('2026-06-06T00:00:00Z')
    })
    const events = await collect(
      source.poll({ since: 0, hostId: 'local', http: cfg({ maxItemsPerPoll: 2 }) })
    )
    expect(events).toHaveLength(2)
  })

  it('throws on non-2xx so the engine logs + skips dispatch', async () => {
    const source = makeHttpEndpointSource({
      execute: async () => ({ status: 503, durationMs: 1, body: 'down' }),
      now: () => 0
    })
    await expect(collect(source.poll({ since: 0, hostId: 'local', http: cfg() }))).rejects.toThrow()
  })
})
```

**Step 3: Run red.** FAIL.

**Step 4: Implement:**

```ts
// src/main/automations/trigger-sources/http-endpoint.ts
import {
  buildDedupKey,
  evaluateDateGate,
  mapItemToVariables,
  parseDateValue,
  resolveItems
} from '../../../shared/http-endpoint-mapping'
import { decryptHttpRequest } from '../http-endpoint-secrets'
import { executeHttpEndpointRequest, type HttpEndpointResponse } from '../http-endpoint-request'
import type { HttpRequestConfig } from '../../../shared/automations-types'
import type { CandidateEvent, PollCtx, TriggerSource } from './types'

export type HttpEndpointSourceDeps = {
  // Injectable for tests; defaults to the real executor with decrypted secrets.
  execute?: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>
  now?: () => number
}

const DEFAULT_MAX_ITEMS = 100

export function makeHttpEndpointSource(deps: HttpEndpointSourceDeps = {}): TriggerSource {
  const now = deps.now ?? Date.now
  const execute =
    deps.execute ?? ((request) => executeHttpEndpointRequest(decryptHttpRequest(request)))

  return {
    id: 'http-endpoint',
    displayName: 'HTTP endpoint',
    fieldCatalog: [], // dynamic per-trigger; the editor builds it from http.fields
    poll: (ctx) => pollHttpEndpoint(ctx, execute, now)
  }
}

async function* pollHttpEndpoint(
  ctx: PollCtx,
  execute: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>,
  now: () => number
): AsyncIterable<CandidateEvent> {
  const cfg = ctx.http
  if (!cfg) return
  const res = await execute(cfg.request)
  if (res.status < 200 || res.status >= 300) {
    // Why: surface as a thrown error so the engine's per-source catch logs it
    // and advances the poll clock without polluting the dedup store.
    throw new Error(`HTTP ${res.status} from ${cfg.request.url}`)
  }
  const items = resolveItems(res.body, cfg.itemsPath)
  const cap = cfg.maxItemsPerPoll ?? DEFAULT_MAX_ITEMS
  let yielded = 0
  for (const item of items) {
    if (yielded >= cap) break
    if (!evaluateDateGate(item, cfg.dateGateField, ctx.since)) continue
    const vars = mapItemToVariables(item, cfg.fields)
    const gateMs = cfg.dateGateField ? parseDateValue(getGate(item, cfg.dateGateField)) : null
    yield {
      entityId: buildDedupKey(item, cfg.dedupeFields),
      // Why: provenance only — the engine re-checks updatedAt >= since, and a
      // no-gate item must pass, so fall back to poll time.
      updatedAt: gateMs ?? now(),
      payload: vars,
      fields: vars
    }
    yielded++
  }
}

function getGate(item: unknown, field: string): unknown {
  return (item as Record<string, unknown>)?.[field]
}
```

(If `getGate` needs dotted paths, import `getByPath` instead — use `getByPath(item, field)`.)

**Step 5: Run green.** PASS.

**Step 6: Commit.**

```bash
pnpm tc:node
git add src/main/automations/trigger-sources/http-endpoint.ts src/main/automations/trigger-sources/http-endpoint.test.ts src/main/automations/trigger-sources/types.ts
git commit -m "feat(automations): http-endpoint trigger source with date gate + dedup"
```

### Task 3.2: Per-trigger polling in the engine

The engine currently groups by source and polls once per tick (`auto-trigger-engine.ts:110-128`). HTTP triggers each have their own endpoint + interval, so they need a separate per-trigger path.

**Files:**
- Modify: `src/main/automations/auto-trigger-engine.ts`
- Test: `src/main/automations/auto-trigger-engine.test.ts` (add cases)

**Step 1: Add deps** for per-trigger poll timing. In `AutoTriggerEngineDeps` (lines 6-30) add:

```ts
  // Per-http-trigger interval gate clock (in-memory, keyed by trigger id).
  httpLastPoll: (triggerId: string) => number
  httpLastPollSet: (triggerId: string, value: number) => void
```

**Step 2: Failing test** — a polling-enabled http trigger fires per item; a manual-only one (pollingEnabled=false) does not; per-trigger interval gating skips an early re-poll. Use the existing `auto-trigger-engine-test-fixtures.ts` style (a fake registry + in-memory dedup). Sketch:

```ts
it('polls an http-endpoint trigger per-trigger and respects pollingEnabled', async () => {
  // registry returns makeHttpEndpointSource with a stub execute returning 1 item
  // automation has an http AutoTrigger { enabled:true, pollingEnabled:true, http:{...} }
  // assert dispatchAutoRun called once; entityId == dedup key
})

it('does not poll a manual-only http trigger (pollingEnabled=false)', async () => { ... })

it('skips an http trigger still inside its intervalMs', async () => {
  // httpLastPoll returns now-1000; intervalMs=300000 → no execute call
})
```

**Step 3: Run red.** FAIL.

**Step 4: Implement.** In `tick()`, after collecting `active` (lines 82-96) split http from the rest. Replace the source-grouping loop so http triggers go through a new `pollHttpTrigger`:

```ts
// Partition: http-endpoint triggers poll per-trigger (own endpoint + interval);
// all other sources keep the shared grouped poll.
const httpEntries = active.filter(
  (e) => e.trigger.source === 'http-endpoint' && (e.trigger.pollingEnabled ?? true)
)
const sharedEntries = active.filter((e) => e.trigger.source !== 'http-endpoint')

// ... existing bySource grouping/loop runs over sharedEntries ...

for (const entry of httpEntries) {
  try {
    await this.pollHttpTrigger(entry)
  } catch (err) {
    this.reportError(`tick:http(${entry.trigger.id})`, err)
  }
}
```

Add the method:

```ts
private async pollHttpTrigger(entry: ActiveEntry): Promise<void> {
  const { automation, trigger } = entry
  if (!trigger.http) return
  const nowMs = this.deps.now()
  const intervalMs = trigger.http.intervalMs ?? this.intervalMs
  if (nowMs - this.deps.httpLastPoll(trigger.id) < intervalMs) return
  // Why: stamp the clock BEFORE polling so a slow request can't double-fire on
  // the next overlapping tick.
  this.deps.httpLastPollSet(trigger.id, nowMs)

  const source = this.deps.registry.get('http-endpoint')
  if (!source) return
  for await (const event of source.poll({
    since: trigger.enabledAt,
    hostId: this.deps.hostId,
    http: trigger.http
  })) {
    try {
      if (this.deps.dedupHas(automation.id, trigger.id, event.entityId)) continue
      const rule = firstMatch(trigger.rules, event)
      if (!rule) continue
      this.deps.dedupInsert(
        automation.id,
        trigger.id,
        trigger.source,
        event.entityId,
        event.entityIdentifier,
        this.deps.now()
      )
      await this.deps.dispatchAutoRun({ automation, trigger, rule, event })
    } catch (err) {
      this.reportError(`tick:http-event(${trigger.id}:${event.entityId})`, err)
    }
  }
}
```

Note: an http trigger with **empty `rules`** never matches (`firstMatch([]) === undefined`). To support "run on every item with no conditions," treat an empty rules array as a single implicit match targeting `automation.projectId`. Add at the top of the for-await body:

```ts
const rule = trigger.rules.length === 0
  ? { id: 'implicit', conditions: [], projectId: automation.projectId }
  : firstMatch(trigger.rules, event)
if (!rule) continue
```

**Step 5: Run green.** `pnpm test src/main/automations/auto-trigger-engine.test.ts` → PASS.

**Step 6: Commit.**

```bash
pnpm tc:node
git add src/main/automations/auto-trigger-engine.ts src/main/automations/auto-trigger-engine.test.ts
git commit -m "feat(automations): per-trigger http polling in the auto-trigger engine"
```

---

## Phase 4 — Service dispatch + bootstrap wiring

### Task 4.1: `buildTriggerContext` + `dispatchAutoRun` http branch

**Files:**
- Modify: `src/main/automations/service.ts` (`buildTriggerContext` 672-689; `dispatchAutoRun` 622-670)
- Test: `src/main/automations/service.test.ts` (add cases)

**Step 1: Failing test** — `dispatchAutoRun` for an http-endpoint trigger seeds `run.context.trigger.http` from `event.payload` and targets `rule.projectId`. Mirror the existing linear/github dispatch tests in `service.test.ts`.

**Step 2: Run red.** FAIL.

**Step 3: Implement.** In `buildTriggerContext` (after the `github` block, ~line 679):

```ts
if (payload?.http) {
  triggerContext.http = payload.http
}
```

In `dispatchAutoRun` (the `else` at line 663-665), replace the bare fallback with an http branch:

```ts
} else if (trigger.source === 'http-endpoint') {
  // event.payload already holds the mapped variables (trigger.http.*).
  runPayload = {
    projectId: rule.projectId,
    http: event.payload as Record<string, unknown>
  }
} else {
  runPayload = { projectId: rule.projectId }
}
```

**Step 4: Run green.** PASS.

**Step 5: Commit.**

```bash
pnpm tc:node
git add src/main/automations/service.ts src/main/automations/service.test.ts
git commit -m "feat(automations): dispatch http-endpoint auto-runs into trigger.http context"
```

### Task 4.2: Register the source + per-trigger watermarks in bootstrap

**Files:**
- Modify: `src/main/index.ts` (registry block ~682-687; engine deps ~698-729; watermark map ~692)

**Step 1:** Register the source after the github line (`index.ts:684`):

```ts
triggerSourceRegistry.register(makeHttpEndpointSource())
```

Add the import near `index.ts:64-68`:

```ts
import { makeHttpEndpointSource } from './automations/trigger-sources/http-endpoint'
```

**Step 2:** Add per-trigger poll-clock deps to the `new AutoTriggerEngine({...})` wiring (after `lastPollSet`, ~line 725), reusing the existing in-memory `autoTriggerWatermarks` map with an `http|` key prefix:

```ts
httpLastPoll: (triggerId: string) => autoTriggerWatermarks.get(`http|${triggerId}`) ?? 0,
httpLastPollSet: (triggerId: string, value: number) => {
  autoTriggerWatermarks.set(`http|${triggerId}`, value)
},
```

**Step 3: Typecheck.**

Run: `pnpm tc:node`
Expected: PASS.

**Step 4: Manual sanity (no test):** confirm `registry.list()` now includes `http-endpoint` by checking the `registry.test.ts` still passes and adding an assertion there if it enumerates sources.

**Step 5: Commit.**

```bash
git add src/main/index.ts
git commit -m "feat(automations): wire http-endpoint source + per-trigger poll clock"
```

---

## Phase 5 — IPC: test, fetchItems

### Task 5.1: Main handlers

**Files:**
- Create: `src/main/ipc/http-endpoint.ts`
- Modify: `src/main/ipc/register-core-handlers.ts` (import ~27, call ~100)
- Test: `src/main/ipc/http-endpoint.test.ts`

The handlers need the `Store` (to resolve masked secrets against the saved automation, and to look up the config for fetchItems).

**Channels:**
- `httpEndpoint:test` — args `{ request: HttpRequestConfig; automationId?: string; autoTriggerId?: string }` → `{ status, durationMs, body }`. Resolves mask sentinels to stored ciphertext, decrypts, executes. **Strips request secrets from the response** (returns only `status/durationMs/body`).
- `httpEndpoint:fetchItems` — args `{ automationId: string; autoTriggerId: string }` → `HttpEndpointItem[]`. Looks up the saved trigger, decrypts, executes, maps items.

**Step 1: Failing test** (inject a fake executor through a small seam — export the handler bodies as plain functions taking deps, then register them):

Design the module as testable functions + a thin `register`:

```ts
// src/main/ipc/http-endpoint.ts
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { decryptHttpRequest } from '../automations/http-endpoint-secrets'
import { executeHttpEndpointRequest, type HttpEndpointResponse } from '../automations/http-endpoint-request'
import { resolveItems, mapItemToVariables, buildDedupKey, getByPath } from '../../shared/http-endpoint-mapping'
import { HTTP_SECRET_MASK, type HttpEndpointItem, type HttpRequestConfig } from '../../shared/automations-types'

export type HttpEndpointIpcDeps = {
  store: Store
  execute?: (request: HttpRequestConfig) => Promise<HttpEndpointResponse>
}

// Resolve mask sentinels in a draft request against the saved trigger's stored
// ciphertext, then decrypt for execution.
export function resolveDraftRequest(
  store: Store,
  request: HttpRequestConfig,
  automationId?: string,
  autoTriggerId?: string
): HttpRequestConfig {
  const saved = automationId
    ? store
        .listAutomations()
        .find((a) => a.id === automationId)
        ?.autoTriggers?.find((t) => t.id === autoTriggerId)?.http?.request
    : undefined
  const merge = (kv: { key: string; value: string; secret?: boolean }): typeof kv => {
    if (kv.secret && kv.value === HTTP_SECRET_MASK) {
      const prior = saved?.headers.concat(saved?.query ?? []).find((s) => s.key === kv.key && s.secret)
      return { ...kv, value: prior?.value ?? '' }
    }
    return kv
  }
  return decryptHttpRequest({
    ...request,
    headers: request.headers.map(merge),
    query: request.query.map(merge)
  })
}

export async function runTest(
  deps: HttpEndpointIpcDeps,
  args: { request: HttpRequestConfig; automationId?: string; autoTriggerId?: string }
): Promise<HttpEndpointResponse> {
  const execute = deps.execute ?? executeHttpEndpointRequest
  const resolved = resolveDraftRequest(deps.store, args.request, args.automationId, args.autoTriggerId)
  const res = await execute(resolved)
  // Why: never echo request secrets back — return only the response triple.
  return { status: res.status, durationMs: res.durationMs, body: res.body }
}

export async function runFetchItems(
  deps: HttpEndpointIpcDeps,
  args: { automationId: string; autoTriggerId: string }
): Promise<HttpEndpointItem[]> {
  const execute = deps.execute ?? executeHttpEndpointRequest
  const trigger = deps.store
    .listAutomations()
    .find((a) => a.id === args.automationId)
    ?.autoTriggers?.find((t) => t.id === args.autoTriggerId)
  const cfg = trigger?.http
  if (!cfg) return []
  const res = await execute(decryptHttpRequest(cfg.request))
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
  const items = resolveItems(res.body, cfg.itemsPath)
  return items.map((item, i) => {
    const vars = mapItemToVariables(item, cfg.fields)
    return {
      key: cfg.dedupeFields.length ? buildDedupKey(item, cfg.dedupeFields) : String(i),
      label: String(cfg.labelField ? getByPath(item, cfg.labelField) ?? '' : `Item ${i + 1}`),
      subtitle: String(cfg.subtitleField ? getByPath(item, cfg.subtitleField) ?? '' : ''),
      vars
    }
  })
}

export function registerHttpEndpointHandlers(deps: HttpEndpointIpcDeps): void {
  ipcMain.handle('httpEndpoint:test', (_e, args) => runTest(deps, args))
  ipcMain.handle('httpEndpoint:fetchItems', (_e, args) => runFetchItems(deps, args))
}
```

Test `runTest`/`runFetchItems` directly with a fake `store` + injected `execute` (no ipcMain needed): assert mask resolution, secret stripping, item mapping, and non-2xx throw.

**Step 2-4:** Red → implement (above) → green: `pnpm test src/main/ipc/http-endpoint.test.ts`.

**Step 5: Wire into bootstrap.** In `register-core-handlers.ts`, import and call inside the `if (automations)` block (~line 99-101) — it has `store` in scope:

```ts
import { registerHttpEndpointHandlers } from './http-endpoint'
// ...
if (automations) {
  registerAutomationHandlers(store, automations)
  registerHttpEndpointHandlers({ store })
}
```

**Step 6: Mask secrets on the way out.** In `src/main/ipc/automations.ts`, wrap the three automation-returning handlers so http secrets never leave main. Add `import { maskAutoTriggers } from '../automations/http-endpoint-secrets'` and a local `maskAutomation`:

```ts
const maskAutomation = (a: Automation): Automation => ({
  ...a,
  autoTriggers: maskAutoTriggers(a.autoTriggers)
})
```

- `automations:list` → `store.listAutomations().map(maskAutomation)`
- `automations:create` → `maskAutomation(store.createAutomation(sealInput(input)))`
- `automations:update` → `maskAutomation(store.updateAutomation(args.id, sealUpdates(args.id, args.updates)))`

where `sealInput`/`sealUpdates` apply `sealAutoTriggers` against the prior stored automation:

```ts
import { sealAutoTriggers } from '../automations/http-endpoint-secrets'

const sealInput = (input: AutomationCreateInput): AutomationCreateInput => ({
  ...input,
  autoTriggers: sealAutoTriggers(input.autoTriggers, undefined)
})
const sealUpdates = (id: string, updates: AutomationUpdateInput): AutomationUpdateInput => {
  if (!('autoTriggers' in updates)) return updates
  const prior = store.listAutomations().find((a) => a.id === id)
  return { ...updates, autoTriggers: sealAutoTriggers(updates.autoTriggers, prior?.autoTriggers) }
}
```

Add a test in `http-endpoint.test.ts` (or a new `automations-secret-masking.test.ts`) asserting: after create→list, a secret header value equals `HTTP_SECRET_MASK`; after update with a masked value, the stored ciphertext is preserved (round-trip through a real `Store` instance backed by a temp file, or a fake store).

**Step 7: Typecheck + commit.**

```bash
pnpm tc:node
git add src/main/ipc/http-endpoint.ts src/main/ipc/http-endpoint.test.ts src/main/ipc/register-core-handlers.ts src/main/ipc/automations.ts
git commit -m "feat(automations): http endpoint test/fetchItems IPC + secret masking"
```

### Task 5.2: Preload bridge + types

**Files:**
- Modify: `src/preload/index.ts` (add `httpEndpoint` to the `api` object, ~after the `triggerSources` block line 2707)
- Modify: `src/preload/api-types.ts` (add `httpEndpoint` to `PreloadApi`, ~after line 1447)

**Step 1:** In `src/preload/index.ts`, import the new types (extend the existing `../shared/automations-types` import at lines 97-109) and add:

```ts
  httpEndpoint: {
    test: (args: {
      request: HttpRequestConfig
      automationId?: string
      autoTriggerId?: string
    }): Promise<{ status: number; durationMs: number; body: unknown }> =>
      ipcRenderer.invoke('httpEndpoint:test', args),
    fetchItems: (args: { automationId: string; autoTriggerId: string }): Promise<HttpEndpointItem[]> =>
      ipcRenderer.invoke('httpEndpoint:fetchItems', args)
  },
```

**Step 2:** Mirror in `api-types.ts` `PreloadApi`:

```ts
  httpEndpoint: {
    test: (args: { request: HttpRequestConfig; automationId?: string; autoTriggerId?: string }) =>
      Promise<{ status: number; durationMs: number; body: unknown }>
    fetchItems: (args: { automationId: string; autoTriggerId: string }) => Promise<HttpEndpointItem[]>
  }
```

Add `HttpRequestConfig, HttpEndpointItem` to the automations-types import blocks in both files.

**Step 3: Typecheck.** `pnpm tc:node` (preload is in the node project). Expected PASS.

**Step 4: Commit.**

```bash
git add src/preload/index.ts src/preload/api-types.ts
git commit -m "feat(preload): expose httpEndpoint test/fetchItems to the renderer"
```

---

## Phase 6 — Renderer: endpoint editor + Test/mapping UI

This is the largest renderer piece. Build it as a dedicated card rendered when `trigger.source === 'http-endpoint'`, reusing the existing rules UI (`AutoTriggerRuleRow`) for conditions.

### Task 6.1: Derive a condition field catalog from `http.fields`

**Files:**
- Create: `src/renderer/src/components/automations/editor/http-endpoint-field-catalog.ts`
- Test: `…/http-endpoint-field-catalog.test.ts`

The rules condition editor consumes `SerializableFieldDescriptor[]`. HTTP fields have no `fetchOptions`, so map types → `valueKind` + `ops`.

**Step 1: Failing test:**

```ts
import { httpFieldsToCatalog } from './http-endpoint-field-catalog'

it('maps number fields to numeric ops and string fields to equality ops', () => {
  const cat = httpFieldsToCatalog([
    { path: 'id', variableName: 'id', enabled: true, type: 'number', sampleValue: 1 },
    { path: 's', variableName: 's', enabled: true, type: 'string', sampleValue: 'x' },
    { path: 'off', variableName: 'off', enabled: false, type: 'string', sampleValue: '' }
  ])
  expect(cat.map((d) => d.field)).toEqual(['id', 's']) // disabled excluded
  expect(cat[0].valueKind).toBe('number')
  expect(cat[0].ops).toContain('gte')
  expect(cat[1].valueKind).toBe('string')
  expect(cat.every((d) => d.hasFetchOptions === false)).toBe(true)
})
```

**Step 2-4:** Red → implement → green:

```ts
// src/renderer/src/components/automations/editor/http-endpoint-field-catalog.ts
import type { ConditionOp, MappedField, SerializableFieldDescriptor } from '../../../../../shared/automations-types'

const NUMBER_OPS: ConditionOp[] = ['eq', 'gte', 'lte', 'is-any-of']
const STRING_OPS: ConditionOp[] = ['is', 'is-not', 'is-any-of', 'is-none-of']

// Build the condition editor catalog from the Test-derived fields. HTTP fields
// carry no fetchOptions, so values are free-typed (valueKind string/number).
export function httpFieldsToCatalog(fields: MappedField[]): SerializableFieldDescriptor[] {
  return fields
    .filter((f) => f.enabled)
    .map((f) => ({
      field: f.variableName,
      label: f.path,
      valueKind: f.type === 'number' ? 'number' : 'string',
      ops: f.type === 'number' ? NUMBER_OPS : STRING_OPS,
      hasFetchOptions: false
    }))
}
```

**Step 5: Commit.**

```bash
pnpm tc:web
git add src/renderer/src/components/automations/editor/http-endpoint-field-catalog.ts src/renderer/src/components/automations/editor/http-endpoint-field-catalog.test.ts
git commit -m "feat(renderer): derive condition catalog from http endpoint fields"
```

### Task 6.2: Pure reducers for the endpoint config

Mirror the `AutoTriggerCard` pattern of exporting pure reducers and unit-testing them before wiring JSX.

**Files:**
- Create: `src/renderer/src/components/automations/editor/http-endpoint-card-state.ts`
- Test: `…/http-endpoint-card-state.test.ts`

Reducers (all `(trigger: AutoTrigger, …) => AutoTrigger`, operating on `trigger.http`):
- `setRequestField(trigger, patch: Partial<HttpRequestConfig>)`
- `addHeader/removeHeader/updateHeader(trigger, i, patch)` and the same for query
- `toggleHeaderSecret(trigger, i)`
- `applyTestMapping(trigger, { itemsPath, fields, sampleResponse })` — sets the derived catalog data
- `toggleFieldEnabled(trigger, path)` / `renameField(trigger, path, variableName)`
- `setDedupeFields/setDateGateField/setIntervalMs/setLabelField/setSubtitleField`
- `setPollingEnabled(trigger, v)` / `setManualEnabled(trigger, v)` — and **derive `enabled = pollingEnabled || manualEnabled`** so the engine's master switch reflects the two capability toggles.

Write tests for the non-trivial ones (`applyTestMapping` preserves prior enabled/rename choices for fields whose `path` still exists — drift handling; `setPollingEnabled(false)` with manual on keeps `enabled` true). Then implement. Commit.

```bash
pnpm tc:web
git add src/renderer/src/components/automations/editor/http-endpoint-card-state.ts src/renderer/src/components/automations/editor/http-endpoint-card-state.test.ts
git commit -m "feat(renderer): pure reducers for http endpoint trigger config"
```

### Task 6.3: `HttpEndpointTriggerCard` component

**Files:**
- Create: `src/renderer/src/components/automations/editor/HttpEndpointTriggerCard.tsx`
- Test: `…/HttpEndpointTriggerCard.test.tsx` (renderToStaticMarkup smoke + a couple of interactions via the reducers)

Build the card with these sections (use shadcn primitives per `docs/STYLEGUIDE.md`; mirror `AutoTriggerCard.tsx` structure):

1. **Capability switches** — "Poll automatically" (`pollingEnabled`) and "Allow manual run" (`manualEnabled`).
2. **Request** — method `<select>`, URL `<Input>`, header rows (key/value/secret toggle; secret values render masked when `value === HTTP_SECRET_MASK`), query rows, optional body `<textarea>` with a secret toggle.
3. **Test** — a `Button` that calls `window.api.httpEndpoint.test({ request, automationId, autoTriggerId })`, stores the response, then runs the **shared** `detectArrayPaths` on `res.body`.
   - Show status + durationMs.
   - **Items dropdown** from `detectArrayPaths(body)` plus a "Whole response is a single item" option and a manual dot-path input. On change, compute `resolveItems(body, itemsPath)`, take item 0, run `flattenItem`, and call `applyTestMapping`.
4. **Field mapping checklist** — one row per `http.fields` entry: checkbox (`toggleFieldEnabled`), `path` label + sample value hint, editable `variableName` (`renameField`).
5. **Poll settings** (shown when `pollingEnabled`) — dedupe field multiselect (from enabled fields, stores `path`), date-gate field single-select (shows the **parsed date** of the sample so the user confirms), interval select (30s/1m/5m/15m → `intervalMs`).
6. **Manual settings** (shown when `manualEnabled`) — label field + subtitle field selects.
7. **Conditions** — render `AutoTriggerRuleRow`s using `httpFieldsToCatalog(http.fields)` as the `fieldCatalog` and a no-op `loadOptions` returning `[]`.

Key Test handler:

```tsx
const onTest = async (): Promise<void> => {
  setTesting(true)
  try {
    const res = await window.api.httpEndpoint.test({
      request: trigger.http!.request,
      automationId,
      autoTriggerId: trigger.id
    })
    setTestResult(res)
    setArrayCandidates(detectArrayPaths(res.body))
  } finally {
    setTesting(false)
  }
}
```

Applying a chosen items path:

```tsx
const applyItemsPath = (itemsPath: string | null): void => {
  if (!testResult) return
  const items = resolveItems(testResult.body, itemsPath)
  const fields = mergeDiscoveredFields(trigger.http!.fields, flattenItem(items[0] ?? testResult.body))
  onChange(applyTestMapping(trigger, { itemsPath, fields, sampleResponse: testResult.body }))
}
```

(`mergeDiscoveredFields` preserves prior `enabled`/`variableName` for surviving paths — implement it in `http-endpoint-card-state.ts` and unit-test it as part of Task 6.2's drift test.)

**Step: Tests.** A `renderToStaticMarkup` smoke test that the card renders given a minimal `http` config; plus assertions that clicking Test (mock `window.api.httpEndpoint.test`) populates the array dropdown. Keep heavy logic in the reducers (already tested).

**Commit:**

```bash
pnpm tc:web
git add src/renderer/src/components/automations/editor/HttpEndpointTriggerCard.tsx src/renderer/src/components/automations/editor/HttpEndpointTriggerCard.test.tsx
git commit -m "feat(renderer): http endpoint trigger editor card with Test + mapping"
```

### Task 6.4: Branch into the existing editor

**Files:**
- Modify: `src/renderer/src/components/automations/editor/AutoTriggerCard.tsx` (render `HttpEndpointTriggerCard` when `trigger.source === 'http-endpoint'`)
- Modify: `src/renderer/src/components/automations/editor/TriggersModal.tsx` (the add-trigger dropdown already lists all `sources`; ensure `addTrigger('http-endpoint')` seeds a default `http` config + `pollingEnabled: true`)
- Modify: `TriggerPill.tsx:15-18` (add `'http-endpoint': 'HTTP auto'` to `SOURCE_LABEL`)

**Step 1:** In `AutoTriggerCard.tsx`, early in the render, branch:

```tsx
if (trigger.source === 'http-endpoint') {
  return (
    <HttpEndpointTriggerCard
      trigger={trigger}
      onChange={onChange}
      onRemove={onRemove}
      automationId={automationId}
      projects={projects}
    />
  )
}
```

**Step 2:** In `TriggersModal.tsx` `addTrigger` (lines 130-144), seed http defaults when `source === 'http-endpoint'`:

```tsx
const addTrigger = (source: TriggerSourceId): void => {
  const base = { id: crypto.randomUUID(), source, enabled: true, enabledAt: Date.now(), rules: [] }
  const next =
    source === 'http-endpoint'
      ? {
          ...base,
          pollingEnabled: true,
          manualEnabled: false,
          http: {
            request: { method: 'GET' as const, url: '', headers: [], query: [] },
            itemsPath: null,
            fields: [],
            dedupeFields: [],
            dateGateField: null
          }
        }
      : base
  setDraftAutoTriggers((list) => [...list, next])
}
```

**Step 3:** Update `TriggerPill.tsx` `SOURCE_LABEL` and `AutoTriggerCard.tsx` `SOURCE_META` (line 47-52) to include `'http-endpoint': { label: 'HTTP endpoint', icon: Globe }` (import `Globe` from `lucide-react`).

**Step 4: Tests.** Extend `TriggersModal.menu.test.tsx` / `TriggerPill.test.tsx` for the new source label, and `AutoTriggerCard.test.tsx` to assert the http branch renders the endpoint card.

**Step 5: Typecheck + commit.**

```bash
pnpm tc:web
git add src/renderer/src/components/automations/editor/AutoTriggerCard.tsx src/renderer/src/components/automations/editor/TriggersModal.tsx src/renderer/src/components/automations/editor/TriggerPill.tsx
git commit -m "feat(renderer): surface http-endpoint trigger in the editor + pill"
```

---

## Phase 7 — Renderer: available variables + dry-run

### Task 7.1: `trigger.http.*` overlay from saved fields

**Files:**
- Modify: `src/renderer/src/components/automations/editor/chain-editor-modal-state.ts` (`buildTriggerSchema` ~93-107)
- Test: `…/chain-editor-modal-state.test.ts`

**Step 1: Failing test** — given an automation with an http-endpoint trigger whose `http.fields` has an enabled `id:number` and `title:string`, `buildTriggerSchema` returns `{ …, http: { id: 'number', title: 'string' } }`, and `getAvailableVariablesAtStep` lists `trigger.http.id`.

**Step 2: Run red.** FAIL.

**Step 3: Implement.** Extend `buildTriggerSchema` to fold in http fields:

```ts
const httpTrigger = autoTriggers.find((t) => t.source === 'http-endpoint' && t.http)
if (httpTrigger?.http) {
  const httpSchema: Record<string, string> = {}
  for (const f of httpTrigger.http.fields) {
    if (f.enabled) httpSchema[f.variableName] = f.type === 'number' ? 'number' : 'string'
  }
  base.http = httpSchema
}
```

(`base.http` is a flat `OutputSchema` — the `NestedSchema` walker treats it as leaves, yielding `trigger.http.<name>` paths.)

**Step 4: Run green.** PASS.

**Step 5: Typecheck + commit.**

```bash
pnpm tc:web
git add src/renderer/src/components/automations/editor/chain-editor-modal-state.ts src/renderer/src/components/automations/editor/chain-editor-modal-state.test.ts
git commit -m "feat(renderer): expose trigger.http.* variables from the Test mapping"
```

---

## Phase 8 — Renderer: manual Run-Now picker

### Task 8.1: HTTP item picker + RunNow wiring

**Files:**
- Create: `src/renderer/src/components/automations/editor/HttpEndpointItemPicker.tsx`
- Modify: `src/renderer/src/components/automations/editor/RunNowConfirmModal.tsx`
- Test: `…/HttpEndpointItemPicker.test.tsx`, extend `RunNowConfirmModal.test.tsx`

**Step 1:** `HttpEndpointItemPicker` props: `{ automationId, autoTriggerId, onSelect: (vars: Record<string, unknown>) => void }`. On mount it calls `window.api.httpEndpoint.fetchItems({ automationId, autoTriggerId })`, renders a searchable list (`label` + `subtitle`), and on pick calls `onSelect(item.vars)`. Mirror `LinearIssuePicker.tsx` structure (debounced filter over the fetched array — the list is already in memory, so filter client-side).

**Step 2:** In `RunNowConfirmModal.tsx` (state ~37-71), add:

```tsx
const httpTrigger = props.automation.autoTriggers?.find(
  (t) => t.source === 'http-endpoint' && t.manualEnabled
)
const needsHttp = !!httpTrigger
const [pickedHttp, setPickedHttp] = useState<Record<string, unknown> | null>(null)
```

Extend `canRun` to require `pickedHttp` when `needsHttp`, render the picker when `httpTrigger` exists, and in `handleRun` add `if (pickedHttp) payload.http = pickedHttp`.

**Step 3: Tests.** `HttpEndpointItemPicker.test.tsx`: mock `window.api.httpEndpoint.fetchItems` returning two items; assert both render and selecting one calls `onSelect` with its `vars`. Extend `RunNowConfirmModal.test.tsx`: with a manual http trigger, Run is disabled until an item is picked, and the payload carries `http`.

**Step 4: Typecheck + commit.**

```bash
pnpm tc:web
git add src/renderer/src/components/automations/editor/HttpEndpointItemPicker.tsx src/renderer/src/components/automations/editor/RunNowConfirmModal.tsx src/renderer/src/components/automations/editor/HttpEndpointItemPicker.test.tsx src/renderer/src/components/automations/editor/RunNowConfirmModal.test.tsx
git commit -m "feat(renderer): manual run-time HTTP item picker"
```

---

## Phase 9 — Security tests, end-to-end, polish

### Task 9.1: Secret-leak guard tests

**Files:**
- Create/extend: `src/main/ipc/http-endpoint.test.ts`

Assert the invariants that matter most:
- `runTest` response contains only `{ status, durationMs, body }` — no `request`, no header values.
- After `automations:create` with a secret header, `automations:list` returns `HTTP_SECRET_MASK` for that value (never plaintext or ciphertext-that-round-trips-to-plaintext). Use a real `Store` over a temp dir if available, else a fake store implementing `listAutomations/createAutomation/updateAutomation`.
- `decryptHttpRequest` is only ever called inside `runTest`/`runFetchItems`/the source poll — grep-level assertion is manual, but add a unit test that the masked automation returned to the renderer, when fed back through `sealAutoTriggers` against the prior, preserves the original ciphertext (no plaintext loss on a no-op edit).

Commit:

```bash
pnpm tc:node
git add src/main/ipc/http-endpoint.test.ts
git commit -m "test(automations): http endpoint secret-leak invariants"
```

### Task 9.2: Engine end-to-end test

**Files:**
- Extend: `src/main/automations/auto-trigger-engine.e2e.test.ts`

Seed a fake http source (stub `execute` returning 2 items, one past and one before `enabledAt`); run one engine tick; assert exactly one `dispatchAutoRun` with `trigger.http` context resolving in a templated step (mirror the existing linear e2e). Assert a second tick within `intervalMs` polls nothing and the deduped item never re-fires.

Commit:

```bash
pnpm tc:node
git add src/main/automations/auto-trigger-engine.e2e.test.ts
git commit -m "test(automations): http endpoint poll → dispatch e2e"
```

### Task 9.3: Final verification + design-doc status

**Step 1:** Run the full targeted verification:

```bash
pnpm tc:node
pnpm tc:web
pnpm test src/shared/http-endpoint-mapping.test.ts
pnpm test src/main/automations/http-endpoint-request.test.ts
pnpm test src/main/automations/http-endpoint-secrets.test.ts
pnpm test src/main/automations/trigger-sources/http-endpoint.test.ts
pnpm test src/main/automations/auto-trigger-engine.test.ts
pnpm test src/main/ipc/http-endpoint.test.ts
```

All expected PASS. (Do not gate on `pnpm test` whole-suite or `pnpm tc:cli` — known unrelated failures.)

**Step 2:** Flip the design doc status header to `Implemented` and note any deviations.

**Step 3: Commit.**

```bash
git add docs/plans/2026-06-06-http-endpoint-trigger-design.md
git commit -m "docs: mark http endpoint trigger design implemented"
```

---

## Risks the executor must keep in mind

- **Engine partition correctness.** The http path must not double-poll: stamp `httpLastPollSet` before awaiting the request. Verify the shared linear/github grouped path is untouched (its tests must stay green).
- **Secret chokepoints.** Every automation that reaches the renderer must pass through `maskAutoTriggers` (list/create/update returns). Every outbound request must pass through `decryptHttpRequest`. Don't add a new automation-returning IPC without masking.
- **Empty rules = run-on-every-item.** The implicit-match branch in the engine is what makes "no conditions" fire; don't drop it.
- **Drift on re-Test.** `mergeDiscoveredFields` must preserve prior `enabled`/`variableName` for surviving paths so a re-Test doesn't silently reset the user's mapping or break `{{trigger.http.*}}` references.
- **Cross-platform.** No `metaKey` hardcoding in the new UI; use the repo's platform helper for any shortcut labels. `fetch`/`URL`/`AbortController` are platform-neutral.
- **SSH.** Polling runs in the scheduler-owner main process; secrets stay host-side. Nothing in this plan assumes local-only execution.
