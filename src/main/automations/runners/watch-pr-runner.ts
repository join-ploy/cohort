import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { WatchPrConfig } from '../../../shared/automations-types'
import type { PRWatchState, PRReview } from '../../github/client'
import type { PRComment } from '../../../shared/types'
import { resolveTemplate, TemplateResolutionError } from '../template'

// Liveness of the supervised pane's agent, normalized for the idle gate. The
// service maps its richer agent-status source onto this in Task 11.
export type AgentLiveStatus = 'working' | 'idle' | 'done' | 'unknown'

export type WatchPrDeps = {
  getWorktreeMeta: (
    worktreeId: string
  ) => { linkedPR: number | null; path: string; repoPath: string } | undefined
  getRepoPath: (repoId: string) => string | undefined
  resolveLinkedPR: (worktreePath: string, repoPath: string) => Promise<number | null>
  isWorktreeArchived: (worktreeId: string) => boolean
  getPRState: (
    repoPath: string,
    prNumber: number,
    opts?: { noCache?: boolean }
  ) => Promise<PRWatchState>
  getPRReviews: (repoPath: string, prNumber: number) => Promise<PRReview[]>
  getPRComments: (repoPath: string, prNumber: number) => Promise<PRComment[]>
  getAgentLiveStatus: (paneKey: string) => AgentLiveStatus
  spawnChildRun: (args: {
    parentRunId: string
    parentStepId: string
    cycleIndex: number
    cycleOutput: Record<string, unknown>
  }) => string
  getChildRunStatus: (childRunId: string) => 'active' | 'completed' | 'failed' | 'missing'
  cancelChildRunsForStep: (parentRunId: string, parentStepId: string) => void
  now: () => number
}

type Phase = 'resolving' | 'watching' | 'responding'

type WatchTracker = {
  phase: Phase
  prNumber: number | null
  repoPath: string | null
  paneKey: string | null
  handledCursor: string // ISO; '' = nothing handled yet
  pendingWatermark: string // latest arming activity seen but not yet consumed
  dirty: boolean
  activeChildRunId: string | null
  cycleIndex: number
  idleSince: number | null
  lastPollAt: number
  startedAt: number
}

// The durable subset persisted on state.output so a restart resumes correctly.
type WatchProgress = Pick<
  WatchTracker,
  | 'phase'
  | 'prNumber'
  | 'repoPath'
  | 'paneKey'
  | 'handledCursor'
  | 'pendingWatermark'
  | 'dirty'
  | 'activeChildRunId'
  | 'cycleIndex'
>

export class WatchPrRunner implements StepRunner {
  private readonly trackers = new Map<string, Map<string, WatchTracker>>()

  constructor(private readonly deps: WatchPrDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as WatchPrConfig
    const tracker = this.getOrCreateTracker(ctx)

    // ── Phase: resolving ──────────────────────────────────────────────
    if (tracker.phase === 'resolving') {
      let worktreeId: string
      try {
        worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
      } catch (e) {
        if (e instanceof TemplateResolutionError) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        throw e
      }
      const meta = this.deps.getWorktreeMeta(worktreeId)
      if (!meta) {
        return { outcome: 'failed', status: 'failed', error: `Unknown worktree "${worktreeId}".` }
      }
      // worktreeId is "<repoId>::<path>" — same convention collect-ci uses.
      const repoId = worktreeId.split('::')[0]
      const repoPath = this.deps.getRepoPath(repoId) ?? meta.repoPath
      const prNumber = meta.linkedPR ?? (await this.deps.resolveLinkedPR(meta.path, repoPath))
      if (prNumber == null) {
        return {
          outcome: 'needs-more-time',
          status: 'waiting',
          statusMessage: 'Waiting for PR to be linked',
          output: this.progressOutput(tracker)
        }
      }
      let paneKey: string
      try {
        paneKey = resolveTemplate(config.paneRef, ctx.context)
      } catch (e) {
        if (e instanceof TemplateResolutionError) {
          return { outcome: 'failed', status: 'failed', error: e.message }
        }
        throw e
      }
      tracker.prNumber = prNumber
      tracker.repoPath = repoPath
      tracker.paneKey = paneKey
      tracker.phase = 'watching'
    }

    // TODO(Task 7-9): watching + responding phases. For now, once resolved we
    // simply park in 'waiting' so the run stays alive without doing anything.
    return {
      outcome: 'needs-more-time',
      status: 'waiting',
      statusMessage: `Watching #${tracker.prNumber}`,
      output: this.progressOutput(tracker)
    }
  }

  // TODO(Task 10): cancel active child runs before clearing the tracker.
  dropRun(runId: string): void {
    this.trackers.delete(runId)
  }

  dropStep(runId: string, stepId: string): void {
    const runMap = this.trackers.get(runId)
    runMap?.delete(stepId)
    if (runMap && runMap.size === 0) {
      this.trackers.delete(runId)
    }
  }

  private getOrCreateTracker(ctx: StepRunnerCtx): WatchTracker {
    let runMap = this.trackers.get(ctx.runId)
    const existing = runMap?.get(ctx.step.id)
    if (existing) {
      return existing
    }
    // Rehydrate durable progress from state.output so a restart resumes mid-watch.
    const persisted = (ctx.state.output ?? {}) as Partial<WatchProgress>
    const tracker: WatchTracker = {
      phase: persisted.phase ?? 'resolving',
      prNumber: persisted.prNumber ?? null,
      repoPath: persisted.repoPath ?? null,
      paneKey: persisted.paneKey ?? null,
      handledCursor: persisted.handledCursor ?? '',
      pendingWatermark: persisted.pendingWatermark ?? '',
      dirty: persisted.dirty ?? false,
      activeChildRunId: persisted.activeChildRunId ?? null,
      cycleIndex: persisted.cycleIndex ?? 0,
      idleSince: null,
      lastPollAt: 0,
      startedAt: this.deps.now()
    }
    if (!runMap) {
      runMap = new Map()
      this.trackers.set(ctx.runId, runMap)
    }
    runMap.set(ctx.step.id, tracker)
    return tracker
  }

  /** Durable subset written to state.output every tick so a restart resumes. */
  private progressOutput(t: WatchTracker): WatchProgress {
    return {
      phase: t.phase,
      prNumber: t.prNumber,
      repoPath: t.repoPath,
      paneKey: t.paneKey,
      handledCursor: t.handledCursor,
      pendingWatermark: t.pendingWatermark,
      dirty: t.dirty,
      activeChildRunId: t.activeChildRunId,
      cycleIndex: t.cycleIndex
    }
  }
}
