# GitHub PR Auto-Trigger Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `github-pr` automatic trigger that fires when a PR is opened in a watched repo, and a `create-worktree` "from pull request" mode that builds a worktree on the PR's branch via templates.

**Architecture:** Mirror the existing Linear auto-trigger source pattern. The engine stays source-agnostic via three generic optional fields (`AutoTrigger.repoIds`, `PollCtx.repoIds`, `CandidateEvent.repoId`). PR-worktree creation reuses the manual Start-from-PR backend (`resolvePrBase` + `createLocalWorktree`), which already supports fork push-targets and `linkedPR`.

**Tech Stack:** Electron main + renderer (React), TypeScript (typecheck via `pnpm tc`), Vitest (`npx vitest run --config config/vitest.config.ts <file>`), `gh` CLI for GitHub.

**Design doc:** `docs/plans/2026-06-04-github-pr-auto-trigger-design.md`

**Conventions for every task:**
- TDD: write the failing test, run it to watch it fail, implement minimally, run to watch it pass. Use @superpowers:test-driven-development.
- Run a single test file with: `npx vitest run --config config/vitest.config.ts <path>`
- Vitest uses esbuild (no type-check at test time), so type-only additions won't block tests; run `pnpm tc` at phase boundaries.
- Commit after each task (pre-commit hook runs oxlint + oxfmt).
- Keep comments to the non-obvious "why" only (see AGENTS.md).

---

## Phase A — Shared types & schema

### Task A1: TriggerSourceId, GithubPrPayload, RunNowPayload, AutoTrigger.repoIds

**Files:**
- Modify: `src/shared/automations-types.ts`

**Step 1 — Edit `TriggerSourceId` (around line 189):**
```ts
export type TriggerSourceId = 'linear-issue' | 'github-pr'
```

**Step 2 — Add `GithubPrPayload` near `LinearIssuePayload` (after line 294):**
```ts
// Snapshot of the GitHub PR that fired a github-pr auto-trigger. Materialized
// into run.context.trigger.github.pr so steps can template against the fields.
export type GithubPrPayload = {
  number: number
  title: string
  url: string
  // Head/base branch names as reported by `gh pr list`.
  headRef: string
  baseRef: string
  author: string
  // True when the head lives on a fork — drives refs/pull/<N>/head checkout.
  isCrossRepository: boolean
  // The watched repo the PR belongs to; becomes the run's automation.projectId.
  repoId: string
}
```

**Step 3 — Extend `RunNowPayload` (line 158):**
```ts
export type RunNowPayload = {
  linear?: { issue: LinearIssuePayload }
  github?: { pr: GithubPrPayload }
  projectId?: string
}
```

**Step 4 — Extend `AutoTrigger` (line 235) with the watch-list:**
```ts
export type AutoTrigger = {
  id: string
  source: TriggerSourceId
  enabled: boolean
  enabledAt: number
  rules: Rule[]
  // Watch-list for source-scoped triggers (github-pr). The poller scopes to
  // these repos and the engine fires a trigger only for events in its list.
  // Unused by linear-issue (its events aren't repo-bound).
  repoIds?: string[]
}
```

**Step 5 — Verify typecheck:** `pnpm tc:node && pnpm tc:web` → expect PASS (additive).

**Step 6 — Commit:** `git add -A && git commit -m "feat(automations): shared types for github-pr trigger"`

---

### Task A2: GITHUB_PR_TRIGGER_OVERLAY schema

**Files:**
- Modify: `src/shared/automation-step-schemas.ts`
- Test: `src/shared/automation-step-schemas.test.ts` (create if absent; otherwise append)

**Step 1 — Write failing test** (new file `src/shared/automation-step-schemas.test.ts`, or append a `describe`):
```ts
import { describe, it, expect } from 'vitest'
import { GITHUB_PR_TRIGGER_OVERLAY } from './automation-step-schemas'

describe('GITHUB_PR_TRIGGER_OVERLAY', () => {
  it('exposes pr leaves as scalar schema types', () => {
    expect(GITHUB_PR_TRIGGER_OVERLAY.github.pr.number).toBe('number')
    expect(GITHUB_PR_TRIGGER_OVERLAY.github.pr.headRef).toBe('string')
    expect(GITHUB_PR_TRIGGER_OVERLAY.github.pr.isCrossRepository).toBe('boolean')
  })
})
```

