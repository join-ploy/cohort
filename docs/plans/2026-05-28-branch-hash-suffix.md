# Branch Name Hash Suffix + Remote Collision Recovery — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Append a 5-char random hash to every generated workspace slug so multi-member orgs almost never collide on branch names, and auto-recover at push time by renaming the local branch when the rare collision does happen.

**Architecture:** Generator emits `adjective_noun_hash` (e.g. `wopping_ferret_a1348`). Pattern budget grows from 16 to 22 chars; existing hash-less names still match. `gitPush` probes `git ls-remote` before first-push and, on collision, re-rolls the hash via `git branch -m` and retries up to 3 times. The new push result propagates through providers/IPC to the renderer, which updates `Worktree.branch` in the store and shows an info toast.

**Tech Stack:** TypeScript, Node `crypto.randomBytes`, vitest for unit tests, Electron IPC, Zustand store.

**Design doc:** `docs/plans/2026-05-28-branch-hash-suffix-design.md`

---

## Task 1: Widen the workspace name pattern + add hash helper

**Files:**
- Modify: `src/shared/workspace-name-generator.ts:1-3,176-178,219`
- Test: `src/shared/workspace-name-generator.test.ts:10-14,17-24,101-103`

**Step 1: Update existing pattern tests to expect the 22-char budget and the new 3-part shape**

In `src/shared/workspace-name-generator.test.ts`, replace the `WORKSPACE_NAME_PATTERN` describe block:

```ts
describe('WORKSPACE_NAME_PATTERN', () => {
  it('matches snake_case names starting with a letter and up to 22 chars', () => {
    expect(WORKSPACE_NAME_PATTERN.test('a')).toBe(true)
    expect(WORKSPACE_NAME_PATTERN.test('wise_panther')).toBe(true) // pre-hash, still valid
    expect(WORKSPACE_NAME_PATTERN.test('wopping_ferret_a1348')).toBe(true) // hash shape
    expect(WORKSPACE_NAME_PATTERN.test('a234567890123456789012')).toBe(true) // 22 chars
  })

  it('rejects leading digit, uppercase, special chars, and over-length names', () => {
    expect(WORKSPACE_NAME_PATTERN.test('')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('1abc')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('Wise')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('wise-panther')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('wise panther')).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test('a2345678901234567890123')).toBe(false) // 23 chars
  })
})
```

Update `validateWorkspaceName` tests in the same file:

```ts
it('returns null for valid names', () => {
  expect(validateWorkspaceName('wise_panther', new Set())).toBeNull()
  expect(validateWorkspaceName('a', new Set())).toBeNull()
  expect(validateWorkspaceName('wopping_ferret_a1348', new Set())).toBeNull()
  expect(validateWorkspaceName('a234567890123456789012', new Set())).toBeNull()
})

it('rejects names over 22 characters', () => {
  expect(validateWorkspaceName('a2345678901234567890123', new Set())).toBeTruthy()
})
```

Update `suggestWorkspaceName` describe block to expect a 3-part name:

```ts
describe('suggestWorkspaceName', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a string matching WORKSPACE_NAME_PATTERN', () => {
    for (let i = 0; i < 50; i += 1) {
      const name = suggestWorkspaceName()
      expect(name).toMatch(WORKSPACE_NAME_PATTERN)
    }
  })

  it('uses adjective_noun_hash shape (two underscores, 5-char base36 tail)', () => {
    const name = suggestWorkspaceName()
    const parts = name.split('_')
    expect(parts.length).toBe(3)
    expect(parts[0].length).toBeGreaterThan(0)
    expect(parts[1].length).toBeGreaterThan(0)
    expect(parts[2]).toMatch(/^[a-z0-9]{5}$/)
  })
})
```

**Step 2: Run the tests and watch them fail**

Run: `pnpm test src/shared/workspace-name-generator.test.ts`

Expected: existing pattern tests fail on the 22-char case; `suggestWorkspaceName` tests fail because output still has 2 parts; `validateWorkspaceName` tests fail on the new long valid case.

**Step 3: Update the generator to widen the pattern and emit the hash**

In `src/shared/workspace-name-generator.ts`:

1. Update line 1-3:

```ts
// Why: short, snake_case, DB- and shell-safe identifier. Composes cleanly
// into Postgres database names and `$VAR` expansions. Budget grew from 16
// to 22 to fit the 5-char hash suffix appended for cross-machine uniqueness.
export const WORKSPACE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,21}$/
```

2. At the top of the file, add the `randomBytes` import (Node built-in, also works in Electron renderer via the preload sandbox boundary — but this module is shared, so use the Node spec):

```ts
import { randomBytes } from 'node:crypto'
```

3. Add a hash helper just above `pickRandom`:

```ts
// Why: 5-char base36 random tail gives ~60M combinations per adj_noun pair.
// Combined with 6400 base combos, the chance of two members independently
// rolling the same full slug is ~1/400B. Uses crypto.randomBytes so tests
// that mock Math.random don't accidentally make the hash deterministic.
function pickHashSuffix(): string {
  return randomBytes(4).readUInt32BE(0).toString(36).padStart(5, '0').slice(0, 5)
}
```

