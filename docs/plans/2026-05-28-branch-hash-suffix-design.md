# Branch Name Hash Suffix + Remote Collision Recovery — Design

**Status:** Approved (brainstorming → design); ready for implementation.
**Date:** 2026-05-28

## Goal

Workspace slugs (which double as branch names) must stay unique not just locally but also across an org's shared remote. Today a slug like `bold_eagle` from one machine can collide with another member's `bold_eagle` at `git push` time, breaking the first-push flow.

Two changes:

1. **Always append a short random hash** to the generated slug (e.g. `bold_eagle_a1348`) so the chance of two members independently rolling the same name drops from ~1/6400 to ~1/(6400 × 60M).
2. **Auto-recover at push time** for the vanishingly-rare case where a collision still happens. Detect, re-roll the hash, rename the local branch, retry push.

## Out of scope

- Pre-fetching remote refs at create time. The hash space is large enough that the network round-trip isn't worth it; we save the remote check for push.
- Renaming the workspace folder, `workspaceName` identifier, or DB name on collision. Only the git branch renames. Folder paths and stored identifiers stay stable so file references don't churn.
- Backfilling existing hash-less workspaces. They keep their names indefinitely; the new pattern accepts both shapes.
- Intercepting terminal-direct `git push`. Auto-recovery only fires for Orca-initiated pushes (Source Control panel, PR-creation flow, automation push steps). Terminal users see git's normal error.

## Hash format

- **5 chars, base36 (lowercase a–z + 0–9).** ~60M combinations.
- Generated via `crypto.randomBytes(4)` → base36 → slice to 5. Cryptographic randomness avoids the `Math.random` test-mocking quirk in collision probability.
- Always present on new names. No conditional "only on collision" branch — uniform behavior is easier to reason about.

## Pattern relaxation

`WORKSPACE_NAME_PATTERN` widens from `/^[a-z][a-z0-9_]{0,15}$/` (16 chars) to `/^[a-z][a-z0-9_]{0,21}$/` (22 chars) so `wopping_ferret_a1348` (20 chars) fits with headroom. The 16-char limit was an aesthetic choice; Postgres allows 63 and shell vars are unbounded.

Old slugs like `bold_eagle` still match the relaxed pattern, so no migration needed.

## Generator changes (`src/shared/workspace-name-generator.ts`)

```ts
// New helper.
function pickHashSuffix(): string {
  // crypto.randomBytes is async-safe in Node + Electron. Base36 keeps the
  // suffix lowercase-alphanumeric to match the rest of the slug.
  return randomBytes(4).readUInt32BE(0).toString(36).padStart(5, '0').slice(0, 5)
}

// Updated. Now always appends a hash.
export function suggestWorkspaceName(): string {
  return `${pickRandom(ADJECTIVES)}_${pickRandom(NOUNS)}_${pickHashSuffix()}`
}

// Updated. Drops the _2/_3 numeric suffix chain — re-rolls hash on local
// collision instead. 32 attempts × 60M space = effectively unreachable.
export function generateUniqueWorkspaceName(takenNames: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = suggestWorkspaceName()
    if (!takenNames.has(candidate)) {
      return candidate
    }
  }
  // Pathological fallback (unreachable in practice).
  let fallback = `${suggestWorkspaceName()}_${Date.now().toString(36)}`
  while (takenNames.has(fallback)) {
    fallback = `${suggestWorkspaceName()}_${Date.now().toString(36)}`
  }
  return fallback
}

// New helper used by the push-recovery path.
export function rerollHashOnBranch(branchName: string): string {
  // Match a trailing _<5 base36 chars>. If present, swap it. If absent
  // (pre-hash workspaces), append a fresh hash.
  const HASH_TAIL = /_[a-z0-9]{5}$/
  const base = HASH_TAIL.test(branchName)
    ? branchName.replace(HASH_TAIL, '')
    : branchName
  return `${base}_${pickHashSuffix()}`
}
```

## Push wrapper (`src/main/git/remote.ts`)