**Step 2 — Run, expect FAIL** (export missing):
`npx vitest run --config config/vitest.config.ts src/shared/automation-step-schemas.test.ts`

**Step 3 — Implement** (add after `LINEAR_TICKET_TRIGGER_OVERLAY`, ~line 85):
```ts
// Nested overlay merged into the trigger schema when a github-pr auto-trigger
// is configured, so steps can template against the PR that fired the run.
export const GITHUB_PR_TRIGGER_OVERLAY = {
  github: {
    pr: {
      number: 'number',
      title: 'string',
      url: 'string',
      headRef: 'string',
      baseRef: 'string',
      author: 'string',
      isCrossRepository: 'boolean',
      repoId: 'string'
    }
  }
} as const
```

**Step 4 — Run, expect PASS.**

**Step 5 — Commit:** `git commit -am "feat(automations): github PR trigger variable overlay"`

---

### Task A3: CreateWorktreeConfig PR mode

**Files:**
- Modify: `src/shared/automations-types.ts` (`CreateWorktreeConfig`, line 296)

**Step 1 — Edit:**
```ts
export type CreateWorktreeConfig = {
  baseBranch: string // template
  branchName: string // template
  displayName: string // template
  linkLinearIssue: boolean
  // 'new-branch' (default, legacy) creates a fresh branch from baseBranch.
  // 'pull-request' checks out an existing PR's branch via the Start-from-PR
  // backend (fork-aware). Optional so persisted rows default to new-branch.
  mode?: 'new-branch' | 'pull-request'
  // PR number template (e.g. {{trigger.github.pr.number}}), used in PR mode.
  pullRequestRef?: string
}
```

**Step 2 — Verify:** `pnpm tc:node && pnpm tc:web` → PASS.

**Step 3 — Commit:** `git commit -am "feat(automations): create-worktree pull-request mode config"`

---

## Phase B — Engine generic extensions

### Task B1: CandidateEvent.repoId + PollCtx.repoIds

**Files:**
- Modify: `src/main/automations/trigger-sources/types.ts`

**Step 1 — Edit `PollCtx`:**
```ts
export type PollCtx = {
  since: number
  hostId: string
  // Repo ids to scope polling to (union of watching triggers' repoIds). Set by
  // the engine for source-scoped sources (github-pr); ignored by linear-issue.
  repoIds?: string[]
}
```

**Step 2 — Edit `CandidateEvent`:** add `repoId`:
```ts
export type CandidateEvent = {
  entityId: string
  entityIdentifier?: string
  updatedAt: number
  // Owning repo for repo-bound entities (github-pr). Drives the engine's
  // per-trigger watch-list guard and the dispatched run's projectId.
  repoId?: string
  payload: Record<string, unknown>
  fields: Record<string, unknown>
}
```

**Step 3 — Verify:** `pnpm tc:node` → PASS.

**Step 4 — Commit:** `git commit -am "feat(automations): repo scoping fields on trigger source contracts"`

---

### Task B2: Engine threads watch-repos into poll + per-trigger guard

**Files:**
- Modify: `src/main/automations/auto-trigger-engine.ts`
- Test: `src/main/automations/auto-trigger-engine.test.ts`

**Step 1 — Write failing tests.** Read the existing test file first to reuse its fixtures/dep-builders. Add:
```ts
it('passes the union of watching triggers repoIds into poll ctx', async () => {
  // Two enabled github-pr-style triggers with repoIds ['a'] and ['b','c'].
  // Use a fake source whose poll records the ctx it received and yields nothing.
  // Assert the recorded ctx.repoIds set === {'a','b','c'}.
})

it('fires a trigger only for events whose repoId is in its repoIds', async () => {
  // One trigger repoIds=['a']. Source yields two events: repoId 'a' (matches a
  // rule) and repoId 'b' (matches the same rule). Assert dispatchAutoRun is
  // called once, for the 'a' event only.
})

it('still fires triggers with no repoIds (linear-style) for any event', async () => {
  // trigger.repoIds undefined; event.repoId undefined; rule matches.
  // Assert dispatched.
})
```

**Step 2 — Run, expect FAIL** (`npx vitest run --config config/vitest.config.ts src/main/automations/auto-trigger-engine.test.ts`).