4. Update `suggestWorkspaceName`:

```ts
/** Generate a fresh adjective_noun_hash suggestion (no collision check). */
export function suggestWorkspaceName(): string {
  return `${pickRandom(ADJECTIVES)}_${pickRandom(NOUNS)}_${pickHashSuffix()}`
}
```

5. Update `validateWorkspaceName` error message on line 219:

```ts
return 'Use lowercase letters, digits, and underscores (max 22 chars, must start with a letter).'
```

**Step 4: Run the tests and verify they pass**

Run: `pnpm test src/shared/workspace-name-generator.test.ts`

Expected: PASS. All 50 generated names match the relaxed pattern and the 3-part shape.

**Step 5: Commit**

```bash
git add src/shared/workspace-name-generator.ts src/shared/workspace-name-generator.test.ts
git commit -m "$(cat <<'EOF'
generator: append 5-char hash to workspace slugs

Widens WORKSPACE_NAME_PATTERN from 16 to 22 chars to fit the hash suffix.
Existing hash-less names still match, so no migration is needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Simplify generateUniqueWorkspaceName (re-roll hash on collision)

**Files:**
- Modify: `src/shared/workspace-name-generator.ts:180-208`
- Test: `src/shared/workspace-name-generator.test.ts:48-75`

**Step 1: Replace the `_2`/`_3` tests with hash re-roll tests**

In `src/shared/workspace-name-generator.test.ts`, replace the `generateUniqueWorkspaceName` describe block:

```ts
describe('generateUniqueWorkspaceName', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a fresh name when nothing is taken', () => {
    const name = generateUniqueWorkspaceName(new Set())
    expect(name).toMatch(WORKSPACE_NAME_PATTERN)
  })

  it('re-rolls when the suggested name is already taken', () => {
    // Why: force suggestWorkspaceName to return a fixed value once, then
    // anything else. We monkey-patch the module export instead of Math.random
    // because the hash uses crypto.randomBytes — easier to stub the whole
    // suggestion than the underlying randomness.
    const calls: string[] = []
    const realSuggest = suggestWorkspaceName
    let i = 0
    vi.spyOn({ realSuggest }, 'realSuggest').mockImplementation(() => {
      i += 1
      const out = i === 1 ? 'wise_otter_aaaaa' : 'wise_otter_bbbbb'
      calls.push(out)
      return out
    })
    // The generator calls suggestWorkspaceName via module import; spying on
    // a local alias does not intercept. Use the technique below instead:
  })
})
```

Actually use this simpler form that doesn't rely on monkey-patching across module boundaries — instead, exploit determinism via a long taken-names set:

```ts
describe('generateUniqueWorkspaceName', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a fresh name when nothing is taken', () => {
    const name = generateUniqueWorkspaceName(new Set())
    expect(name).toMatch(WORKSPACE_NAME_PATTERN)
  })

  it('avoids returning a name from the taken set', () => {
    // Generate a batch and then ban them all. The 33rd attempt should still
    // succeed by re-rolling a fresh suggestion (60M hash space makes this
    // probabilistically certain).
    const taken = new Set<string>()
    for (let i = 0; i < 20; i += 1) {
      taken.add(suggestWorkspaceName())
    }
    const next = generateUniqueWorkspaceName(taken)
    expect(taken.has(next)).toBe(false)
    expect(next).toMatch(WORKSPACE_NAME_PATTERN)
  })

  it('does not append _2 (legacy numeric-suffix path is removed)', () => {
    const name = generateUniqueWorkspaceName(new Set())
    expect(name).not.toMatch(/_\d+$/)
  })
})
```

**Step 2: Run the tests and verify they fail (because the existing `_2`/`_3` test is gone but the implementation still uses that path)**

Run: `pnpm test src/shared/workspace-name-generator.test.ts`

Expected: PASS for `returns a fresh name` and `avoids returning a name from the taken set`. The `does not append _2` test should also already pass since the hash makes collision astronomically unlikely — but the existing code still has the `_2` retry loop, which we'll remove in step 3 for clarity.

**Step 3: Simplify the generator**

Replace lines 180-208 of `src/shared/workspace-name-generator.ts`:

```ts
/**
 * Generate a name unique across `takenNames`. Re-rolls the random hash suffix
 * on collision. The 60M hash space makes 32 attempts effectively unbounded
 * in practice; the `Date.now()` fallback is unreachable but kept defensively.
 */
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
```

**Step 4: Re-run the tests**

Run: `pnpm test src/shared/workspace-name-generator.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/shared/workspace-name-generator.ts src/shared/workspace-name-generator.test.ts
git commit -m "$(cat <<'EOF'
generator: drop _2/_3 retry; re-roll hash on local collision

The 60M hash space makes the legacy numeric-suffix path unreachable for any
realistic taken set, and removing it lets every generated name keep the
clean adj_noun_hash shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `rerollHashOnBranch` helper

**Files:**
- Modify: `src/shared/workspace-name-generator.ts` (append below `generateUniqueWorkspaceName`)
- Test: `src/shared/workspace-name-generator.test.ts` (append a new describe block)

**Step 1: Write the failing tests**

