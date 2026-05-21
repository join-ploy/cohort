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
    let runTrackers = this.trackers.get(ctx.runId)
    const existing = runTrackers?.get(ctx.step.id)
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
      const tracker: Tracker = {
        worktreeId: result.worktreeId,
        path: result.path,
        branch: result.branch
      }
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
    } catch (e) {
      // Why: createWorktree errors are typically deterministic (bad base
      //      branch, conflict, permission). Fail-fast rather than retry.
      const message = e instanceof Error ? e.message : String(e)
      return { outcome: 'failed', status: 'failed', error: message }
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
