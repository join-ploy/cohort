# GitHub PR auto-trigger — design

## Goal

Add a GitHub-based automatic trigger so an automation can fire when a pull
request is opened. The trigger watches a user-selected list of repositories;
when a matching PR is raised, the automation runs against that PR's own repo and
can create a worktree **on the PR's branch** using variable templates — reusing
the existing manual "Start from PR" capability.

## Scope (v1)

- **Event:** PR opened/raised only.
- **Filters:** base branch (target), author, labels (AND-ed per rule).
- **Repo model:** the trigger watches a repo list; the run targets the PR's own
  repo (projectId derived from the event, not chosen per rule).
- **Worktree:** full parity with the manual Start-from-PR flow — branch-from-head
  for same-repo PRs; fetch `refs/pull/<N>/head` + configure a push target for
  fork/cross-repo PRs.
- **Local repos only** (SSH/`connectionId` repos are skipped — `resolvePrBase`
  and the manual PR UI already reject them).
- Out of scope: other PR lifecycle events (ready-for-review, merged, review
  requested), webhooks, Octokit, draft/ready filter.

## Reference architecture (existing)

- Auto-triggers poll every ~60s. `AutoTriggerEngine.tick` groups enabled
  `autoTriggers` by source, computes a per-source `since` watermark, and calls
  `source.poll({ since, hostId })`, matching each `CandidateEvent` against each
  trigger's `rules` via `firstMatch`, with per-`(automation, trigger, entity)`
  de-dup. (`src/main/automations/auto-trigger-engine.ts`)
- A `TriggerSource` is `{ id, displayName, fieldCatalog, poll }`. Linear is the
  reference (`src/main/automations/trigger-sources/linear-issue.ts`).
- Manual Start-from-PR: `worktrees:resolvePrBase({ repoId, prNumber, headRefName,
  isCrossRepository })` → `{ baseBranch, pushTarget? }`, then `worktrees:create`
  with `baseBranch` + `linkedPR` + `pushTarget`.
  (`src/main/ipc/worktrees.ts`)
- `create-worktree` step today always creates a NEW branch; repo comes from
  `context.automation.projectId`. (`create-worktree-runner.ts`)
- Picker variables come from `buildTriggerSchema(trigger)` which only reacts to
  `acceptsLinearTicket` — it ignores `autoTriggers`.
  (`chain-editor-modal-state.ts`)

## Part 1 — data model & the github-pr source

### Generic engine extensions (no GitHub-specific code in the engine)

- `TriggerSourceId` gains `'github-pr'`.
- `AutoTrigger.repoIds?: string[]` — the watch-list. github-pr uses it; Linear
  ignores it.
- `PollCtx.repoIds?: string[]` — the engine passes the **union** of the group's
  watch-lists into `poll()`.
- `CandidateEvent.repoId?: string` — the entity's owning repo.
- Engine guard in `pollSource`: `if (trigger.repoIds?.length && event.repoId &&
  !trigger.repoIds.includes(event.repoId)) continue` — so two triggers sharing
  the source with different watch-lists each fire only for their repos.

### The source (`src/main/automations/trigger-sources/github-pr.ts`)

- `makeGithubPrSource({ getRepos })` where `getRepos: () => Repo[]`.
- `poll(ctx)`: for each repoId in `ctx.repoIds` that resolves to a local git repo
  (skip `connectionId`/folder repos), run
  `gh pr list --state open --json number,title,url,author,baseRefName,headRefName,labels,isDraft,isCrossRepository,createdAt,updatedAt`
  in the repo path. Map each PR to a `CandidateEvent`:
  - `entityId = "<repoId>#<number>"` (stable; drives de-dup).
  - `entityIdentifier = "<owner/repo>#<number>"` (or `#<number>`).
  - `updatedAt = Date(createdAt).getTime()` → **opened semantics**: only PRs
    created after `enabledAt` fire.
  - `repoId`.
  - `fields = { 'github.baseRef': baseRefName, 'github.author': author.login,
    'github.labels': labels[] }`.
  - `payload.pr = { number, title, url, headRef: headRefName, baseRef:
    baseRefName, author: author.login, isCrossRepository, repoId }`.