Append to `src/shared/workspace-name-generator.test.ts`:

```ts
describe('rerollHashOnBranch', () => {
  it('swaps the trailing 5-char hash with a fresh one', () => {
    const next = rerollHashOnBranch('wopping_ferret_a1348')
    expect(next).toMatch(/^wopping_ferret_[a-z0-9]{5}$/)
    expect(next).not.toBe('wopping_ferret_a1348')
  })

  it('appends a hash when the input has no trailing hash (pre-hash names)', () => {
    const next = rerollHashOnBranch('bold_eagle')
    expect(next).toMatch(/^bold_eagle_[a-z0-9]{5}$/)
  })

  it('preserves multi-word prefixes when re-rolling', () => {
    const next = rerollHashOnBranch('legacy_name_with_extras_a1348')
    expect(next).toMatch(/^legacy_name_with_extras_[a-z0-9]{5}$/)
    expect(next).not.toBe('legacy_name_with_extras_a1348')
  })
})
```

Update the import at the top:

```ts
import {
  WORKSPACE_NAME_PATTERN,
  generateUniqueWorkspaceName,
  rerollHashOnBranch,
  suggestWorkspaceName,
  validateWorkspaceName
} from './workspace-name-generator'
```

**Step 2: Run the tests and watch them fail**

Run: `pnpm test src/shared/workspace-name-generator.test.ts`

Expected: FAIL with `rerollHashOnBranch is not exported`.

**Step 3: Add the helper**

Append to `src/shared/workspace-name-generator.ts`:

```ts
const HASH_TAIL = /_[a-z0-9]{5}$/

/**
 * Swap the trailing 5-char hash suffix with a fresh one. Used by the push
 * collision-recovery path when a remote branch with the same name already
 * exists. Falls back to appending a hash for legacy pre-hash names.
 */
export function rerollHashOnBranch(branchName: string): string {
  const base = HASH_TAIL.test(branchName) ? branchName.replace(HASH_TAIL, '') : branchName
  let next = `${base}_${pickHashSuffix()}`
  // Guarantee progress: if the random hash happens to match the original,
  // re-roll. With 60M combinations this loop terminates after ~1 iteration.
  while (next === branchName) {
    next = `${base}_${pickHashSuffix()}`
  }
  return next
}
```

**Step 4: Run the tests and verify they pass**

Run: `pnpm test src/shared/workspace-name-generator.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/shared/workspace-name-generator.ts src/shared/workspace-name-generator.test.ts
git commit -m "$(cat <<'EOF'
generator: add rerollHashOnBranch helper for push collision recovery

Used by the gitPush wrapper when a remote ref with the same name already
exists. Falls back to appending a hash for pre-hash workspace names.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add `PushResult` shared type

**Files:**
- Modify: `src/shared/types.ts` (append near other git-related types)

**Step 1: Add the type**

Append (or place near `GitPushTarget`) in `src/shared/types.ts`:

```ts
/**
 * Outcome of a `git push` triggered through Orca's push IPC. When the
 * remote already has a ref with the local branch's name, the main process
 * re-rolls the hash suffix via `git branch -m` and retries; `renamed`
 * surfaces that fact to the renderer so it can update the Worktree.branch
 * field and toast the user.
 */
export type PushResult = {
  renamed: { from: string; to: string } | null
}
```

**Step 2: Verify it typechecks**

Run: `pnpm tc`

Expected: PASS (no usages yet).

**Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "$(cat <<'EOF'
types: add PushResult to surface push-time rename to the renderer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `refExistsOnRemote` helper in `git/remote.ts`

**Files:**
- Modify: `src/main/git/remote.ts` (add helper near top, no behavior change yet)
- Test: `src/main/git/remote.test.ts` (add a focused test)

**Step 1: Write the failing test**

Append to `src/main/git/remote.test.ts`, inside the existing `describe('git remote operations', …)` block:

```ts
it('refExistsOnRemote returns true when ls-remote prints a matching ref', async () => {
  gitExecFileAsyncMock.mockResolvedValueOnce({
    stdout: 'abc123\trefs/heads/wopping_ferret_a1348\n',
    stderr: ''
  })
  await expect(refExistsOnRemote('/repo', 'origin', 'wopping_ferret_a1348')).resolves.toBe(true)
  expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
    ['ls-remote', '--heads', '--exit-code', 'origin', 'wopping_ferret_a1348'],
    { cwd: '/repo' }
  )
})

it('refExistsOnRemote returns false when ls-remote prints nothing', async () => {
  // Why: git ls-remote --exit-code returns non-zero when no refs match,
  // surfacing as a thrown error from gitExecFileAsync. Helper swallows it.
  gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('no match'), { code: 2 }))
  await expect(refExistsOnRemote('/repo', 'origin', 'wopping_ferret_a1348')).resolves.toBe(false)
})