**Step 3 — Implement.** In `tick`, when calling `pollSource`, compute and pass repoIds; in `pollSource` add the guard.

In `tick` (replace the `await this.pollSource(...)` call near line 111):
```ts
const repoIds = unionRepoIds(group)
await this.pollSource(source, sourceId, group, since, repoIds)
```
Update `pollSource` signature + ctx + guard:
```ts
private async pollSource(
  source: TriggerSource,
  sourceId: TriggerSourceId,
  group: ActiveEntry[],
  since: number,
  repoIds: string[] | undefined
): Promise<void> {
  for await (const event of source.poll({ since, hostId: this.deps.hostId, repoIds })) {
    try {
      if (event.updatedAt <= since) continue
      for (const { automation, trigger } of group) {
        if (event.updatedAt < trigger.enabledAt) continue
        // Watch-list guard: a repo-bound event only fires triggers watching it.
        if (trigger.repoIds?.length && event.repoId && !trigger.repoIds.includes(event.repoId)) {
          continue
        }
        if (this.deps.dedupHas(automation.id, trigger.id, event.entityId)) continue
        const rule = firstMatch(trigger.rules, event)
        if (!rule) continue
        this.deps.dedupInsert(/* unchanged */)
        await this.deps.dispatchAutoRun({ automation, trigger, rule, event })
      }
    } catch (err) { this.reportError(`tick:event(${sourceId}:${event.entityId})`, err) }
  }
}
```
Add a module-level helper:
```ts
// Union of all watching triggers' repoIds; undefined when none scope by repo
// (so a global source like linear-issue receives no repo filter).
function unionRepoIds(group: ActiveEntry[]): string[] | undefined {
  const set = new Set<string>()
  for (const { trigger } of group) for (const id of trigger.repoIds ?? []) set.add(id)
  return set.size > 0 ? Array.from(set) : undefined
}
```

**Step 4 — Run, expect PASS.** Re-run the whole engine test file to confirm no regressions.

**Step 5 — Commit:** `git commit -am "feat(automations): engine scopes polling + firing by repo watch-list"`

---

## Phase C — github-pr trigger source

### Task C1: Source + event mapping (opened semantics)

**Files:**
- Create: `src/main/automations/trigger-sources/github-pr.ts`
- Test: `src/main/automations/trigger-sources/github-pr.test.ts`

