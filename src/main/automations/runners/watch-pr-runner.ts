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
  prUrl: string // best-effort; '' until Task 8's cycle-output fetch learns it
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
  | 'prUrl'
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

    // worktreeId is needed by both resolving and watching (terminal check), so
    // resolve it once up front and guard the template error in a single place.
    let worktreeId: string
    try {
      worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
    } catch (e) {
      if (e instanceof TemplateResolutionError) {
        return { outcome: 'failed', status: 'failed', error: e.message }
      }
      throw e
    }

    // ── Phase: resolving ──────────────────────────────────────────────
    if (tracker.phase === 'resolving') {
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

    // ── Phase: watching ──────────────────────────────────────────────
    if (tracker.phase === 'watching') {
      const terminal = await this.checkTerminal(ctx, tracker, worktreeId)
      if (terminal) {
        return terminal
      }
      await this.pollArming(tracker, config, this.deps.now())
      // TODO(Task 8): four-part idle gate + spawn a cycle when dirty.
      const pollIntervalMs = (config.pollIntervalSeconds ?? 30) * 1000
      return {
        outcome: 'needs-more-time',
        status: 'waiting',
        statusMessage: tracker.dirty
          ? `Changes requested on #${tracker.prNumber} — pending`
          : `Watching #${tracker.prNumber}`,
        nextPollAt: this.deps.now() + pollIntervalMs,
        output: this.progressOutput(tracker)
      }
    }

    // TODO(Task 9): responding phase. For now, any other phase parks in waiting
    // so the run stays alive without doing anything.
    return {
      outcome: 'needs-more-time',
      status: 'waiting',
      statusMessage: `Watching #${tracker.prNumber}`,
      output: this.progressOutput(tracker)
    }
  }

  /** Returns a terminal step result (merged/closed/archived), or null to keep
   *  watching. Archived is a forced teardown checked before any PR read. */
  private async checkTerminal(
    ctx: StepRunnerCtx,
    tracker: WatchTracker,
    worktreeId: string
  ): Promise<StepRunnerResult | null> {
    // Forced teardown: workspace archived → stop the chain cleanly.
    if (this.deps.isWorktreeArchived(worktreeId)) {
      this.deps.cancelChildRunsForStep(ctx.runId, ctx.step.id)
      return this.finish(ctx.step.id, tracker, 'archived', true, 'Stopped — workspace archived')
    }
    const state = await this.deps.getPRState(tracker.repoPath!, tracker.prNumber!, {
      noCache: true
    })
    if (state.state === 'MERGED') {
      this.deps.cancelChildRunsForStep(ctx.runId, ctx.step.id) // cancel any in-flight cycle (Q4)
      // endChain=false → the chain continues to downstream steps.
      return this.finish(ctx.step.id, tracker, 'merged', false, 'PR merged')
    }
    if (state.state === 'CLOSED') {
      this.deps.cancelChildRunsForStep(ctx.runId, ctx.step.id)
      // endChain=true → the chain stops cleanly, finalized as completed.
      return this.finish(ctx.step.id, tracker, 'closed', true, 'PR closed')
    }
    return null
  }

  /** Build the WATCH_PR_OUTPUT_SCHEMA terminal result. Both output and the
   *  contextPatch step entry carry the same final shape so downstream steps can
   *  template {{steps.<id>.finalState}} etc. */
  private finish(
    stepId: string,
    tracker: WatchTracker,
    finalState: 'merged' | 'closed' | 'archived',
    endChain: boolean,
    msg: string
  ): StepRunnerResult {
    const output = {
      finalState,
      cyclesRun: tracker.cycleIndex,
      prNumber: tracker.prNumber ?? 0,
      prUrl: tracker.prUrl,
      finishedAt: this.deps.now()
    }
    return {
      outcome: 'done',
      status: 'succeeded',
      endChain,
      statusMessage: msg,
      output,
      contextPatch: { steps: { [stepId]: output } }
    }
  }

  /** True when a review should arm a cycle given the configured event filters. */
  private armingMatches(review: PRReview, events: WatchPrConfig['events']): boolean {
    if (events.anyReview) {
      return true
    }
    if (events.changesRequested && review.state === 'CHANGES_REQUESTED') {
      return true
    }
    if (events.newReviewComments && review.state === 'COMMENTED') {
      return true
    }
    return false
  }

  /** Poll the review feed at the configured cadence; arm (set dirty) when a
   *  matching review newer than the handled cursor appears. */
  private async pollArming(
    tracker: WatchTracker,
    config: WatchPrConfig,
    now: number
  ): Promise<void> {
    const pollIntervalMs = (config.pollIntervalSeconds ?? 30) * 1000
    if (now < tracker.lastPollAt + pollIntervalMs) {
      return
    }
    tracker.lastPollAt = now
    const reviews = await this.deps.getPRReviews(tracker.repoPath!, tracker.prNumber!)
    const armed = reviews.filter(
      (r) =>
        r.submittedAt &&
        r.submittedAt > tracker.handledCursor &&
        this.armingMatches(r, config.events)
    )
    if (armed.length > 0) {
      tracker.dirty = true
      tracker.pendingWatermark = armed.at(-1)!.submittedAt
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
      prUrl: persisted.prUrl ?? '',
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
      prUrl: t.prUrl,
      handledCursor: t.handledCursor,
      pendingWatermark: t.pendingWatermark,
      dirty: t.dirty,
      activeChildRunId: t.activeChildRunId,
      cycleIndex: t.cycleIndex
    }
  }
}