it('refExistsOnRemote returns false when ls-remote fails for any reason (network down, etc.)', async () => {
  gitExecFileAsyncMock.mockRejectedValueOnce(new Error('Could not resolve host'))
  await expect(refExistsOnRemote('/repo', 'origin', 'wopping_ferret_a1348')).resolves.toBe(false)
})
```

Update the import at the top of `remote.test.ts`:

```ts
import { gitFetch, gitPull, gitPush, refExistsOnRemote } from './remote'
```

**Step 2: Run the tests and watch them fail**

Run: `pnpm test src/main/git/remote.test.ts`

Expected: FAIL with `refExistsOnRemote is not exported`.

**Step 3: Add the helper**

In `src/main/git/remote.ts`, add (above `getConfiguredPushTarget`):

```ts
/**
 * Check whether `<remote>/<branch>` already exists. Treats any failure
 * (no match, network down, unknown remote) as "doesn't exist" so the
 * caller can fall through to a normal push attempt — that push will then
 * surface a real failure if one exists.
 *
 * Used by the push collision-recovery path before the first push of a
 * locally-generated branch.
 */
export async function refExistsOnRemote(
  worktreePath: string,
  remote: string,
  branch: string
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['ls-remote', '--heads', '--exit-code', remote, branch],
      { cwd: worktreePath }
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}
```

**Step 4: Run the tests and verify they pass**

Run: `pnpm test src/main/git/remote.test.ts`

Expected: PASS (existing tests still pass; new tests pass).

**Step 5: Commit**

```bash
git add src/main/git/remote.ts src/main/git/remote.test.ts
git commit -m "$(cat <<'EOF'
git: add refExistsOnRemote helper for push collision detection

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update `gitPush` to return `PushResult` and auto-recover on collision

**Files:**
- Modify: `src/main/git/remote.ts:42-71`
- Test: `src/main/git/remote.test.ts` (update existing tests + add new ones)

**Step 1: Update existing tests to assert on the new return shape**

In `src/main/git/remote.test.ts`, update the three existing pass-through tests so they assert the new return shape. Edit:

```ts
it('pushes to origin when no upstream is configured', async () => {
  // 1. symbolic-ref (HEAD) → returns branch name
  // 2. config branch.<name>.remote → fails (no upstream)
  // 3. ls-remote → empty (no collision)
  // 4. push
  gitExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: 'wopping_ferret_a1348\n', stderr: '' })
    .mockRejectedValueOnce(Object.assign(new Error('no branch'), { code: 1 }))
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })

  const result = await gitPush('/repo', true)

  expect(result).toEqual({ renamed: null })
  expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
    ['push', '--set-upstream', 'origin', 'HEAD'],
    { cwd: '/repo' }
  )
})
```

Update `pushes to the configured upstream remote and branch` to:

```ts
it('pushes to the configured upstream remote and branch', async () => {
  gitExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: 'review/pr-1738\n', stderr: '' })
    .mockResolvedValueOnce({ stdout: 'pr-prateek-orca\n', stderr: '' })
    .mockResolvedValueOnce({
      stdout: 'refs/heads/prateek/fix-sidebar-agents-toggle\n',
      stderr: ''
    })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })

  const result = await gitPush('/repo', false)

  expect(result).toEqual({ renamed: null })
  expect(gitExecFileAsyncMock.mock.calls).toEqual([
    [['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: '/repo' }],
    [['config', '--get', 'branch.review/pr-1738.remote'], { cwd: '/repo' }],
    [['config', '--get', 'branch.review/pr-1738.merge'], { cwd: '/repo' }],
    [
      ['push', '--set-upstream', 'pr-prateek-orca', 'HEAD:prateek/fix-sidebar-agents-toggle'],
      { cwd: '/repo' }
    ]
  ])
})
```

Update `uses an explicit push target` likewise:

```ts
it('uses an explicit push target even when it differs from the local branch name', async () => {
  gitExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockResolvedValueOnce({ stdout: '', stderr: '' })

  const result = await gitPush('/repo', false, {
    remoteName: 'origin',
    branchName: 'contributor/fix-sidebar'
  })

  expect(result).toEqual({ renamed: null })
  expect(gitExecFileAsyncMock.mock.calls).toEqual([
    [['check-ref-format', '--branch', 'contributor/fix-sidebar'], { cwd: '/repo' }],
    [['push', '--set-upstream', 'origin', 'HEAD:contributor/fix-sidebar'], { cwd: '/repo' }]
  ])
})
```

Update the other 4 error-path tests by adding one extra `mockResolvedValueOnce` at the start (since `getCurrentBranch` is now called before push). The `maps non-fast-forward push failures` test becomes:

```ts
it('maps non-fast-forward push failures to an actionable message', async () => {
  gitExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // symbolic-ref
    .mockRejectedValueOnce(new Error('no branch')) // config.remote
    .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ls-remote (no collision)
    .mockRejectedValueOnce(new Error('remote rejected: non-fast-forward'))

  await expect(gitPush('/repo', false)).rejects.toThrow(
    'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
  )
})
```

Apply the same `symbolic-ref` + `config.remote` + `ls-remote` prelude to:
- `passes through clean tail line`
- `strips embedded credentials`
- `strips token-only credentials`
- `falls back to a generic message`

**Step 2: Add new collision-recovery tests**

Append to the describe block:

