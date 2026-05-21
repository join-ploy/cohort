import type { Automation, AutomationRun, Step, StepRunState } from '../../shared/automations-types'
import type { StepRunner } from './step-runner'

export type ChainExecutorDeps = {
  /** Resolves a runner for a given step kind. Returning `undefined` is a hard
   *  error — the executor throws so the operator sees the misconfiguration
   *  instead of silently skipping the step. */
  getRunner: (kind: string) => StepRunner | undefined
  /** Called after every meaningful change to `run` so the Store can flush. */
  persistRun: (run: AutomationRun) => void
  now: () => number
}

const TERMINAL_STEP_STATUSES: StepRunState['status'][] = [
  'succeeded',
  'failed',
  'skipped',
  'timed-out'
]

function isTerminal(state: StepRunState): boolean {
  return TERMINAL_STEP_STATUSES.includes(state.status)
}

function makeStepState(step: Step, now: number): StepRunState {
  return {
    stepId: step.id,
    status: 'running',
    startedAt: now,
    finishedAt: null,
    output: null,
    error: null
  }
}

/**
 * Drives a single in-progress AutomationRun forward by one runner tick.
 *
 * The executor is purely orchestration: it owns the chain-shape rules
 * (advance to the next step, apply contextPatch, decide halt-vs-continue
 * on failure, finalize the run) but never touches IPC, files, or the
 * store directly. All side effects flow through {@link ChainExecutorDeps},
 * which keeps the executor trivially testable and lets the
 * AutomationService swap implementations (e.g. for SSH-routed runners)
 * without changing this file.
 *
 * StepRunState rows are appended lazily — one per step as the chain reaches
 * it — rather than materialized up-front. That way a halted run's
 * `stepStates` array faithfully records *what actually ran*, with no ghost
 * `pending` rows for downstream steps that never executed.
 */
export class ChainExecutor {
  constructor(private readonly deps: ChainExecutorDeps) {}

  async tick(automation: Automation, run: AutomationRun): Promise<void> {
    // Legacy (non-chain) automations are still scheduled through the old
    // dispatch path; the executor must ignore them so existing rows don't
    // get mutated into a half-chain state.
    if (!automation.trigger || !automation.steps || automation.steps.length === 0) {
      return
    }

    // Why: a step that returns `done` synchronously (create-worktree, an
    // instantly-resolved wait-for-setup, etc.) should not have to wait the
    // full 60s scheduler cadence before the NEXT step gets its first tick.
    // Loop until a step returns `needs-more-time`, the run finalizes, or we
    // hit the safety bound (every step gets at most 2 tries per outer tick:
    // one to start, one to land terminal — protects against a buggy runner
    // that always returns `done` without making progress).
    const maxIterations = automation.steps.length * 2 + 1
    for (let i = 0; i < maxIterations; i++) {
      const keepGoing = await this.tickOnce(automation, run)
      if (!keepGoing) {
        return
      }
    }
  }

