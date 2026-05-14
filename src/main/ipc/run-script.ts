// Why: per-repo single-instance run-script registry. The design (docs/plans/
// 2026-05-14-per-repo-run-script-design.md "PTY ownership") requires at most one
// run PTY per repo so that pressing Cmd+R in worktree B kills any in-flight run
// in worktree A. The generation counter prevents a stale onExit (from a PTY
// killed during a fast kill+respawn cycle) from clearing the fresh entry.

type RunPtyEntry = {
  ptyId: string
  worktreeId: string
  generation: number
}

const runPtyByRepo = new Map<string, RunPtyEntry>()
let nextGeneration = 0

function get(repoId: string): RunPtyEntry | null {
  return runPtyByRepo.get(repoId) ?? null
}

function set(repoId: string, entry: RunPtyEntry): void {
  runPtyByRepo.set(repoId, entry)
}

function clearIfMatches(repoId: string, ptyId: string, generation: number): void {
  const cur = runPtyByRepo.get(repoId)
  if (cur && cur.ptyId === ptyId && cur.generation === generation) {
    runPtyByRepo.delete(repoId)
  }
}

function nextGen(): number {
  return ++nextGeneration
}

function clear(): void {
  runPtyByRepo.clear()
}

// Why: exported under `_testing` to discourage callers outside this module from
// mutating registry state directly. The IPC handlers in this file are the
// production surface; tests poke the primitives.
export const _testing = { get, set, clearIfMatches, clear, nextGen }
