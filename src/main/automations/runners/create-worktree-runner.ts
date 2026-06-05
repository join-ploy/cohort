import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { CreateWorktreeConfig } from '../../../shared/automations-types'
import { resolveTemplate, TemplateResolutionError } from '../template'

export type CreateWorktreeDeps = {
  createWorktree: (input: {
    repoId: string
    baseBranch: string
    branchName: string
    displayName: string
    linkedIssue?: { provider: 'linear'; id: string } | null
    /** Attribution for the sidebar's automation indicator. The runner forwards
     *  the current ctx.runId so the persisted Worktree carries a back-pointer
     *  to the AutomationRun that produced it. */
    createdByAutomationRunId?: string
  }) => Promise<{ worktreeId: string; path: string; branch: string }>
  /** Checks out an existing PR into a managed worktree (fork-aware). headRefName
   *  and isCrossRepository are best-effort hints from the trigger payload; the
   *  backend's resolvePrBaseCore re-derives them from the GitHub API if absent. */
  createWorktreeFromPr: (input: {
    repoId: string
    prNumber: number
    headRefName?: string
    isCrossRepository?: boolean
    displayName: string
    createdByAutomationRunId?: string
  }) => Promise<{ worktreeId: string; path: string; branch: string }>
  now: () => number
}

type Tracker = {
  worktreeId: string
  path: string
  branch: string
}

export class CreateWorktreeRunner implements StepRunner {
  // Why: nested map by (runId, stepId) prevents collisions if a step.id ever
  //      contains a delimiter character; mirrors RunPromptRunner's pattern so
  //      a future run-level release hook can drop both at once.
  private readonly trackers = new Map<string, Map<string, Tracker>>()

  constructor(private readonly deps: CreateWorktreeDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as CreateWorktreeConfig
    const existing = this.trackers.get(ctx.runId)?.get(ctx.step.id)
    if (existing) {
      // Why: re-tick after success is a defensive no-op — chain executor
      //      shouldn't drive a succeeded step, but if it does, return the
      //      same output rather than double-create the worktree.
      return {
        outcome: 'done',
        status: 'succeeded',
        output: existing,
        contextPatch: { steps: { [ctx.step.id]: existing } }
      }
    }

    const repoId =
      ctx.context.automation && typeof ctx.context.automation === 'object'
        ? (((ctx.context.automation as Record<string, unknown>).projectId as string | undefined) ??
          '')
        : ''
    if (!repoId) {
      return {
        outcome: 'failed',
        status: 'failed',
        error: 'CreateWorktreeRunner: context.automation.projectId is missing.'
      }
    }

    if (config.mode === 'pull-request') {
      return this.tickPullRequest(ctx, config, repoId)
    }

    let baseBranch: string
    let branchName: string
    let displayName: string
    try {
      baseBranch = resolveTemplate(config.baseBranch, ctx.context)
      branchName = resolveTemplate(config.branchName, ctx.context)
      displayName = resolveTemplate(config.displayName, ctx.context)
    } catch (e) {
      if (e instanceof TemplateResolutionError) {
        return { outcome: 'failed', status: 'failed', error: e.message }
      }
      throw e
    }

    const linkedIssue = config.linkLinearIssue ? extractLinearIssue(ctx.context) : null

    try {
      const result = await this.deps.createWorktree({
        repoId,
        baseBranch,
        branchName,
        displayName,
        linkedIssue,
        createdByAutomationRunId: ctx.runId
      })
      return this.storeTracker(ctx, {
        worktreeId: result.worktreeId,
        path: result.path,
        branch: result.branch
      })
    } catch (e) {
      // Why: createWorktree errors are typically deterministic (bad base
      //      branch, conflict, permission). Fail-fast rather than retry.
      const message = e instanceof Error ? e.message : String(e)
      return { outcome: 'failed', status: 'failed', error: message }
    }
  }