```ts
it('re-rolls hash and retries push when the remote ref already exists', async () => {
  gitExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: 'wopping_ferret_a1348\n', stderr: '' }) // symbolic-ref
    .mockRejectedValueOnce(new Error('no upstream')) // config.remote
    .mockResolvedValueOnce({
      stdout: 'abc123\trefs/heads/wopping_ferret_a1348\n',
      stderr: ''
    }) // ls-remote: collision
    .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch -m
    .mockResolvedValueOnce({ stdout: 'wopping_ferret_b9d52\n', stderr: '' }) // symbolic-ref (new name)
    .mockRejectedValueOnce(Object.assign(new Error('no match'), { code: 2 })) // ls-remote: clear
    .mockResolvedValueOnce({ stdout: '', stderr: '' }) // push

  const result = await gitPush('/repo', false)

  expect(result.renamed).toEqual({
    from: 'wopping_ferret_a1348',
    to: expect.stringMatching(/^wopping_ferret_[a-z0-9]{5}$/)
  })
  expect(result.renamed?.to).not.toBe('wopping_ferret_a1348')

  // Verify a branch -m call happened.
  const renameCall = gitExecFileAsyncMock.mock.calls.find(
    ([args]) => Array.isArray(args) && args[0] === 'branch' && args[1] === '-m'
  )
  expect(renameCall).toBeDefined()
})

it('throws after 3 consecutive collisions', async () => {
  // 3 rounds of (symbolic-ref → ls-remote collision → branch -m), then a
  // 4th round that re-rolls but still collides on ls-remote should fail.
  // The pattern repeats with one extra symbolic-ref + ls-remote at the end.
  for (let i = 0; i < 3; i += 1) {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: `wopping_ferret_round${i}\n`, stderr: '' }) // symbolic-ref
      .mockRejectedValueOnce(new Error('no upstream')) // config.remote
      .mockResolvedValueOnce({
        stdout: `abc${i}\trefs/heads/wopping_ferret_round${i}\n`,
        stderr: ''
      }) // ls-remote: collision
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // branch -m
  }

  await expect(gitPush('/repo', false)).rejects.toThrow(
    /Failed to push after 3 rename attempts/
  )
})

it('does not probe ls-remote when an upstream is already configured', async () => {
  gitExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' }) // symbolic-ref
    .mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' }) // config.remote
    .mockResolvedValueOnce({ stdout: 'refs/heads/feature\n', stderr: '' }) // config.merge
    .mockResolvedValueOnce({ stdout: '', stderr: '' }) // push

  const result = await gitPush('/repo', false)

  expect(result).toEqual({ renamed: null })
  const calls = gitExecFileAsyncMock.mock.calls.map(([args]) => (args as string[])[0])
  expect(calls).not.toContain('ls-remote')
})

it('does not probe ls-remote when an explicit pushTarget is supplied', async () => {
  gitExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: '', stderr: '' }) // check-ref-format
    .mockResolvedValueOnce({ stdout: '', stderr: '' }) // push

  await gitPush('/repo', false, { remoteName: 'origin', branchName: 'feature/x' })

  const calls = gitExecFileAsyncMock.mock.calls.map(([args]) => (args as string[])[0])
  expect(calls).not.toContain('ls-remote')
})
```

**Step 3: Run the tests and watch them fail**

Run: `pnpm test src/main/git/remote.test.ts`

Expected: FAIL on the new tests and on the updated existing tests.

**Step 4: Implement the new gitPush**

Replace `src/main/git/remote.ts:42-71` (the `gitPush` function) with:

```ts
import { rerollHashOnBranch } from '../../shared/workspace-name-generator'
import type { PushResult } from '../../shared/types'

const MAX_PUSH_RENAME_ATTEMPTS = 3

async function getCurrentBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: worktreePath
    })
    const branch = stdout.trim()
    return branch || null
  } catch {
    return null
  }
}

async function pushOnce(
  worktreePath: string,
  args: string[]
): Promise<void> {
  await gitExecFileAsync(args, { cwd: worktreePath })
}

export async function gitPush(
  worktreePath: string,
  _publish = false,
  pushTarget?: GitPushTarget
): Promise<PushResult> {
  try {
    if (pushTarget) {
      await validateGitPushTarget(worktreePath, pushTarget)
      const target = explicitPushTarget(pushTarget)
      await pushOnce(worktreePath, ['push', '--set-upstream', target.remote, target.refspec])
      return { renamed: null }
    }

    const configured = await getConfiguredPushTarget(worktreePath)
    if (configured) {
      await pushOnce(worktreePath, [
        'push',
        '--set-upstream',
        configured.remote,
        configured.refspec
      ])
      return { renamed: null }
    }

    // First-push path: probe the remote, re-roll the hash and retry on collision.
    return await pushWithCollisionRecovery(worktreePath)
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}

async function pushWithCollisionRecovery(worktreePath: string): Promise<PushResult> {
  const remote = 'origin'
  let originalBranch: string | null = null

  for (let attempt = 0; attempt < MAX_PUSH_RENAME_ATTEMPTS; attempt += 1) {
    const currentBranch = await getCurrentBranch(worktreePath)
    if (!currentBranch) {
      // Detached HEAD or other unusual state: fall through to a default push;
      // git will surface the real error if any.
      await pushOnce(worktreePath, ['push', '--set-upstream', remote, 'HEAD'])
      return { renamed: null }
    }
    if (originalBranch === null) {
      originalBranch = currentBranch
    }

    const collides = await refExistsOnRemote(worktreePath, remote, currentBranch)
    if (!collides) {
      await pushOnce(worktreePath, ['push', '--set-upstream', remote, 'HEAD'])
      return originalBranch !== currentBranch
        ? { renamed: { from: originalBranch, to: currentBranch } }
        : { renamed: null }
    }

    const next = rerollHashOnBranch(currentBranch)
    await gitExecFileAsync(['branch', '-m', next], { cwd: worktreePath })
  }

  throw new Error(
    `Failed to push after ${MAX_PUSH_RENAME_ATTEMPTS} rename attempts due to remote collisions. Try renaming the branch manually.`
  )
}
```