```ts
export async function gitPush(
  worktreePath: string,
  _publish = false,
  pushTarget?: GitPushTarget
): Promise<PushResult> {
  // Explicit pushTarget = user intent; no auto-recovery.
  if (pushTarget) {
    await validateGitPushTarget(worktreePath, pushTarget)
    return pushOnce(worktreePath, explicitPushTarget(pushTarget))
  }

  // Configured upstream = not a first-push collision scenario.
  const configured = await getConfiguredPushTarget(worktreePath)
  if (configured) {
    return pushOnce(worktreePath, configured)
  }

  // First-push path: probe remote, rename + retry if the ref exists.
  return pushWithCollisionRecovery(worktreePath, 'origin')
}

type PushResult = {
  renamed: { from: string; to: string } | null
}

async function pushWithCollisionRecovery(
  worktreePath: string,
  remote: string
): Promise<PushResult> {
  const MAX_ATTEMPTS = 3
  let renamed: PushResult['renamed'] = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const currentBranch = await getCurrentBranch(worktreePath)
    const remoteExists = await refExistsOnRemote(worktreePath, remote, currentBranch)
    if (!remoteExists) {
      await pushOnce(worktreePath, { remote, refspec: 'HEAD' })
      return { renamed }
    }
    const next = rerollHashOnBranch(currentBranch)
    await gitExecFileAsync(['branch', '-m', next], { cwd: worktreePath })
    renamed = { from: renamed?.from ?? currentBranch, to: next }
  }
  throw new Error(
    `Failed to push after ${MAX_ATTEMPTS} rename attempts due to remote collisions. Try renaming the branch manually.`
  )
}
```

`refExistsOnRemote` is `git ls-remote --heads <remote> <branch>` parsed for non-empty output.

`pushOnce` is the existing single-shot push body (`git push --set-upstream …`).

## Worktree state update

Push IPC returns the new `PushResult` shape. The renderer:

1. If `renamed` is non-null, updates the local `Worktree.branch` field to `renamed.to`.
2. Shows a toast: *"Branch renamed to `<new>` to avoid a remote collision."* (info-level, not error).

Main also emits `worktrees:branch-renamed` event so any other surface holding the branch name (right-sidebar source-control header, etc.) refreshes.

The worktree's `workspaceName`, folder path, and `displayName` are untouched.

## Error handling

| Scenario | Behavior |
|---|---|
| `ls-remote` fails (network down) | Treat as "no collision". Push proceeds; if it then fails for real, the normal git error surfaces. |
| `git branch -m` fails (new name already taken locally) | Re-roll within the 3-attempt budget. |
| 3 attempts exhausted | Throw with clear "rename manually" message. Local branch ends up named after the last attempted re-roll, but nothing is corrupted. |
| Configured upstream exists, push fails | Not a collision — surface the original error untouched. |
| Pre-hash workspace (e.g. `bold_eagle`) collides | `rerollHashOnBranch` appends a fresh hash → `bold_eagle_a1348`. Same recovery path. |

## Testing

**Generator (`workspace-name-generator.test.ts`)**

- `suggestWorkspaceName()` matches `/^[a-z]+_[a-z]+_[a-z0-9]{5}$/`.
- `generateUniqueWorkspaceName(new Set())` returns matching pattern.
- `generateUniqueWorkspaceName` re-rolls on collision (mock `Math.random`/`crypto.randomBytes` to force one collision, verify second attempt is returned).
- `rerollHashOnBranch('bold_eagle_a1348')` returns `bold_eagle_<new5>` with a different hash.
- `rerollHashOnBranch('bold_eagle')` appends a hash (pre-hash compatibility).
- All outputs satisfy the relaxed `WORKSPACE_NAME_PATTERN`.

**Push recovery (`remote.test.ts`)**

- No upstream + `ls-remote` empty → single `git push` invocation, no rename.
- No upstream + `ls-remote` non-empty → `git branch -m <reroll>` + retry, returns `{ renamed }`.
- Two consecutive remote collisions → two renames, third push succeeds.
- Three consecutive collisions → throws with "rename manually" message.
- Configured upstream → no probe, no recovery; existing behavior preserved.
- Explicit `pushTarget` → no probe, no recovery.

**Renderer integration**

- Source Control panel push success with `renamed` non-null → toast shown, `Worktree.branch` updated.
- Push success with `renamed` null → no toast, branch unchanged.

## File touch list

- `src/shared/workspace-name-generator.ts` — generator, helper, pattern.
- `src/shared/workspace-name-generator.test.ts` — generator tests.
- `src/main/git/remote.ts` — push wrapper.
- `src/main/git/remote.test.ts` — push recovery tests.
- `src/preload/api-types.ts` + `src/preload/index.ts` — push IPC return type.
- `src/main/ipc/filesystem.ts` — propagate `PushResult` from `provider.pushBranch`.
- `src/main/providers/types.ts`, `local-git-provider.ts`, `ssh-git-provider.ts` — `pushBranch` returns `PushResult`.
- `src/renderer/src/components/right-sidebar/SourceControl*.tsx` (or wherever the push button lives) — handle `renamed`, show toast, update store.
- `src/renderer/src/store/slices/worktrees.ts` — action to update `Worktree.branch` after rename.
