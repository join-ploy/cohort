import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { WatchPrConfig } from '../../../shared/automations-types'
import type { PRWatchState, PRReview } from '../../github/client'
import type { PRComment, WorkspaceGroup } from '../../../shared/types'
import { parseMemberScopedRef } from '../../../shared/automation-member-scoped-ref'
import { findGroupById } from '../../workspace-group-runtime'
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
  /** All workspace groups — for expanding a group:<uuid> worktreeRef into members. */
  getWorkspaceGroups: () => readonly WorkspaceGroup[]
  /** True when the worktree has a diff from main — a no-diff member has no PR. */
  hasChangesFromMain: (
    worktreeId: string,
    path: string,
    connectionId: string | null
  ) => Promise<boolean>
  /** Connection id for a repo (SSH-aware), passed to hasChangesFromMain. */
  getConnectionId: (repoId: string) => string | null
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
  /** Spawn the background detached watcher run; returns its id. */
  spawnDetachedWatcher: (args: {
    fromRunId: string
    stepId: string
    context: Record<string, unknown>
  }) => string
  getChildRunStatus: (childRunId: string) => 'active' | 'completed' | 'failed' | 'missing'
  cancelChildRunsForStep: (parentRunId: string, parentStepId: string) => void
  now: () => number
}

type Phase = 'resolving' | 'watching' | 'responding'

type Settled = 'open' | 'merged' | 'closed' | 'approved'

// One watched member PR. A single-worktree node is the degenerate 1-member case;
// a group node holds one entry per member with a diff-from-main.
type MemberState = {
  worktreeId: string
  prNumber: number
  repoPath: string
  prUrl: string // best-effort; cached on first cycle-output or terminal read
  handledCursor: string // per-member high-water (review id, numeric string); '' = nothing handled yet
  pendingWatermark: string // latest armed review id seen but not yet consumed (numeric string)
  dirty: boolean
  settled: Settled
}

type WatchTracker = {
  phase: Phase
  members: Map<string, MemberState> // keyed by worktreeId
  paneKey: string | null
  // Shared pane-cycle state (singular — one pane, one in-flight cycle):
  activeChildRunId: string | null
  cycleIndex: number
  idleSince: number | null
  lastPollAt: number
  startedAt: number
}

// The durable subset persisted on state.output so a restart resumes correctly.
// members is a plain array (Map doesn't serialise); idleSince/lastPollAt/startedAt
// stay in-memory only (same as before — they reset cleanly on restart).
type DurableMember = Pick<
  MemberState,
  | 'worktreeId'
  | 'prNumber'
  | 'repoPath'
  | 'prUrl'
  | 'handledCursor'
  | 'pendingWatermark'
  | 'dirty'
  | 'settled'
>

type WatchProgress = {
  phase: Phase
  members: DurableMember[]
  paneKey: string | null
  activeChildRunId: string | null
  cycleIndex: number
}