Design the source with an **injectable** PR fetcher (mirroring linear-issue's injectable helpers) so tests don't shell out to `gh`:
```ts
export type GithubPr = {
  number: number; title: string; url: string; author: string
  baseRefName: string; headRefName: string; labels: string[]
  isCrossRepository: boolean; createdAt: string; updatedAt: string
}
export type GithubPrSourceDeps = {
  getRepos: () => Repo[]
  // Injectable; defaults to a gh-backed impl. Returns open PRs for one repo.
  listOpenPrs?: (repo: Repo) => Promise<GithubPr[]>
  listLabelOptions?: (repos: Repo[]) => Promise<{ value: string; label: string }[]>
  listAuthorOptions?: (repos: Repo[]) => Promise<{ value: string; label: string }[]>
}
```

**Step 1 — Write failing test** covering event mapping:
```ts
import { describe, it, expect } from 'vitest'
import { makeGithubPrSource } from './github-pr'

const repo = { id: 'r1', path: '/repos/orca', /* ...minimal Repo */ } as any
const pr = {
  number: 7, title: 'Fix', url: 'https://x/7', author: 'alice',
  baseRefName: 'main', headRefName: 'fix-7', labels: ['bug'],
  isCrossRepository: false, createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z'
}

it('maps an open PR to a CandidateEvent with opened-watermark semantics', async () => {
  const source = makeGithubPrSource({
    getRepos: () => [repo],
    listOpenPrs: async () => [pr]
  })
  const events = []
  for await (const e of source.poll({ since: 0, hostId: 'local', repoIds: ['r1'] })) events.push(e)
  expect(events).toHaveLength(1)
  const e = events[0]
  expect(e.entityId).toBe('r1#7')
  expect(e.repoId).toBe('r1')
  // updatedAt uses createdAt so only newly-opened PRs cross the watermark.
  expect(e.updatedAt).toBe(new Date(pr.createdAt).getTime())
  expect(e.fields['github.baseRef']).toBe('main')
  expect(e.fields['github.author']).toBe('alice')
  expect(e.fields['github.labels']).toEqual(['bug'])
  expect((e.payload as any).pr.headRef).toBe('fix-7')
  expect((e.payload as any).pr.repoId).toBe('r1')
})

it('only polls repos in ctx.repoIds and skips connectionId/folder repos', async () => {
  const remote = { ...repo, id: 'r2', connectionId: 'ssh1' }
  const calls: string[] = []
  const source = makeGithubPrSource({
    getRepos: () => [repo, remote],
    listOpenPrs: async (r) => { calls.push(r.id); return [] }
  })
  for await (const _ of source.poll({ since: 0, hostId: 'local', repoIds: ['r1', 'r2'] })) { /* */ }
  expect(calls).toEqual(['r1']) // r2 skipped (remote)
})
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement `github-pr.ts`.** Skeleton:
```ts
import type { Repo } from '../../../shared/types'
import type { CandidateEvent, FieldDescriptor, PollCtx, TriggerSource } from './types'
import { listOpenPrsViaGh, listRepoLabelsViaGh, listRepoAuthorsViaGh } from './github-pr-gh'

export function makeGithubPrSource(deps: GithubPrSourceDeps): TriggerSource {
  const listOpenPrs = deps.listOpenPrs ?? listOpenPrsViaGh
  const fieldCatalog: FieldDescriptor[] = [
    { field: 'github.baseRef', label: 'Base branch', valueKind: 'string',
      ops: ['is', 'is-any-of', 'is-none-of'] },
    { field: 'github.author', label: 'Author', valueKind: 'user',
      ops: ['is', 'is-not', 'is-any-of', 'is-none-of'],
      fetchOptions: () => (deps.listAuthorOptions ?? listRepoAuthorsViaGh)(deps.getRepos()) },
    { field: 'github.labels', label: 'Has label', valueKind: 'label',
      ops: ['contains-any', 'contains-all', 'contains-none'],
      fetchOptions: () => (deps.listLabelOptions ?? listRepoLabelsViaGh)(deps.getRepos()) }
  ]
  return {
    id: 'github-pr',
    displayName: 'GitHub PR',
    fieldCatalog,
    poll: (ctx) => pollGithubPrs(deps.getRepos(), listOpenPrs, ctx)
  }
}

async function* pollGithubPrs(
  repos: Repo[],
  listOpenPrs: (repo: Repo) => Promise<GithubPr[]>,
  ctx: PollCtx
): AsyncIterable<CandidateEvent> {
  const watch = new Set(ctx.repoIds ?? [])
  for (const repo of repos) {
    if (!watch.has(repo.id)) continue
    if (repo.connectionId || repo.kind === 'folder') continue // local git only (v1)
    let prs: GithubPr[] = []
    try { prs = await listOpenPrs(repo) } catch (err) {
      console.warn('[github-pr source] poll failed for', repo.id, err); continue
    }
    for (const pr of prs) yield mapPrToEvent(repo, pr)
  }
}

function mapPrToEvent(repo: Repo, pr: GithubPr): CandidateEvent {
  return {
    entityId: `${repo.id}#${pr.number}`,
    entityIdentifier: `${repo.displayName}#${pr.number}`,
    // Opened semantics: createdAt so only newly-opened PRs cross the watermark.
    updatedAt: new Date(pr.createdAt).getTime(),
    repoId: repo.id,
    payload: { pr: {
      number: pr.number, title: pr.title, url: pr.url, headRef: pr.headRefName,
      baseRef: pr.baseRefName, author: pr.author,
      isCrossRepository: pr.isCrossRepository, repoId: repo.id
    } },
    fields: {
      'github.baseRef': pr.baseRefName,
      'github.author': pr.author,
      'github.labels': pr.labels
    }
  }
}
```

**Step 4 — Run, expect PASS.**

**Step 5 — Commit:** `git commit -am "feat(automations): github-pr trigger source + event mapping"`

---

### Task C2: gh-backed fetchers (`github-pr-gh.ts`)

**Files:**
- Create: `src/main/automations/trigger-sources/github-pr-gh.ts`

These are thin `gh` wrappers; they are the injected defaults so they need only light coverage. Reuse the existing `gh` plumbing in `src/main/github/client.ts` — read it first to reuse `ghExecFileAsync`, `getOwnerRepo`, and the existing `listLabels` / `listAssignableUsers` imports (client.ts lines 39-40) rather than re-implementing.

```ts
import type { Repo } from '../../../shared/types'
import type { GithubPr } from './github-pr'
// Reuse the repo-scoped gh exec + owner/repo resolution from github/client.ts.

export async function listOpenPrsViaGh(repo: Repo): Promise<GithubPr[]> {
  // gh pr list --state open --json number,title,url,author,baseRefName,
  //   headRefName,labels,isCrossRepository,createdAt,updatedAt
  // Map author.login, labels[].name. Run in repo.path.
}
export async function listRepoLabelsViaGh(repos: Repo[]): Promise<{ value: string; label: string }[]>
export async function listRepoAuthorsViaGh(repos: Repo[]): Promise<{ value: string; label: string }[]>
```

**Step 1 — Light unit test** with a stubbed exec if the existing gh helpers are injectable; otherwise mark these as covered by the source's injected defaults and skip (note in commit). Do NOT shell out to real `gh` in tests.

**Step 2 — Commit:** `git commit -am "feat(automations): gh-backed pr/label/author fetchers"`

---

### Task C3: Register the source in main

**Files:**
- Modify: `src/main/index.ts` (after line 647)

**Step 1 — Add registration** next to the Linear source:
```ts
triggerSourceRegistry.register(
  makeGithubPrSource({ getRepos: () => storeRef.getRepos() })
)
```
Add the import near the linear-issue import (line 65).

**Step 2 — Verify:** `pnpm tc:node` → PASS. Manual: launch app later; "GitHub PR" appears in the Add-trigger menu.

**Step 3 — Commit:** `git commit -am "feat(automations): register github-pr source"`

---

## Phase D — Variable schema overlay in the editor

### Task D1: buildTriggerSchema overlays github.pr.* from autoTriggers

**Files:**
- Modify: `src/renderer/src/components/automations/editor/chain-editor-modal-state.ts`
- Test: `src/renderer/src/components/automations/editor/chain-editor-modal-state.test.ts`

**Step 1 — Write failing tests:**
```ts
it('overlays github.pr.* when an enabled github-pr auto-trigger exists', () => {
  const draft = { ...makeDraft([]), autoTriggers: [
    { id: 't', source: 'github-pr', enabled: true, enabledAt: 0, rules: [], repoIds: ['r1'] }
  ] }
  const out = getAvailableVariablesAtStep(draft, 0, [])
  const gh = (out.trigger as any).github
  expect(gh.pr.headRef).toBe('string')
})

it('does NOT overlay github.pr.* when the github-pr auto-trigger is disabled', () => {
  const draft = { ...makeDraft([]), autoTriggers: [
    { id: 't', source: 'github-pr', enabled: false, enabledAt: 0, rules: [], repoIds: [] }
  ] }
  const out = getAvailableVariablesAtStep(draft, 0, [])
  expect((out.trigger as any).github).toBeUndefined()
})
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement.** Change `buildTriggerSchema` to also take autoTriggers (line 91), and call it with `draft.autoTriggers` (line 163). Import `GITHUB_PR_TRIGGER_OVERLAY`.
```ts
export function buildTriggerSchema(
  trigger: TriggerConfig,
  autoTriggers: AutoTrigger[] = []
): NestedSchema {
  const base: NestedSchema = { ...MANUAL_TRIGGER_SCHEMA }
  if (trigger.acceptsLinearTicket) {
    base.linear = LINEAR_TICKET_TRIGGER_OVERLAY.linear
  }
  // Auto-trigger overlays: a configured + enabled source publishes its payload
  // shape at runtime, so surface its variables in the picker too.
  if (autoTriggers.some((t) => t.enabled && t.source === 'github-pr')) {
    base.github = GITHUB_PR_TRIGGER_OVERLAY.github
  }
  return base
}
```
And line 163: `trigger: buildTriggerSchema(draft.trigger, draft.autoTriggers ?? []),`. Add `AutoTrigger` to the type imports.

**Step 4 — Run, expect PASS** (run the whole file to confirm no regressions).

**Step 5 — Commit:** `git commit -am "feat(automations): surface github-pr variables in the picker"`

---

### Task D2: descriptions for github.pr.*

**Files:**
- Modify: `src/renderer/src/lib/variable-descriptions.ts`
- The completeness guard in `variable-descriptions.test.ts` will fail until every `github.pr.*` leaf has a description.

**Step 1 — Add to the test's `everyVariable()`** a trigger overlay including `github` (import `GITHUB_PR_TRIGGER_OVERLAY`) so the guard covers it; run, expect FAIL (missing descriptions).

**Step 2 — Add to `BY_PATH`** in variable-descriptions.ts:
```ts
'github.pr.number': 'Pull request number',
'github.pr.title': 'Pull request title',
'github.pr.url': 'Link to the PR on GitHub',
'github.pr.headRef': "The PR's source (head) branch",
'github.pr.baseRef': "The PR's target (base) branch",
'github.pr.author': "GitHub login of the PR's author",
'github.pr.isCrossRepository': 'True when the PR comes from a fork',
'github.pr.repoId': 'ID of the repo the PR belongs to'
```

**Step 3 — Run, expect PASS.**

**Step 4 — Commit:** `git commit -am "feat(automations): descriptions for github PR variables"`

---

## Phase E — Dispatch context

### Task E1: buildTriggerContext + dispatchAutoRun for github-pr

**Files:**
- Modify: `src/main/automations/service.ts` (`dispatchAutoRun` ~605, `buildTriggerContext` ~645)
- Test: `src/main/automations/service.test.ts` (read it first for the harness)

**Step 1 — Write failing tests:**
```ts
it('dispatchAutoRun(github-pr) sets projectId from event.repoId and injects trigger.github.pr', async () => {
  // Build an automation + a github-pr AutoTrigger + a rule + a CandidateEvent
  // with repoId 'r1' and payload.pr. Spy dispatchRun (or inspect the created
  // run). Assert run.context.automation.projectId === 'r1' and
  // run.context.trigger.github.pr.number === <pr.number>.
})
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement.** In `dispatchAutoRun`, add a branch before the `else`:
```ts
} else if (trigger.source === 'github-pr') {
  const prPayload = (event.payload as { pr?: GithubPrPayload }).pr
  if (!prPayload) {
    throw new Error(`dispatchAutoRun: github-pr event missing payload.pr (entityId=${event.entityId})`)
  }
  runPayload = { projectId: event.repoId, github: { pr: prPayload } }
} else {
  runPayload = { projectId: rule.projectId }
}
```
In `buildTriggerContext`, after the linear block:
```ts
if (payload?.github) {
  triggerContext.github = payload.github
}
```
Import `GithubPrPayload`.

**Step 4 — Run, expect PASS.**

**Step 5 — Commit:** `git commit -am "feat(automations): dispatch github-pr runs with PR context + repo"`

---

## Phase F — create-worktree PR mode

### Task F1: Extract `resolvePrBaseCore` from the IPC handler

**Files:**
- Modify: `src/main/ipc/worktrees.ts` (handler at line 276)
- Create: `src/main/git/resolve-pr-base.ts` (the extracted core)
- Test: `src/main/git/resolve-pr-base.test.ts`

**Step 1 — Extract** the handler body (lines ~286-380, ending at the return of `{ baseBranch, pushTarget? }`) into a pure-ish function:
```ts
export async function resolvePrBaseCore(args: {
  repo: Repo
  prNumber: number
  headRefName?: string
  isCrossRepository?: boolean
}): Promise<{ baseBranch: string; pushTarget?: GitPushTarget } | { error: string }>
```
Have the IPC handler call it (`store.getRepo` then `resolvePrBaseCore`). Keep all current guards (remote/folder/cross-repo fetch). This is a refactor — behavior must not change.

**Step 2 — Test** the extraction with injected `gh`/git helpers if feasible; otherwise add a focused test for the input-validation guards (remote repo → error; folder → error) using a fake Repo, and rely on existing worktrees tests for the rest. Run the existing `src/main/ipc/worktrees.test.ts` to confirm no regression.

**Step 3 — Commit:** `git commit -am "refactor(worktrees): extract resolvePrBaseCore for reuse"`

---

### Task F2: Runner PR mode + new dep

**Files:**
- Modify: `src/main/automations/runners/create-worktree-runner.ts`
- Test: `src/main/automations/runners/create-worktree-runner.test.ts` (read first)

**Step 1 — Write failing test** for PR mode:
```ts
it('in pull-request mode resolves the PR number and calls createWorktreeFromPr', async () => {
  const calls: any[] = []
  const runner = new CreateWorktreeRunner({
    now: () => 0,
    createWorktree: async () => { throw new Error('should not be called in PR mode') },
    createWorktreeFromPr: async (input) => { calls.push(input); return { worktreeId: 'w', path: '/p', branch: 'fix-7' } }
  })
  const ctx = makeCtx({
    config: { mode: 'pull-request', pullRequestRef: '{{trigger.github.pr.number}}', baseBranch: '', branchName: '', displayName: '{{trigger.github.pr.title}}', linkLinearIssue: false },
    context: { automation: { projectId: 'r1' }, trigger: { github: { pr: { number: 7, headRef: 'fix-7', isCrossRepository: false, title: 'Fix' } } } }
  })
  const res = await runner.tick(ctx)
  expect(res.status).toBe('succeeded')
  expect(calls[0]).toMatchObject({ repoId: 'r1', prNumber: 7, headRefName: 'fix-7', isCrossRepository: false })
})
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement.** Add `createWorktreeFromPr` to `CreateWorktreeDeps`:
```ts
createWorktreeFromPr: (input: {
  repoId: string; prNumber: number; headRefName?: string
  isCrossRepository?: boolean; displayName: string; createdByAutomationRunId?: string
}) => Promise<{ worktreeId: string; path: string; branch: string }>
```
In `tick`, branch on `config.mode === 'pull-request'`: resolve `pullRequestRef` template → integer (fail with a clear message if NaN); read repoId from context (existing logic); read `headRef`/`isCrossRepository` from `context.trigger.github.pr.*` (guard types like `extractLinearIssue` does); call `createWorktreeFromPr`; store tracker + contextPatch identically. New-branch mode keeps the existing path unchanged.