  private async tickPullRequest(
    ctx: StepRunnerCtx,
    config: CreateWorktreeConfig,
    repoId: string
  ): Promise<StepRunnerResult> {
    let displayName: string
    let pullRequestRefRaw: string
    try {
      displayName = resolveTemplate(config.displayName, ctx.context)
      // Why: empty template short-circuits resolveTemplate to '', so the
      //      positive-integer check below catches a missing pullRequestRef.
      pullRequestRefRaw = resolveTemplate(config.pullRequestRef ?? '', ctx.context)
    } catch (e) {
      if (e instanceof TemplateResolutionError) {
        return { outcome: 'failed', status: 'failed', error: e.message }
      }
      throw e
    }

    const trimmed = pullRequestRefRaw.trim()
    // Why: only accept a bare positive integer — Number() would coerce '7abc'
    //      to NaN but also accept '7.0'/'0x7'; an explicit /^\d+$/ is stricter.
    const prNumber = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return {
        outcome: 'failed',
        status: 'failed',
        error: `CreateWorktreeRunner: pull-request mode requires a positive integer PR number, got ${JSON.stringify(pullRequestRefRaw)}.`
      }
    }

    const prHints = extractGithubPr(ctx.context)

    try {
      const result = await this.deps.createWorktreeFromPr({
        repoId,
        prNumber,
        headRefName: prHints?.headRef,
        isCrossRepository: prHints?.isCrossRepository,
        displayName,
        createdByAutomationRunId: ctx.runId
      })
      return this.storeTracker(ctx, {
        worktreeId: result.worktreeId,
        path: result.path,
        branch: result.branch
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { outcome: 'failed', status: 'failed', error: message }
    }
  }

  private storeTracker(ctx: StepRunnerCtx, tracker: Tracker): StepRunnerResult {
    let runTrackers = this.trackers.get(ctx.runId)
    if (!runTrackers) {
      runTrackers = new Map()
      this.trackers.set(ctx.runId, runTrackers)
    }
    runTrackers.set(ctx.step.id, tracker)
    return {
      outcome: 'done',
      status: 'succeeded',
      output: tracker,
      contextPatch: { steps: { [ctx.step.id]: tracker } }
    }
  }

  dropRun(runId: string): void {
    this.trackers.delete(runId)
  }

  dropStep(runId: string, stepId: string): void {
    const runTrackers = this.trackers.get(runId)
    if (!runTrackers) {
      return
    }
    runTrackers.delete(stepId)
    if (runTrackers.size === 0) {
      this.trackers.delete(runId)
    }
  }
}

function extractLinearIssue(
  context: Record<string, unknown>
): { provider: 'linear'; id: string } | null {
  const trigger = context.trigger
  if (!trigger || typeof trigger !== 'object') {
    return null
  }
  const linear = (trigger as Record<string, unknown>).linear
  if (!linear || typeof linear !== 'object') {
    return null
  }
  const issue = (linear as Record<string, unknown>).issue
  if (!issue || typeof issue !== 'object') {
    return null
  }
  const id = (issue as Record<string, unknown>).id
  if (typeof id !== 'string') {
    return null
  }
  return { provider: 'linear', id }
}

// Best-effort hints from a github-pr trigger payload. Returns null on any
// missing/malformed level so PR mode can still proceed (the backend re-derives
// these from the GitHub API when absent).
function extractGithubPr(
  context: Record<string, unknown>
): { headRef?: string; isCrossRepository?: boolean } | null {
  const trigger = context.trigger
  if (!trigger || typeof trigger !== 'object') {
    return null
  }
  const github = (trigger as Record<string, unknown>).github
  if (!github || typeof github !== 'object') {
    return null
  }
  const pr = (github as Record<string, unknown>).pr
  if (!pr || typeof pr !== 'object') {
    return null
  }
  const prRecord = pr as Record<string, unknown>
  const headRef = typeof prRecord.headRef === 'string' ? prRecord.headRef : undefined
  const isCrossRepository =
    typeof prRecord.isCrossRepository === 'boolean' ? prRecord.isCrossRepository : undefined
  return { headRef, isCrossRepository }
}