Remove the now-unused inline `explicitPushTarget` helper if it duplicates an existing one — keep one copy in the file.

**Step 5: Run the tests and verify all pass**

Run: `pnpm test src/main/git/remote.test.ts`

Expected: PASS for all updated and new tests.

**Step 6: Typecheck**

Run: `pnpm tc:node`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/main/git/remote.ts src/main/git/remote.test.ts
git commit -m "$(cat <<'EOF'
git: auto-recover from remote branch collisions at push time

gitPush now probes ls-remote before the first push of a branch with no
configured upstream. On collision, it re-rolls the trailing hash suffix
via git branch -m and retries up to 3 times. Configured-upstream and
explicit-pushTarget paths skip the probe so existing flows are unchanged.

Returns the new PushResult so the renderer can update Worktree.branch and
surface a toast when a rename happened.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Propagate `PushResult` through the SSH provider + relay

**Files:**
- Modify: `src/main/providers/types.ts` (pushBranch signature)
- Modify: `src/main/providers/ssh-git-provider.ts:94-100`
- Modify: `src/main/providers/ssh-git-provider.test.ts:142-…` (existing pushBranch test)
- Modify: `src/relay/git-handler.ts:248-268` (relay push handler)
- Modify: `src/main/ipc/filesystem.ts:632,638` (return the result from the IPC handler)
- Modify: `src/preload/index.ts:1752-1758` (push IPC return type)
- Modify: `src/preload/api-types.ts` (api.git.push return type)

**Step 1: Update `Provider.pushBranch` interface**

In `src/main/providers/types.ts:152`:

```ts
pushBranch(worktreePath: string, publish?: boolean, pushTarget?: GitPushTarget): Promise<PushResult>
```

Add `import type { PushResult } from '../../shared/types'` if not present.

**Step 2: Update SSH provider**

In `src/main/providers/ssh-git-provider.ts:94-100`:

```ts
async pushBranch(
  worktreePath: string,
  publish = false,
  pushTarget?: GitPushTarget
): Promise<PushResult> {
  return (await this.mux.request('git.push', {
    worktreePath,
    publish,
    pushTarget
  })) as PushResult
}
```

Add `PushResult` to the existing type import block.

**Step 3: Update the relay push handler**

In `src/relay/git-handler.ts:248-268`, mirror the local-side collision recovery. Since `this.git(...)` returns `{ stdout, stderr }`-shaped output, the helpers need to be inlined. Replace the existing `push` method:

```ts
private async push(params: Record<string, unknown>) {
  const worktreePath = params.worktreePath as string
  void params.publish
  try {
    const target = await resolveRelayPushTarget(
      this.git.bind(this),
      worktreePath,
      params.pushTarget
    )
    if (target || params.pushTarget) {
      const args = target
        ? ['push', '--set-upstream', target.remote, target.refspec]
        : ['push', '--set-upstream', 'origin', 'HEAD']
      await this.git(args, worktreePath)
      return { renamed: null }
    }
    return await this.pushWithCollisionRecovery(worktreePath)
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}

private async pushWithCollisionRecovery(worktreePath: string) {
  const MAX_ATTEMPTS = 3
  let originalBranch: string | null = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let currentBranch: string | null = null
    try {
      const { stdout } = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath)
      currentBranch = stdout.trim() || null
    } catch {
      currentBranch = null
    }
    if (!currentBranch) {
      await this.git(['push', '--set-upstream', 'origin', 'HEAD'], worktreePath)
      return { renamed: null }
    }
    if (originalBranch === null) {
      originalBranch = currentBranch
    }
    let collides = false
    try {
      const { stdout } = await this.git(
        ['ls-remote', '--heads', '--exit-code', 'origin', currentBranch],
        worktreePath
      )
      collides = stdout.trim().length > 0
    } catch {
      collides = false
    }
    if (!collides) {
      await this.git(['push', '--set-upstream', 'origin', 'HEAD'], worktreePath)
      return originalBranch !== currentBranch
        ? { renamed: { from: originalBranch, to: currentBranch } }
        : { renamed: null }
    }
    const next = rerollHashOnBranch(currentBranch)
    await this.git(['branch', '-m', next], worktreePath)
  }
  throw new Error(
    `Failed to push after ${MAX_ATTEMPTS} rename attempts due to remote collisions. Try renaming the branch manually.`
  )
}
```