- `fieldCatalog`:
  - `github.baseRef` — valueKind `string`, ops `is | is-any-of | is-none-of`.
  - `github.author` — valueKind `user`, ops `is | is-not | is-any-of |
    is-none-of`, `fetchOptions` via `gh` assignable users.
  - `github.labels` — valueKind `label`, ops `contains-any | contains-all |
    contains-none`, `fetchOptions` via `gh` repo labels.

## Part 2 — worktree creation, variables, dispatch, UI

### create-worktree PR mode

- `CreateWorktreeConfig` (additive, back-compatible):
  - `mode?: 'new-branch' | 'pull-request'` (default `'new-branch'`).
  - `pullRequestRef?: string` — template, e.g. `{{trigger.github.pr.number}}`.
- Runner in `'pull-request'` mode: resolve `pullRequestRef` → PR number; read
  `repoId` from `context.automation.projectId`; read `headRef` /
  `isCrossRepository` from `context.trigger.github.pr.*`; call new dep
  `createWorktreeFromPr({ repoId, prNumber, headRefName, isCrossRepository,
  displayName, createdByAutomationRunId })`. Output unchanged: `{ worktreeId,
  path, branch }`.
- Extract the `resolvePrBase` core out of its IPC handler into a reusable
  function so both the handler and `createWorktreeFromPr` call it. The dep is
  wired in `src/main/index.ts` to `resolvePrBase` + `createManagedWorktree`.

### Trigger variables

- `GITHUB_PR_TRIGGER_OVERLAY` in `automation-step-schemas.ts`:
  `github.pr.{number,title,url,headRef,baseRef,author,isCrossRepository,repoId}`.
- `buildTriggerSchema(trigger, autoTriggers)` overlays `github.pr.*` when an
  enabled `github-pr` auto-trigger exists; thread `draft.autoTriggers` through
  `getAvailableVariablesAtStep`. (Picker descriptions from the prior task apply.)
- `GithubPrPayload` type mirrors `payload.pr` above.

### Dispatch context

- `RunNowPayload` gains `github?: { pr: GithubPrPayload }`.
- `buildTriggerContext` injects `trigger.github.pr` when present.
- `dispatchAutoRun`: for `source === 'github-pr'`, build payload from
  `event.payload.pr` and set `projectId = event.repoId`.

### UI

- `AutoTriggerCard`: when `source === 'github-pr'`, render a repo multi-select
  (reuse `repo-multi-combobox`) bound to `repoIds`, and hide the per-rule project
  picker. "Add trigger" menu auto-populates from the source registry, so GitHub
  appears with no extra wiring.
- create-worktree step card: New-branch / From-pull-request toggle that toggles
  `mode` and shows the `pullRequestRef` field in PR mode.
- `TriggerPill` / labels: include the github-pr source label.

## Testing (TDD)

- **Unit (main):** github-pr event mapping & field extraction; `createAt`→
  `updatedAt` opened semantics; engine repo-scoping guard; `resolvePrBase`
  extraction parity; create-worktree runner PR mode (new dep called with the
  resolved number/headRef); dispatchAutoRun projectId = event.repoId.
- **Unit (shared/renderer):** `buildTriggerSchema` github overlay (only when an
  enabled github-pr auto-trigger exists); `getAvailableVariablesAtStep` threads
  autoTriggers; variable-descriptions completeness covers `github.pr.*`.
- **Component:** AutoTriggerCard repo multi-select + hidden project picker for
  github-pr; create-worktree step-card mode toggle.

## Risks / notes

- `gh` rate limits: poll only the watched repos, `--state open`, once per tick.
- Fork PRs require a network fetch of `refs/pull/<N>/head` at worktree-create
  time (inherited from the manual flow).
- "Opened" relies on `createdAt`; a PR opened before `enabledAt` never fires,
  matching the Linear watermark model.