  /** Drives one runner.tick() invocation and persists the result. Returns
   *  `true` when the caller should immediately try again (a step just landed
   *  terminal and there's more work to do) and `false` when we should wait
   *  for the next scheduler cadence (needs-more-time, halt failure, or run
   *  finalized). */
  private async tickOnce(automation: Automation, run: AutomationRun): Promise<boolean> {
    if (!run.stepStates) {
      run.stepStates = []
    }

    // Activate (or re-find) the current step. If the most recent state is
    // non-terminal, that's the one we're driving; otherwise we either move
    // on to the next step or finalize.
    let activeIdx: number
    let state: StepRunState
    const lastIdx = run.stepStates.length - 1
    if (lastIdx >= 0 && !isTerminal(run.stepStates[lastIdx])) {
      activeIdx = lastIdx
      state = run.stepStates[activeIdx]
    } else {
      // Next step is the one at index === stepStates.length. If we've already
      // run them all, finalize.
      activeIdx = run.stepStates.length
      if (activeIdx >= automation.steps.length) {
        // Defensive: all step slots are filled but the run wasn't finalized on
        // the prior tick. Route through the same finalizer the normal path
        // uses so `onFailure: 'continue'` policy is honored consistently.
        if (run.stepStates.length > 0 && run.stepStates.every(isTerminal)) {
          this.finalizeRun(automation, run)
        }
        this.deps.persistRun(run)
        return false
      }
      state = makeStepState(automation.steps[activeIdx], this.deps.now())
      run.stepStates.push(state)
    }

    const step = automation.steps[activeIdx]
    const runner = this.deps.getRunner(step.kind)
    if (!runner) {
      throw new Error(
        `No runner registered for step kind: ${step.kind} (runId=${run.id} stepId=${step.id})`
      )
    }

    const result = await runner.tick({
      runId: run.id,
      step,
      state,
      context: run.context ?? {}
    })

    // Sanity-check the runner's outcome/status pair so a buggy runner that
    // returns inconsistent values fails loudly here instead of silently
    // corrupting downstream chain state. Pure defensive: a well-behaved
    // runner will never trip these.
    if (result.outcome === 'done' && !isTerminal({ ...state, status: result.status })) {
      throw new Error(
        `Runner for step kind '${step.kind}' returned outcome='done' with non-terminal status='${result.status}' (runId=${run.id} stepId=${step.id})`
      )
    }
    if (
      result.outcome === 'failed' &&
      result.status !== 'failed' &&
      result.status !== 'timed-out'
    ) {
      throw new Error(
        `Runner for step kind '${step.kind}' returned outcome='failed' with status='${result.status}' (expected 'failed' or 'timed-out'; runId=${run.id} stepId=${step.id})`
      )
    }

    state.status = result.status
    if (result.outcome === 'done' || result.outcome === 'failed') {
      state.finishedAt = this.deps.now()
      if (result.output !== undefined) {
        state.output = result.output
      }
      if (result.error != null) {
        state.error = result.error
      }
      // Why: only merge contextPatch on a deterministic outcome. A
      // `needs-more-time` tick is mid-step; applying a patch then would
      // expose half-built context to subsequent ticks.
      // Why: deep-merge the `steps` sub-object so step N's `steps.<idN>`
      // patch does not clobber step N-1's `steps.<idN-1>`. Other top-level
      // keys still use shallow replace, matching the per-key semantics each
      // runner expects.
      if (result.contextPatch) {
        const prevSteps = (run.context?.steps as Record<string, unknown> | undefined) ?? {}
        const patchSteps = (result.contextPatch.steps as Record<string, unknown> | undefined) ?? {}
        const merged: Record<string, unknown> = {
          ...run.context,
          ...result.contextPatch
        }
        if (result.contextPatch.steps !== undefined) {
          merged.steps = { ...prevSteps, ...patchSteps }
        }
        run.context = merged
      }
    }

    if (result.outcome === 'failed' && step.onFailure === 'halt') {
      run.status = 'failed'
      run.finishedAt = this.deps.now()
      this.deps.persistRun(run)
      return false
    }

    // For `failed` with onFailure='continue', or `done`, fall through and
    // see whether the chain is now complete. If not, the next tick will
    // append the next step's state.
    if (run.stepStates.length >= automation.steps.length && run.stepStates.every(isTerminal)) {
      this.finalizeRun(automation, run)
      this.deps.persistRun(run)
      return false
    }
    this.deps.persistRun(run)
    // Why: when the just-finished step landed terminal AND there's still
    // work in the chain, signal the caller to advance immediately. A
    // `needs-more-time` result returns false so we wait for the next 60s
    // scheduler cadence before polling the runner again.
    return result.outcome === 'done' || result.outcome === 'failed'
  }

  /** Final pass once every step in the automation has a terminal state. A
   *  step that failed-but-was-continued is `failed` in `stepStates` but,
   *  per Phase 1 design, does NOT poison the overall run — the operator's
   *  explicit `onFailure: 'continue'` declares the failure tolerable, so
   *  the run is `completed`. Only failures from halt-config steps or
   *  unhandled timeouts make the run `failed`. */
  private finalizeRun(automation: Automation, run: AutomationRun): void {
    const failingHaltSteps = (run.stepStates ?? []).filter((state, i) => {
      if (state.status === 'succeeded' || state.status === 'skipped') {
        return false
      }
      const step = automation.steps?.[i]
      // No matching step (defensive) or step is halt-on-failure: treat as a
      // contributing failure. `continue` failures are intentionally ignored.
      return !step || step.onFailure !== 'continue'
    })
    run.status = failingHaltSteps.length > 0 ? 'failed' : 'completed'
    run.finishedAt = this.deps.now()
  }
}