**Step 4 — Run, expect PASS** (run the whole runner test file).

**Step 5 — Commit:** `git commit -am "feat(automations): create-worktree pull-request mode runner"`

---

### Task F3: Wire createWorktreeFromPr in index.ts

**Files:**
- Modify: `src/main/index.ts` (AutomationService options, near the `createWorktree:` dep at line 774)
- Modify: `src/main/automations/service.ts` (thread the new dep to the runner ctor — read how `createWorktree` is currently threaded to `CreateWorktreeRunner`)

**Step 1 — Add the dep** in index.ts:
```ts
createWorktreeFromPr: async (input) => {
  if (!mainWindow) throw new Error('createWorktreeFromPr: no mainWindow available.')
  const repo = storeRef.getRepo(input.repoId)
  if (!repo) throw new Error(`createWorktreeFromPr: repo not found: ${input.repoId}`)
  const resolved = await resolvePrBaseCore({
    repo, prNumber: input.prNumber,
    headRefName: input.headRefName, isCrossRepository: input.isCrossRepository
  })
  if ('error' in resolved) throw new Error(resolved.error)
  const slug = generateUniqueWorkspaceName(
    collectTakenWorkspaceNamesForRepo(input.repoId, storeRef.getAllWorktreeMeta())
  )
  const result = await createLocalWorktree(
    {
      repoId: input.repoId,
      name: input.displayName.trim() || slug,
      workspaceName: slug,
      displayName: input.displayName.trim() || undefined,
      baseBranch: resolved.baseBranch,
      linkedPR: input.prNumber,
      ...(resolved.pushTarget ? { pushTarget: resolved.pushTarget } : {}),
      ...(input.createdByAutomationRunId ? { createdByAutomationRunId: input.createdByAutomationRunId } : {}),
      telemetrySource: 'automation'
    },
    repo, storeRef, mainWindow, runtimeRef
  )
  return { worktreeId: result.worktree.id, path: result.worktree.path, branch: result.worktree.branch }
}
```
Add imports for `resolvePrBaseCore` and `createLocalWorktree`. Confirm `'automation'` is a valid `WorkspaceSource` (else use `'unknown'`).

