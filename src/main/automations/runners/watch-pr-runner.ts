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
      // Capture now once and reuse for poll cadence + idle-debounce math so a
      // single tick reasons about one consistent instant.
      const now = this.deps.now()
      const pollIntervalMs = (config.pollIntervalSeconds ?? 30) * 1000
      // Single cadence gate over BOTH network reads (terminal state + arming
      // reviews) so getPRState/getPRReviews run at most once per poll interval —
      // the idle gate below still runs every tick off the last-polled state.
      const due = now >= tracker.lastPollAt + pollIntervalMs
      if (due) {
        tracker.lastPollAt = now
        const terminal = await this.checkTerminal(ctx, tracker, worktreeId)
        if (terminal) {
          return terminal
        }
        this.armFromReviews(
          await this.deps.getPRReviews(tracker.repoPath!, tracker.prNumber!),
          tracker,
          config
        )
      }

      // Four-part gate: dirty AND no active child AND agent idle (debounced).
      if (tracker.dirty && tracker.activeChildRunId == null) {
        const status = this.deps.getAgentLiveStatus(tracker.paneKey ?? '')
        const idle = status === 'idle' || status === 'done'
        if (!idle) {
          tracker.idleSince = null // reset debounce; agent went back to work
          return {
            outcome: 'needs-more-time',
            status: 'waiting',
            statusMessage: `Changes requested on #${tracker.prNumber} — waiting for agent to finish`,
            nextPollAt: now + pollIntervalMs,
            output: this.progressOutput(tracker)
          }
        }
        if (tracker.idleSince == null) {
          tracker.idleSince = now
        }
        const debounceMs = (config.agentIdleDebounceSeconds ?? 5) * 1000
        if (now - tracker.idleSince < debounceMs) {
          return {
            outcome: 'needs-more-time',
            status: 'waiting',
            statusMessage: `Agent idle — confirming before responding to #${tracker.prNumber}`,
            output: this.progressOutput(tracker)
          }
        }
        // Fire a cycle. cycleIndex bumps BEFORE buildCycleOutput so the payload
        // carries the new index; handledCursor advances AFTER so buildCycleOutput's
        // `armed` filter still captures this cycle's reviews against the old cursor.
        tracker.cycleIndex += 1
        const cycleOutput = await this.buildCycleOutput(tracker, config)
        const childRunId = this.deps.spawnChildRun({
          parentRunId: ctx.runId,
          parentStepId: ctx.step.id,
          cycleIndex: tracker.cycleIndex,
          cycleOutput
        })
        tracker.activeChildRunId = childRunId
        tracker.handledCursor = tracker.pendingWatermark // consume up to the watermark
        tracker.dirty = false
        tracker.idleSince = null
        tracker.phase = 'responding'
        return {
          outcome: 'needs-more-time',
          status: 'waiting',
          statusMessage: `Responding to #${tracker.prNumber} (round ${tracker.cycleIndex})`,
          nextPollAt: now + pollIntervalMs,
          output: this.progressOutput(tracker)
        }
      }

      return {
        outcome: 'needs-more-time',
        status: 'waiting',
        statusMessage: tracker.dirty
          ? `Changes requested on #${tracker.prNumber} — pending`
          : `Watching #${tracker.prNumber}`,
        nextPollAt: tracker.lastPollAt + pollIntervalMs,
        output: this.progressOutput(tracker)
      }
    }

    // ── Phase: responding ─────────────────────────────────────────────
    if (tracker.phase === 'responding') {
      const now = this.deps.now()
      const pollIntervalMs = (config.pollIntervalSeconds ?? 30) * 1000
      // Child status is cheap/in-memory — check every tick.
      const childStatus = this.deps.getChildRunStatus(tracker.activeChildRunId!)
      // Network reads gated to the poll interval (terminal + coalesce arming).
      if (now >= tracker.lastPollAt + pollIntervalMs) {
        tracker.lastPollAt = now
        const terminal = await this.checkTerminal(ctx, tracker, worktreeId)
        if (terminal) {
          return terminal // merged/closed/archived cancels child + finishes (Q4)
        }
        // Keep arming during the cycle so feedback arriving mid-cycle coalesces
        // into the next round.
        this.armFromReviews(
          await this.deps.getPRReviews(tracker.repoPath!, tracker.prNumber!),
          tracker,
          config
        )
      }
      if (childStatus === 'active') {
        return {
          outcome: 'needs-more-time',
          status: 'waiting',
          statusMessage: `Responding to #${tracker.prNumber} (round ${tracker.cycleIndex})`,
          nextPollAt: tracker.lastPollAt + pollIntervalMs,
          output: this.progressOutput(tracker)
        }
      }
      // Cycle finished (completed | failed | missing).
      if (childStatus === 'failed' && config.failedCycleHaltsLoop) {
        return {
          outcome: 'failed',
          status: 'failed',
          error: `Review cycle ${tracker.cycleIndex} failed.`
        }
      }
      // Loop back to watching. If feedback arrived mid-cycle (dirty), the watching
      // gate fires the next cycle on the next tick (coalesced).
      tracker.activeChildRunId = null
      tracker.phase = 'watching'
      return {
        outcome: 'needs-more-time',
        status: 'waiting',
        statusMessage: `Watching #${tracker.prNumber}`,
        // nextPollAt: now so the watching gate re-evaluates promptly; lastPollAt
        // was just (or recently) set so a coalesced cycle fires without a redundant poll.
        nextPollAt: now,
        output: this.progressOutput(tracker)
      }
    }

    // Unreachable: every phase above returns. Park in waiting as a safety net.
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
    // Cache the url so finish() emits it even when the PR merges/closes before
    // any response cycle ran (buildCycleOutput, which normally caches it, never ran).
    tracker.prUrl = state.url
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

  /** Arm (set dirty) when an already-fetched review newer than the handled
   *  cursor matches the configured events. Cadence-free — the caller owns the
   *  poll gate so this can run on freshly-polled reviews from either phase. */
  private armFromReviews(reviews: PRReview[], tracker: WatchTracker, config: WatchPrConfig): void {
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

  /** Build the per-cycle payload (WATCH_PR_CYCLE_SCHEMA) seeded into the child
   *  run's context. `armed` reflects only the reviews this cycle consumes — those
   *  newer than the still-old handledCursor that match the configured events. */
  private async buildCycleOutput(
    tracker: WatchTracker,
    config: WatchPrConfig
  ): Promise<Record<string, unknown>> {
    const reviews = await this.deps.getPRReviews(tracker.repoPath!, tracker.prNumber!)
    const armed = reviews.filter(
      (r) =>
        r.submittedAt &&
        r.submittedAt > tracker.handledCursor &&
        this.armingMatches(r, config.events)
    )
    const latest = armed.at(-1)
    const prState = await this.deps.getPRState(tracker.repoPath!, tracker.prNumber!)
    tracker.prUrl = prState.url // cache so the final terminal output carries it too
    const comments = await this.deps.getPRComments(tracker.repoPath!, tracker.prNumber!)
    const unresolved = comments.filter((c) => !c.isResolved)
    return {
      prNumber: tracker.prNumber ?? 0,
      prUrl: prState.url,
      prTitle: prState.title,
      reviewState: latest?.state ?? '',
      reviewAuthor: latest?.author ?? '',
      reviewBody: latest?.body ?? '',
      commentsJson: JSON.stringify(unresolved),
      commentsSummary: buildCommentsSummary(unresolved),
      cycleIndex: tracker.cycleIndex,
      changeRequestCount: armed.length
    }
  }

  dropRun(runId: string): void {
    const runMap = this.trackers.get(runId)
    if (runMap) {
      // Cancel each tracked step's active child cycle so a stopped watch doesn't
      // orphan a running branch run after the in-memory tracker is gone.
      for (const stepId of runMap.keys()) {
        this.deps.cancelChildRunsForStep(runId, stepId)
      }
    }
    this.trackers.delete(runId)
  }

  dropStep(runId: string, stepId: string): void {
    // Cancel the active child cycle so a retried/dropped watch step doesn't
    // orphan a running branch run before the chain re-reaches the node.
    this.deps.cancelChildRunsForStep(runId, stepId)
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

/** Markdown digest of the unresolved feedback, one bullet per comment, so the
 *  child run has a readable summary alongside the structured commentsJson. */
function buildCommentsSummary(comments: PRComment[]): string {
  if (comments.length === 0) {
    return 'No unresolved comments.'
  }
  const lines: string[] = []
  for (const c of comments) {
    const location = c.path ? `${c.path}${c.line != null ? `:${c.line}` : ''}` : 'conversation'
    const firstLine = c.body.split('\n')[0]
    lines.push(`- **${c.author}** (${location})`)
    lines.push(`  > ${firstLine}`)
  }
  return lines.join('\n')
}