Add the import:

```ts
import { rerollHashOnBranch } from '../shared/workspace-name-generator'
```

**Step 4: Update the IPC handler in `filesystem.ts`**

In `src/main/ipc/filesystem.ts`, change lines 619 (return type), 632, and 638:

```ts
): Promise<PushResult> => {
  const publish = args.publish === true
  if (args.connectionId) {
    if (args.pushTarget) {
      assertGitPushTargetShape(args.pushTarget)
    }
    const provider = getSshGitProvider(args.connectionId)
    if (!provider) {
      throw new Error(`No git provider for connection "${args.connectionId}"`)
    }
    return provider.pushBranch(args.worktreePath, publish, args.pushTarget)
  }
  const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
  if (args.pushTarget) {
    await validateGitPushTarget(worktreePath, args.pushTarget)
  }
  return gitPush(worktreePath, publish, args.pushTarget)
}
```

Add `import type { PushResult } from '../../shared/types'` if not present.

**Step 5: Update preload + api-types**

In `src/preload/index.ts:1752-1758`:

```ts
push: (args: {
  worktreePath: string
  publish?: boolean
  connectionId?: string
  pushTarget?: unknown
}): Promise<PushResult> => ipcRenderer.invoke('git:push', args),
```

Add `import type { PushResult } from '../shared/types'` to the file's imports (look at top of `src/preload/index.ts`).

In `src/preload/api-types.ts`, find the `push:` signature in the git surface and change `Promise<void>` to `Promise<PushResult>`. Add the type import.

**Step 6: Update the SSH provider test**

In `src/main/providers/ssh-git-provider.test.ts:142`, update the assertion to expect a `PushResult`:

```ts
it('pushBranch sends git.push request and forwards publish mode and target', async () => {
  mux.mockRequest.mockResolvedValueOnce({ renamed: null })
  const result = await provider.pushBranch('/home/user/repo', true, {
    remoteName: 'origin',
    branchName: 'feature/x'
  })
  expect(result).toEqual({ renamed: null })
  // ... existing assertions on the dispatch
})
```

(Read the existing test first; preserve its dispatch-shape assertions.)

**Step 7: Typecheck**

Run: `pnpm tc`

Expected: PASS across all three projects.

**Step 8: Run all touched tests**

Run: `pnpm test src/main/providers/ssh-git-provider.test.ts src/main/git/remote.test.ts src/shared/workspace-name-generator.test.ts`

Expected: PASS.

**Step 9: Commit**

```bash
git add src/main/providers/types.ts src/main/providers/ssh-git-provider.ts \
        src/main/providers/ssh-git-provider.test.ts src/relay/git-handler.ts \
        src/main/ipc/filesystem.ts src/preload/index.ts src/preload/api-types.ts
git commit -m "$(cat <<'EOF'
plumb PushResult through providers, IPC, and the relay

The renderer needs to know when the push wrapper renamed the local branch
to dodge a remote collision so it can update Worktree.branch in the store
and toast the user. The relay handler mirrors the collision-recovery logic
so SSH worktrees get the same behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Handle `PushResult.renamed` in the renderer

**Files:**
- Modify: `src/renderer/src/store/slices/editor.ts:1929-1949` (`pushBranch`)
- Modify: `src/renderer/src/store/slices/editor.ts` (extend `syncBranch` if it also calls `api.git.push` — line ~1985)
- Modify: `src/renderer/src/store/slices/worktrees.ts` (add a `setWorktreeBranch` action)
- Test: `src/renderer/src/store/slices/worktrees.test.ts` (or new test file if missing) — assert `setWorktreeBranch` updates the right entry.

**Step 1: Add `setWorktreeBranch` action**

In `src/renderer/src/store/slices/worktrees.ts`, add to the slice (locate the existing slice exports and insert near other simple mutators):

```ts
setWorktreeBranch: (worktreeId: string, branch: string) =>
  set((s) => {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const current = s.worktreesByRepo[repoId]
    if (!current) {
      return {}
    }
    let changed = false
    const next = current.map((w) => {
      if (w.id !== worktreeId || w.branch === branch) {
        return w
      }
      changed = true
      return { ...w, branch }
    })
    if (!changed) {
      return {}
    }
    return {
      worktreesByRepo: { ...s.worktreesByRepo, [repoId]: next },
      sortEpoch: s.sortEpoch + 1
    }
  }),
```

Add the type declaration in the slice's interface (look for existing actions for the shape):

```ts
setWorktreeBranch: (worktreeId: string, branch: string) => void
```

**Step 2: Write a unit test for the new action**

If a `worktrees.test.ts` exists, append:

```ts
it('setWorktreeBranch updates the branch field on the matching worktree', () => {
  const store = makeTestStore({
    worktreesByRepo: {
      'repo-1': [{ id: 'repo-1::/a', repoId: 'repo-1', branch: 'old', /* other required fields */ }]
    }
  })
  store.getState().setWorktreeBranch('repo-1::/a', 'new')
  expect(store.getState().worktreesByRepo['repo-1']?.[0]?.branch).toBe('new')
})