**Step 2 — Thread to runner.** In service.ts, wherever `new CreateWorktreeRunner({ createWorktree, now })` is built, also pass `createWorktreeFromPr` from the service options. Update the service's options type.

**Step 3 — Verify:** `pnpm tc:node` → PASS.

**Step 4 — Commit:** `git commit -am "feat(automations): wire PR-mode worktree creation to Start-from-PR backend"`

---

## Phase G — UI

> Read each component fully before editing; mirror its existing patterns and the STYLEGUIDE. Component tests use `renderToStaticMarkup` (see VariablePickerPopover.test.tsx).

### Task G1: AutoTriggerCard repo watch-list for github-pr

**Files:**
- Modify: `src/renderer/src/components/automations/editor/AutoTriggerCard.tsx` (+ its pure helpers)
- Modify: `src/renderer/src/components/automations/editor/AutoTriggerRuleRow.tsx` (hide project picker when `source === 'github-pr'`)
- Test: `AutoTriggerCard.test.tsx`

**Step 1 — Write failing test:** for a `github-pr` trigger, the card renders a repo multi-select bound to `repoIds` and does NOT render the per-rule project picker.

**Step 2 — Implement.** Add a pure helper `setRepoIds(trigger, repoIds)` (mirror `updateRule`). Render `repo-multi-combobox` (read its props in `src/renderer/src/components/ui/repo-multi-combobox.tsx`) when `trigger.source === 'github-pr'`, wired to `repoIds`. Pass a `hideProjectPicker`/`source` hint into `AutoTriggerRuleRow` so it hides the project dropdown for github-pr.