// One batched member's feedback, assembled by buildCycleOutput. repoPath is
// internal (drives the combinedSummary section header); it's stripped from the
// durable membersJson payload.
type PerMemberCycleEntry = {
  worktreeId: string
  prNumber: number
  prUrl: string
  prTitle: string
  reviewState: string
  reviewAuthor: string
  reviewBody: string
  commentsJson: string
  commentsSummary: string
  repoPath: string
}

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

    // Detached: spawn a background run carrying this loop and return done so the
    // chain continues. The spawned run sets __watchDetached in its context, so when
    // IT ticks this branch is skipped and the normal loop runs (no re-spawn).
    // Placed after worktreeId resolution so a bad worktreeRef fails fast before
    // spawning a detached run that could never resolve its target.
    if (config.detached && !ctx.context.__watchDetached) {
      const detachedRunId = this.deps.spawnDetachedWatcher({
        fromRunId: ctx.runId,
        stepId: ctx.step.id,
        context: ctx.context
      })
      const output = { detached: true, detachedRunId }
      return {
        outcome: 'done',
        status: 'succeeded',
        statusMessage: 'Watching in the background',
        output,
        contextPatch: { steps: { [ctx.step.id]: output } }
      }
    }

    // ── Phase: resolving ──────────────────────────────────────────────
    if (tracker.phase === 'resolving') {
      // Expand the ref into members: single worktree → [id]; group → its members.
      const worktreeIds = this.expandRef(worktreeId)
      if (!worktreeIds) {
        return {
          outcome: 'failed',
          status: 'failed',
          error: `Could not resolve worktreeRef "${worktreeId}".`
        }
      }

      // Filter to members that have a diff from main — a no-diff member has no PR,
      // so it's skipped. worktreeId is "<repoId>::<path>" (the collect-ci convention).
      const eligible: {
        id: string
        repoPath: string
        meta: NonNullable<ReturnType<WatchPrDeps['getWorktreeMeta']>>
      }[] = []
      for (const id of worktreeIds) {
        const meta = this.deps.getWorktreeMeta(id)
        if (!meta) {
          continue // member worktree gone — skip it
        }
        const repoId = id.split('::')[0]
        const repoPath = this.deps.getRepoPath(repoId) ?? meta.repoPath
        const connectionId = this.deps.getConnectionId(repoId)
        const hasChanges = await this.deps.hasChangesFromMain(id, meta.path, connectionId)
        if (hasChanges) {
          eligible.push({ id, repoPath, meta })
        }
      }

      // Empty group (no member has a diff): nothing to watch. Returning a clean
      // done (mirroring collect-ci's "nothing to collect") rather than routing
      // through finishAggregate — with zero members that path yields
      // partial-closed + endChain true, which would wrongly halt the chain.
      if (eligible.length === 0) {
        // members is still empty here, so buildTerminalResult emits memberCount 0
        // / all-merged / endChain false — reusing it keeps this payload from
        // drifting from the other terminal outputs.
        return this.buildTerminalResult(
          ctx.step.id,
          tracker,
          'all-merged',
          false,
          'No member worktrees with changes — nothing to watch.'
        )
      }

      // Resolve each eligible member's PR. If ANY isn't linked yet, wait and
      // re-resolve next tick (don't partially populate) — mirrors collect-ci's
      // phase-2 "wait until every expected PR is linked" so we only transition to
      // watching once the whole group is ready.
      const resolved: { id: string; prNumber: number; repoPath: string }[] = []
      for (const { id, repoPath, meta } of eligible) {
        const prNumber = meta.linkedPR ?? (await this.deps.resolveLinkedPR(meta.path, repoPath))
        if (prNumber == null) {
          return {
            outcome: 'needs-more-time',
            status: 'waiting',
            statusMessage: 'Waiting for PRs to be linked',
            output: this.progressOutput(tracker)
          }
        }
        resolved.push({ id, prNumber, repoPath })
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
      for (const { id, prNumber, repoPath } of resolved) {
        tracker.members.set(id, {
          worktreeId: id,
          prNumber,
          repoPath,
          prUrl: '',
          handledCursor: '',
          pendingWatermark: '',
          dirty: false,
          settled: 'open'
        })
      }
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
      // reviews) so the per-member sweep runs at most once per poll interval —
      // the idle gate below still runs every tick off the last-polled state.
      const due = now >= tracker.lastPollAt + pollIntervalMs
      if (due) {
        tracker.lastPollAt = now
        const terminal = await this.sweep(ctx, tracker, config)
        if (terminal) {
          return terminal
        }
      }

      // Gate: any open member dirty AND no active child AND agent idle (debounced).
      const dirtyOpen = [...tracker.members.values()].filter((m) => m.dirty && m.settled === 'open')
      const prLabel = this.prLabel(tracker)
      if (dirtyOpen.length > 0 && tracker.activeChildRunId == null) {
        const status = this.deps.getAgentLiveStatus(tracker.paneKey ?? '')
        const idle = status === 'idle' || status === 'done'
        if (!idle) {
          tracker.idleSince = null // reset debounce; agent went back to work
          return {
            outcome: 'needs-more-time',
            status: 'waiting',
            statusMessage: `Changes requested on ${prLabel} — waiting for agent to finish`,
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
            statusMessage: `Agent idle — confirming before responding to ${prLabel}`,
            output: this.progressOutput(tracker)
          }
        }
        // Fire a single batched cycle over all currently-dirty open members.
        // cycleIndex bumps BEFORE buildCycleOutput so the payload carries the new
        // index; handledCursor advances AFTER so buildCycleOutput's `armed` filter
        // still captures this cycle's reviews against the old per-member cursor.
        const batch = dirtyOpen
        tracker.cycleIndex += 1
        const cycleOutput = await this.buildCycleOutput(batch, tracker, config)
        const childRunId = this.deps.spawnChildRun({
          parentRunId: ctx.runId,
          parentStepId: ctx.step.id,
          cycleIndex: tracker.cycleIndex,
          cycleOutput
        })
        tracker.activeChildRunId = childRunId
        for (const m of batch) {
          m.handledCursor = m.pendingWatermark // consume up to the watermark
          m.dirty = false
        }
        tracker.idleSince = null
        tracker.phase = 'responding'
        return {
          outcome: 'needs-more-time',
          status: 'waiting',
          statusMessage: `Responding to ${prLabel} (round ${tracker.cycleIndex})`,
          nextPollAt: now + pollIntervalMs,
          output: this.progressOutput(tracker)
        }
      }

      return {
        outcome: 'needs-more-time',
        status: 'waiting',
        statusMessage:
          dirtyOpen.length > 0
            ? `Changes requested on ${prLabel} — pending`
            : `Watching ${prLabel}`,
        nextPollAt: tracker.lastPollAt + pollIntervalMs,
        output: this.progressOutput(tracker)
      }
    }

    // ── Phase: responding ─────────────────────────────────────────────
    if (tracker.phase === 'responding') {
      const now = this.deps.now()
      const pollIntervalMs = (config.pollIntervalSeconds ?? 30) * 1000
      const prLabel = this.prLabel(tracker)
      // Child status is cheap/in-memory — check every tick.
      const childStatus = this.deps.getChildRunStatus(tracker.activeChildRunId!)
      // Network reads gated to the poll interval (per-member terminal + coalesce arming).
      if (now >= tracker.lastPollAt + pollIntervalMs) {
        tracker.lastPollAt = now
        const terminal = await this.sweep(ctx, tracker, config)
        if (terminal) {
          return terminal // every member settled cancels child + finishes (Q4)
        }
      }
      if (childStatus === 'active') {
        return {
          outcome: 'needs-more-time',
          status: 'waiting',
          statusMessage: `Responding to ${prLabel} (round ${tracker.cycleIndex})`,
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
      // Loop back to watching. If feedback arrived mid-cycle (any member dirty),
      // the watching gate fires the next batched cycle on the next tick (coalesced).
      tracker.activeChildRunId = null
      tracker.phase = 'watching'
      return {
        outcome: 'needs-more-time',
        status: 'waiting',
        statusMessage: `Watching ${prLabel}`,
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
      statusMessage: `Watching ${this.prLabel(tracker)}`,
      output: this.progressOutput(tracker)
    }
  }

  /** Per-interval per-member sweep: terminal settle + arming. Returns a terminal
   *  step result when EVERY member is settled (or the workspace is archived), or
   *  null to keep watching. Archived is a forced teardown checked before any PR
   *  read. The caller owns the poll cadence gate. */
  private async sweep(
    ctx: StepRunnerCtx,
    tracker: WatchTracker,
    config: WatchPrConfig
  ): Promise<StepRunnerResult | null> {
    // Forced teardown: an OPEN member's worktree archived (or its group) → stop
    // the chain cleanly. Check each member's real worktreeId (the group: ref has
    // no worktree meta, so it can't be passed here). Settled members are skipped
    // so a merged member's normally-pruned worktree can't trigger a false archive.
    if (
      [...tracker.members.values()].some(
        (m) => m.settled === 'open' && this.deps.isWorktreeArchived(m.worktreeId)
      )
    ) {
      this.deps.cancelChildRunsForStep(ctx.runId, ctx.step.id)
      return this.finishArchived(ctx.step.id, tracker)
    }
    for (const member of tracker.members.values()) {
      if (member.settled !== 'open') {
        continue
      }
      const state = await this.deps.getPRState(member.repoPath, member.prNumber, { noCache: true })
      // Cache the url so finishAggregate emits it even when the PR merges/closes
      // before any response cycle ran (buildCycleOutput, the usual cache point,
      // never ran for this member).
      member.prUrl = state.url
      if (state.state === 'MERGED') {
        member.settled = 'merged'
      } else if (state.state === 'CLOSED') {
        member.settled = 'closed'
      } else if (config.endOnApprove && state.reviewDecision === 'APPROVED') {
        // Opt-in: an approved (but unmerged) PR ends the loop — stop watching it.
        member.settled = 'approved'
      } else {
        // Still open — arm from its reviews against the member's own cursor.
        this.armFromReviews(
          await this.deps.getPRReviews(member.repoPath, member.prNumber),
          member,
          config
        )
      }
    }
    const members = [...tracker.members.values()]
    if (members.length > 0 && members.every((m) => m.settled !== 'open')) {
      // Every member settled → cancel any in-flight cycle (Q4) and finalize.
      this.deps.cancelChildRunsForStep(ctx.runId, ctx.step.id)
      return this.finishAggregate(ctx.step.id, tracker)
    }
    return null
  }

  /** Status-line PR label — '#<n>' for a single PR, '#<n> +N more' for a group.
   *  Full per-PR detail is in the cycle output. */
  private prLabel(tracker: WatchTracker): string {
    const members = [...tracker.members.values()]
    if (members.length === 0) {
      return ''
    }
    const lead = `#${members[0].prNumber}`
    return members.length === 1 ? lead : `${lead} +${members.length - 1} more`
  }

  /** Build the terminal result (output matches WATCH_PR_OUTPUT_SCHEMA). Shared by
   *  the archived and aggregate finishers so the two payloads can't drift. */
  private buildTerminalResult(
    stepId: string,
    tracker: WatchTracker,
    finalState: string,
    endChain: boolean,
    statusMessage: string
  ): StepRunnerResult {
    const members = [...tracker.members.values()]
    const first = members[0]
    const output = {
      finalState,
      memberCount: members.length,
      mergedCount: members.filter((m) => m.settled === 'merged').length,
      closedCount: members.filter((m) => m.settled === 'closed').length,
      approvedCount: members.filter((m) => m.settled === 'approved').length,
      membersJson: JSON.stringify(
        members.map((m) => ({
          worktreeId: m.worktreeId,
          prNumber: m.prNumber,
          prUrl: m.prUrl,
          finalState: m.settled
        }))
      ),
      cyclesRun: tracker.cycleIndex,
      prNumber: first?.prNumber ?? 0,
      prUrl: first?.prUrl ?? '',
      finishedAt: this.deps.now()
    }
    return {
      outcome: 'done',
      status: 'succeeded',
      endChain,
      statusMessage,
      output,
      contextPatch: { steps: { [stepId]: output } }
    }
  }

  /** Archived teardown — keeps the single-PR 'archived' finalState, stops the chain. */
  private finishArchived(stepId: string, tracker: WatchTracker): StepRunnerResult {
    return this.buildTerminalResult(
      stepId,
      tracker,
      'archived',
      true,
      'Stopped — workspace archived'
    )
  }

  /** Aggregate finish over all settled members. Any closed → stop cleanly
   *  (endChain true, 'partial-closed'); otherwise (all merged and/or approved
   *  via endOnApprove) → continue (endChain false). Single-PR: 1 merged ⇒
   *  all-merged ⇒ continue, 1 closed ⇒ partial-closed ⇒ stop, 1 approved ⇒
   *  approved ⇒ continue. */
  private finishAggregate(stepId: string, tracker: WatchTracker): StepRunnerResult {
    const members = [...tracker.members.values()]
    const anyClosed = members.some((m) => m.settled === 'closed')
    const allMerged = members.length > 0 && members.every((m) => m.settled === 'merged')
    const finalState = anyClosed ? 'partial-closed' : allMerged ? 'all-merged' : 'approved'
    return this.buildTerminalResult(
      stepId,
      tracker,
      finalState,
      anyClosed,
      anyClosed
        ? 'Group settled — some PRs closed'
        : allMerged
          ? 'All PRs merged'
          : 'All PRs approved'
    )
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

  /** Arm (set dirty) the given MEMBER when an already-fetched review newer than
   *  that member's handled cursor matches the configured events. Cadence-free —
   *  the caller owns the poll gate so this can run on freshly-polled reviews from
   *  either phase. */
  private armFromReviews(reviews: PRReview[], member: MemberState, config: WatchPrConfig): void {
    const armed = reviews.filter(
      (r) =>
        r.submittedAt && // only submitted reviews (pending ones aren't actionable)
        Number(r.id) > Number(member.handledCursor || '0') &&
        this.armingMatches(r, config.events)
    )
    if (armed.length > 0) {
      member.dirty = true
      // Review id is monotonic, so the newest submitted review (armed.at(-1), since
      // getPRReviews sorts by submittedAt) carries the high-water id. Using the id
      // (not submittedAt) means two reviews in the same second can't be dropped.
      member.pendingWatermark = armed.at(-1)!.id
    }
  }

  /** Build the batched per-cycle payload (WATCH_PR_CYCLE_SCHEMA) seeded into the
   *  child run's context. Loops the batch building one entry per member; the
   *  first/only member's fields are also exposed as top-level convenience scalars
   *  so single-PR branch prompts keep working. Each member's `armed` reflects only
   *  the reviews this cycle consumes — those newer than its still-old handledCursor
   *  that match the configured events. */
  private async buildCycleOutput(
    batch: MemberState[],
    tracker: WatchTracker,
    config: WatchPrConfig
  ): Promise<Record<string, unknown>> {
    const perMember: PerMemberCycleEntry[] = []
    let totalArmed = 0
    for (const m of batch) {
      const reviews = await this.deps.getPRReviews(m.repoPath, m.prNumber)
      const armed = reviews.filter(
        (r) =>
          r.submittedAt &&
          Number(r.id) > Number(m.handledCursor || '0') &&
          this.armingMatches(r, config.events)
      )
      totalArmed += armed.length
      const latest = armed.at(-1)
      const prState = await this.deps.getPRState(m.repoPath, m.prNumber)
      m.prUrl = prState.url // cache so the final terminal output carries it too
      const comments = (await this.deps.getPRComments(m.repoPath, m.prNumber)).filter(
        (c) => !c.isResolved
      )
      perMember.push({
        worktreeId: m.worktreeId,
        prNumber: m.prNumber,
        prUrl: prState.url,
        prTitle: prState.title,
        reviewState: latest?.state ?? '',
        reviewAuthor: latest?.author ?? '',
        reviewBody: latest?.body ?? '',
        commentsJson: JSON.stringify(comments),
        commentsSummary: buildCommentsSummary(comments),
        repoPath: m.repoPath
      })
    }
    const first = perMember[0]
    // membersJson omits the internal repoPath (used only to derive the section
    // header in combinedSummary); keep the durable per-member shape stable.
    const membersJson = perMember.map(({ repoPath: _repoPath, ...rest }) => rest)
    return {
      memberCount: batch.length,
      combinedSummary: buildCombinedSummary(perMember),
      membersJson: JSON.stringify(membersJson),
      cycleIndex: tracker.cycleIndex,
      changeRequestCount: totalArmed,
      prNumber: first?.prNumber ?? 0,
      prUrl: first?.prUrl ?? '',
      reviewState: first?.reviewState ?? '',
      reviewAuthor: first?.reviewAuthor ?? '',
      reviewBody: first?.reviewBody ?? '',
      commentsJson: first?.commentsJson ?? '[]',
      commentsSummary: first?.commentsSummary ?? '',
      // First-member convenience (like prNumber/prUrl above); per-member titles
      // also live inside each membersJson entry.
      prTitle: first?.prTitle ?? ''
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

  /** Expand a resolved worktreeRef into one or more worktreeIds: a member-scoped
   *  ref or single worktree → [id]; a group:<uuid> ref → its members (null when
   *  the group can't be found). Mirrors collect-ci's expandRef. */
  private expandRef(ref: string): string[] | null {
    const memberScoped = parseMemberScopedRef(ref)
    if (memberScoped) {
      return [memberScoped.worktreeId]
    }
    if (ref.startsWith('group:')) {
      const group = findGroupById(ref, this.deps.getWorkspaceGroups())
      return group ? group.memberWorktreeIds : null
    }
    return [ref] // single worktree
  }

  private getOrCreateTracker(ctx: StepRunnerCtx): WatchTracker {
    let runMap = this.trackers.get(ctx.runId)
    const existing = runMap?.get(ctx.step.id)
    if (existing) {
      return existing
    }
    // Rehydrate durable progress from state.output so a restart resumes mid-watch.
    const persisted = (ctx.state.output ?? {}) as Partial<WatchProgress>
    const members = new Map<string, MemberState>()
    for (const m of persisted.members ?? []) {
      members.set(m.worktreeId, {
        worktreeId: m.worktreeId,
        prNumber: m.prNumber,
        repoPath: m.repoPath,
        prUrl: m.prUrl ?? '',
        handledCursor: m.handledCursor ?? '',
        pendingWatermark: m.pendingWatermark ?? '',
        dirty: m.dirty ?? false,
        settled: m.settled ?? 'open'
      })
    }
    const tracker: WatchTracker = {
      phase: persisted.phase ?? 'resolving',
      members,
      paneKey: persisted.paneKey ?? null,
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

  /** Durable subset written to state.output every tick so a restart resumes.
   *  members serialises Map → array (idleSince/lastPollAt/startedAt stay in-memory). */
  private progressOutput(t: WatchTracker): WatchProgress {
    return {
      phase: t.phase,
      members: [...t.members.values()].map((m) => ({
        worktreeId: m.worktreeId,
        prNumber: m.prNumber,
        repoPath: m.repoPath,
        prUrl: m.prUrl,
        handledCursor: m.handledCursor,
        pendingWatermark: m.pendingWatermark,
        dirty: m.dirty,
        settled: m.settled
      })),
      paneKey: t.paneKey,
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

/** Combined markdown over a batch: one '## PR #<n> (<repo>)' section per member,
 *  carrying that member's comments summary (+ review body when present), joined
 *  by blank lines. The child run gets one readable digest spanning all batched PRs. */
function buildCombinedSummary(
  perMember: Pick<PerMemberCycleEntry, 'prNumber' | 'repoPath' | 'commentsSummary' | 'reviewBody'>[]
): string {
  const sections = perMember.map((m) => {
    const repoName = m.repoPath.split('/').pop() ?? m.repoPath
    const parts = [`## PR #${m.prNumber} (${repoName})`, m.commentsSummary]
    if (m.reviewBody) {
      parts.push(m.reviewBody)
    }
    return parts.join('\n')
  })
  return sections.join('\n\n')
}
