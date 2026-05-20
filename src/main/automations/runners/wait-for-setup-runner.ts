import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { WaitForSetupConfig } from '../../../shared/automations-types'
import type { SetupScriptEntry } from '../../setup-script/registry'
import { resolveTemplate, TemplateResolutionError } from '../template'

export type WaitForSetupDeps = {
  getSetupScript: (worktreeId: string) => SetupScriptEntry | undefined
  now: () => number
}

type Tracker = {
  /** Wall-clock when the runner first looked at this worktree — anchors the
   *  per-step timeout. Once set on first tick, never re-stamped. */
  openedAt: number
}

export class WaitForSetupRunner implements StepRunner {
  // Why: nested map keyed by (runId, stepId) mirrors RunPromptRunner so a
  // step.id containing ':' can't collide with another run's tracker.
  private readonly trackers = new Map<string, Map<string, Tracker>>()

  constructor(private readonly deps: WaitForSetupDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as WaitForSetupConfig

    let worktreeId: string
    try {
      worktreeId = resolveTemplate(config.worktreeRef, ctx.context)
    } catch (e) {
      // Template resolution errors can never succeed on retry (bad authoring
      // or missing context), so fail-fast instead of looping forever.
      if (e instanceof TemplateResolutionError) {
        return { outcome: 'failed', status: 'failed', error: e.message }
      }
      throw e
    }

    let runTrackers = this.trackers.get(ctx.runId)
    let tracker = runTrackers?.get(ctx.step.id)
    if (!tracker) {
      tracker = { openedAt: this.deps.now() }
      if (!runTrackers) {
        runTrackers = new Map()
        this.trackers.set(ctx.runId, runTrackers)
      }
      runTrackers.set(ctx.step.id, tracker)
    }

    const now = this.deps.now()

    // Per design § "Agent step lifecycle": the step-level timeout is the only
    // hard escape valve. Check it BEFORE reading the registry so a permanently
    // running setup script can still time out cleanly.
    if (ctx.step.timeoutSeconds != null) {
      const elapsedMs = now - tracker.openedAt
      if (elapsedMs >= ctx.step.timeoutSeconds * 1000) {
        return {
          outcome: 'failed',
          status: 'timed-out',
          error: `Step exceeded timeout of ${ctx.step.timeoutSeconds}s.`
        }
      }
    }

    const entry = this.deps.getSetupScript(worktreeId)

    if (!entry) {
      // Why: missing registry entry means no setup script ever ran for this
      // worktree (either none is configured, or this worktree was created
      // outside the spawn path). Resolve immediately so chains don't block
      // waiting for a script that will never start. Authors who need to
      // require a setup-script success can encode that as a separate guard
      // step; `requireSuccess: true` only enforces success of an entry that
      // exists.
      return {
        outcome: 'done',
        status: 'succeeded',
        output: { exitCode: 0, durationMs: 0 }
      }
    }

    if (entry.state === 'pending' || entry.state === 'running') {
      return { outcome: 'needs-more-time', status: 'running' }
    }

    const durationMs =
      entry.startedAt != null && entry.finishedAt != null ? entry.finishedAt - entry.startedAt : 0
    const exitCode = entry.exitCode ?? 0

    if (entry.state === 'exited-success') {
      return {
        outcome: 'done',
        status: 'succeeded',
        output: { exitCode, durationMs }
      }
    }

    // entry.state === 'exited-failure'
    if (config.requireSuccess) {
      return {
        outcome: 'failed',
        status: 'failed',
        error: `Setup script exited with exit code ${exitCode}.`
      }
    }
    return {
      outcome: 'done',
      status: 'succeeded',
      output: { exitCode, durationMs }
    }
  }
}
