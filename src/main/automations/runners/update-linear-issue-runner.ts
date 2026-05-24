import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { UpdateLinearIssueConfig } from '../../../shared/automations-types'
import { resolveTemplate, TemplateResolutionError } from '../template'

export type UpdateLinearIssueDeps = {
  /** Calls into src/main/linear/issues.ts#updateIssue. Narrow shape so tests
   *  can stub without instantiating the Linear SDK. */
  updateIssue: (
    id: string,
    updates: { assigneeId?: string; stateId?: string }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
}

type Tracker = {
  /** Once the underlying Linear mutation resolves (success or failure), we
   *  record the terminal outcome here so a re-tick from the scheduler doesn't
   *  re-fire the mutation. Mirrors the (runId, stepId) keying used by every
   *  other runner. */
  resolved: StepRunnerResult
}

export class UpdateLinearIssueRunner implements StepRunner {
  // Why: nested map keyed by (runId, stepId) mirrors WaitForSetupRunner so a
  // step.id containing ':' can't collide with another run's tracker.
  private readonly trackers = new Map<string, Map<string, Tracker>>()

  constructor(private readonly deps: UpdateLinearIssueDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as UpdateLinearIssueConfig

    // Why: idempotent re-tick — if a prior tick already resolved this (runId,
    // stepId), return the cached outcome instead of re-issuing the mutation.
    const cached = this.trackers.get(ctx.runId)?.get(ctx.step.id)
    if (cached) {
      return cached.resolved
    }

    let issueId: string
    let assigneeId: string | undefined
    let stateId: string | undefined
    try {
      issueId = resolveTemplate(config.issueRef, ctx.context).trim()
      const rawAssignee = config.assigneeRef
        ? resolveTemplate(config.assigneeRef, ctx.context).trim()
        : ''
      const rawState = config.stateRef ? resolveTemplate(config.stateRef, ctx.context).trim() : ''
      assigneeId = rawAssignee.length > 0 ? rawAssignee : undefined
      stateId = rawState.length > 0 ? rawState : undefined
    } catch (e) {
      // Template resolution errors can never succeed on retry — bad authoring
      // or missing context. Fail fast instead of looping forever.
      if (e instanceof TemplateResolutionError) {
        const result: StepRunnerResult = {
          outcome: 'failed',
          status: 'failed',
          error: e.message
        }
        this.recordResolved(ctx.runId, ctx.step.id, result)
        return result
      }
      throw e
    }

    if (issueId.length === 0) {
      const result: StepRunnerResult = {
        outcome: 'failed',
        status: 'failed',
        error: 'update-linear-issue: issueRef resolved to an empty string.'
      }
      this.recordResolved(ctx.runId, ctx.step.id, result)
      return result
    }

    // Why: the step's design contract requires at least one mutation — calling
    // Linear with an empty payload would be a no-op that silently masks a bad
    // config. Fail fast so the author sees the misconfiguration.
    if (assigneeId === undefined && stateId === undefined) {
      const result: StepRunnerResult = {
        outcome: 'failed',
        status: 'failed',
        error:
          'update-linear-issue: at least one of assigneeRef or stateRef must be set (after template resolution).'
      }
      this.recordResolved(ctx.runId, ctx.step.id, result)
      return result
    }

    const updates: { assigneeId?: string; stateId?: string } = {}
    if (assigneeId !== undefined) {
      updates.assigneeId = assigneeId
    }
    if (stateId !== undefined) {
      updates.stateId = stateId
    }

    const linearResult = await this.deps.updateIssue(issueId, updates)
    const result: StepRunnerResult = linearResult.ok
      ? { outcome: 'done', status: 'succeeded', output: {} }
      : {
          outcome: 'failed',
          status: 'failed',
          error: `update-linear-issue: ${linearResult.error}`
        }
    this.recordResolved(ctx.runId, ctx.step.id, result)
    return result
  }

  private recordResolved(runId: string, stepId: string, result: StepRunnerResult): void {
    let runTrackers = this.trackers.get(runId)
    if (!runTrackers) {
      runTrackers = new Map()
      this.trackers.set(runId, runTrackers)
    }
    runTrackers.set(stepId, { resolved: result })
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