**Step 3 — Run, expect PASS.**

**Step 4 — Commit:** `git commit -am "feat(automations): repo watch-list UI for github-pr trigger"`

---

### Task G2: create-worktree step card mode toggle

**Files:**
- Modify: `src/renderer/src/components/automations/editor/CreateWorktreeStepCard.tsx`
- Test: `CreateWorktreeStepCard.test.tsx`

**Step 1 — Write failing test:** toggling to "From pull request" sets `config.mode='pull-request'` and reveals the `pullRequestRef` template input (with the variable picker, like other template fields); new-branch hides it and keeps baseBranch/branchName.

**Step 2 — Implement** the toggle + conditional fields, following the existing template-field pattern in the card (so `{{trigger.github.pr.number}}` autocompletes).

**Step 3 — Run, expect PASS.**

**Step 4 — Commit:** `git commit -am "feat(automations): create-worktree from-PR mode UI"`

---

### Task G3: TriggerPill label

**Files:**
- Modify: `src/renderer/src/components/automations/editor/TriggerPill.tsx` (`sourceLabelFor`)
- Test: `TriggerPill.test.tsx`

**Step 1 — Failing test:** an enabled github-pr auto-trigger contributes a "GitHub PR" label.

**Step 2 — Implement** `sourceLabelFor('github-pr') => 'GitHub PR'`.