it('setWorktreeBranch is a no-op when the branch is unchanged', () => {
  const store = makeTestStore({
    worktreesByRepo: {
      'repo-1': [{ id: 'repo-1::/a', repoId: 'repo-1', branch: 'main', /* ... */ }]
    }
  })
  const before = store.getState().sortEpoch
  store.getState().setWorktreeBranch('repo-1::/a', 'main')
  expect(store.getState().sortEpoch).toBe(before)
})
```

(If `worktrees.test.ts` doesn't exist, skip this step and rely on integration testing — the slice helpers like `getRepoIdFromWorktreeId` and `set` are battle-tested.)

**Step 3: Update `pushBranch` in editor.ts**

Replace lines 1929-1949:

```ts
pushBranch: async (worktreeId, worktreePath, publish = false, connectionId, pushTarget) => {
  get().beginRemoteOperation(publish ? 'publish' : 'push')
  let result: PushResult
  try {
    result = await window.api.git.push({ worktreePath, publish, connectionId, pushTarget })
  } catch (error) {
    toast.error(resolveRemoteOperationErrorMessage(error, { publish, isPush: true }))
    throw error
  } finally {
    get().endRemoteOperation()
  }
  if (result.renamed) {
    // Why: main renamed the local branch to dodge a remote collision. Update
    // the store so the sidebar's branch label refreshes without waiting for
    // the next git status poll, and toast the user so they know.
    get().setWorktreeBranch(worktreeId, result.renamed.to)
    toast.info(`Branch renamed to ${result.renamed.to} to avoid a remote collision.`)
  }
  void get().fetchUpstreamStatus(worktreeId, worktreePath, connectionId)
},
```

Apply the same `renamed` handling to the `syncBranch` push step around lines 1985-1989:

```ts
const pushResult = await window.api.git.push({
  worktreePath,
  connectionId,
  pushTarget
})
if (pushResult.renamed) {
  get().setWorktreeBranch(worktreeId, pushResult.renamed.to)
  toast.info(`Branch renamed to ${pushResult.renamed.to} to avoid a remote collision.`)
}
```

Add the `PushResult` import at the top of `editor.ts`:

```ts
import type { PushResult } from '../../../../shared/types'
```

**Step 4: Typecheck**

Run: `pnpm tc:web`

Expected: PASS.

**Step 5: Run any affected renderer tests**

Run: `pnpm test src/renderer/src/store/slices/`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/renderer/src/store/slices/editor.ts src/renderer/src/store/slices/worktrees.ts \
        src/renderer/src/store/slices/worktrees.test.ts
git commit -m "$(cat <<'EOF'
renderer: handle push-time branch rename in pushBranch and syncBranch

When main renames the local branch to avoid a remote collision, the store
updates Worktree.branch immediately and shows an info toast so the sidebar
label reflects the new name without waiting for the next git status poll.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final verification

**Step 1: Full typecheck**

Run: `pnpm tc`

Expected: PASS across `node`, `cli`, and `web` projects.

**Step 2: Full test run**

Run: `pnpm test`

Expected: PASS for all suites. If anything else mocks `gitPush` or `provider.pushBranch` and expects `void`, fix those too.

**Step 3: Lint touched files**

Run: `pnpm lint src/shared/workspace-name-generator.ts src/main/git/remote.ts src/main/providers/ssh-git-provider.ts src/relay/git-handler.ts src/renderer/src/store/slices/editor.ts src/renderer/src/store/slices/worktrees.ts`

Expected: PASS or only preexisting violations from other code.

**Step 4: Manual smoke (user-driven)**

The user should:

1. Start the dev build: `pnpm dev`
2. Create a new workspace in a repo where they can push. Verify the slug looks like `wopping_ferret_a1348`.
3. Make a commit and push via the Source Control panel button. Confirm the push succeeds and no rename toast appears.
4. Simulate a collision: in a checkout outside Orca, create the same branch name on the remote, then create another Orca workspace and try to make it pick the same name (or manually `git branch -m <colliding-name>` then push). Confirm the toast says *"Branch renamed to … to avoid a remote collision."* and the sidebar's branch label updates without a refresh.
5. Confirm an existing pre-hash workspace (if any) still pushes normally.

**Step 5: Final commit (if any small fixups from manual smoke)**

If the smoke pass surfaces any issues, fix and commit. Otherwise the feature is done.

---

## Out-of-plan considerations

- **GroupedComposerForm / useComposerState** call `generateUniqueWorkspaceName` and `suggestWorkspaceName` directly. They'll automatically get the new shape with no code changes since the function signatures didn't change.
- **`persistence.ts` / `orca-runtime.ts` / `worktree-remote.ts`** also call the generator. Same — no changes needed; the new names match the relaxed pattern.
- **Existing branch records** (pre-hash) keep their old names. They use the same recovery path on push collision (`rerollHashOnBranch` falls through the append branch).
- **Cmd+J jump palette, sidebar, etc.** display `displayName` or `workspaceName`, not the raw branch, so the longer slug shouldn't cause visual overflow problems. If it does, that's a follow-up.