**Step 3 — Run, expect PASS. Commit:** `git commit -am "feat(automations): github-pr trigger pill label"`

---

## Phase H — Full verification

**Step 1 — Typecheck:** `pnpm tc:node && pnpm tc:web` → PASS. (`tc:cli` has a pre-existing TS6307 config failure unrelated to this work — confirm it's unchanged.)

**Step 2 — Targeted tests:**
```
npx vitest run --config config/vitest.config.ts \
  src/main/automations src/shared/automation-step-schemas.test.ts \
  src/renderer/src/components/automations/editor src/renderer/src/lib/variable-descriptions.test.ts
```
Expect all PASS.

**Step 3 — Manual smoke** (see @run skill): launch the app, create an automation with a github-pr trigger watching a local repo, add `create-worktree` in From-PR mode with `pullRequestRef = {{trigger.github.pr.number}}`, open a PR in that repo, wait one poll cycle (~60s), confirm a worktree is created on the PR branch (and for a fork PR, that the push target is the contributor remote).

**Step 4 — Final review:** use @superpowers:requesting-code-review, then @superpowers:finishing-a-development-branch to open the PR.

---

## Notes / risks
- `gh` rate limits: poll only watched repos, `--state open`, once per tick.
- PR-start is local-repo-only in v1 (SSH rejected by `resolvePrBaseCore`).
- "Opened" relies on `createdAt`; PRs opened before `enabledAt` never fire (matches Linear watermark semantics). De-dup keeps a PR firing once.
- If `tc:cli`'s pre-existing config error is fixed upstream during this work, re-run `pnpm tc` fully.
```
