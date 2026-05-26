import type {
  Automation,
  AutomationRun,
  Step,
  StepOrGroup,
  StepRunState
} from '../../shared/automations-types'
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

/** Total individual steps across all positions (solo steps count 1, groups
 *  count their length). Used for the safety-bound in `tick()`. */
function countFlatSteps(steps: StepOrGroup[]): number {
  let count = 0
  for (const item of steps) {
    count += Array.isArray(item) ? item.length : 1
  }
  return count
}

/** Map every Step.id to its Step definition so finalizeRun can look up
 *  `onFailure` without relying on positional indexing. */
function buildStepById(steps: StepOrGroup[]): Map<string, Step> {
  const map = new Map<string, Step>()
  for (const item of steps) {
    if (Array.isArray(item)) {
      for (const s of item) {
        map.set(s.id, s)
      }
    } else {
      map.set(item.id, item)
    }
  }
  return map
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
    const maxIterations = countFlatSteps(automation.steps) * 2 + 1
    for (let i = 0; i < maxIterations; i++) {
      const keepGoing = await this.tickOnce(automation, run)
      if (!keepGoing) {
        return
      }
    }
  }

  /** Drives one runner.tick() invocation (or one parallel-group tick) and
   *  persists the result. Returns `true` when the caller should immediately
   *  try again (a position just landed terminal and there's more work to do)
   *  and `false` when we should wait for the next scheduler cadence
   *  (needs-more-time, halt failure, or run finalized). */
  private async tickOnce(automation: Automation, run: AutomationRun): Promise<boolean> {
    const steps = automation.steps
    if (!steps || steps.length === 0) {
      return false
    }

    if (!run.stepStates) {
      run.stepStates = []
    }

    // Walk the StepOrGroup[] array to find the current position. Each
    // position consumes 1 (solo step) or N (parallel group) stepState slots.
    let consumed = 0
    let posIdx = 0
    for (; posIdx < steps.length; posIdx++) {
      const item = steps[posIdx]
      const slotCount = Array.isArray(item) ? item.length : 1
      const slotStates = run.stepStates.slice(consumed, consumed + slotCount)

      if (slotStates.length < slotCount || slotStates.some((s) => !isTerminal(s))) {
        // This position is either not yet started or still in progress.
        break
      }
      consumed += slotCount
    }

    if (posIdx >= steps.length) {
      // All positions consumed — finalize if not already done.
      if (run.stepStates.length > 0 && run.stepStates.every(isTerminal)) {
        this.finalizeRun(automation, run)
      }
      this.deps.persistRun(run)
      return false
    }

    const item = steps[posIdx]

    // ── Solo step (existing behaviour) ──────────────────────────────
    if (!Array.isArray(item)) {
      return this.tickSoloStep(item, run, automation, steps, consumed)
    }

    // ── Parallel group ──────────────────────────────────────────────
    return this.tickParallelGroup(item, run, automation, steps, consumed)
  }

  /** Tick a single (non-grouped) step. Preserves the original chain
   *  semantics exactly. */
  private async tickSoloStep(
    step: Step,
    run: AutomationRun,
    automation: Automation,
    steps: StepOrGroup[],
    consumed: number
  ): Promise<boolean> {
    let state: StepRunState
    if (run.stepStates!.length <= consumed) {
      state = makeStepState(step, this.deps.now())
      run.stepStates!.push(state)
    } else {
      state = run.stepStates![consumed]
    }

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

    this.validateResult(result, step, run)

    state.status = result.status
    if (result.outcome === 'done' || result.outcome === 'failed') {
      state.finishedAt = this.deps.now()
      if (result.output !== undefined) {
        state.output = result.output
      }
      if (result.error != null) {
        state.error = result.error
      }
      this.applyContextPatch(run, result.contextPatch)
    }

    if (result.outcome === 'failed' && step.onFailure === 'halt') {
      run.status = 'failed'
      run.finishedAt = this.deps.now()
      this.deps.persistRun(run)
      return false
    }

    const totalFlat = countFlatSteps(steps)
    if (run.stepStates!.length >= totalFlat && run.stepStates!.every(isTerminal)) {
      this.finalizeRun(automation, run)
      this.deps.persistRun(run)
      return false
    }
    // Propagate step-level 'waiting' to the run so the UI can reflect it.
    const anyWaiting = run.stepStates!.some((s) => s.status === 'waiting')
    if (anyWaiting) {
      run.status = 'waiting'
    } else if (run.status === 'waiting') {
      run.status = 'running'
    }

    this.deps.persistRun(run)
    return result.outcome === 'done' || result.outcome === 'failed'
  }

  /** Tick every non-terminal sibling in a parallel group. Waits for all to
   *  finish before allowing the chain to advance. */
  private async tickParallelGroup(
    group: Step[],
    run: AutomationRun,
    automation: Automation,
    steps: StepOrGroup[],
    consumed: number
  ): Promise<boolean> {
    // Materialise step states for the group if they don't exist yet.
    for (let i = 0; i < group.length; i++) {
      if (run.stepStates!.length <= consumed + i) {
        run.stepStates!.push(makeStepState(group[i], this.deps.now()))
      }
    }

    const groupStates = run.stepStates!.slice(consumed, consumed + group.length)

    // Tick every non-terminal sibling concurrently.
    let anyAdvanced = false
    await Promise.all(
      group.map(async (step, i) => {
        const state = groupStates[i]
        if (isTerminal(state)) {
          return
        }

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

        this.validateResult(result, step, run)

        state.status = result.status
        if (result.outcome === 'done' || result.outcome === 'failed') {
          state.finishedAt = this.deps.now()
          if (result.output !== undefined) {
            state.output = result.output
          }
          if (result.error != null) {
            state.error = result.error
          }
          this.applyContextPatch(run, result.contextPatch)
          anyAdvanced = true
        }
      })
    )

    // If any sibling is still running, wait for the next cadence.
    if (!groupStates.every(isTerminal)) {
      // Propagate step-level 'waiting' to the run so the UI can reflect it.
      const anyWaiting = run.stepStates!.some((s) => s.status === 'waiting')
      if (anyWaiting) {
        run.status = 'waiting'
      } else if (run.status === 'waiting') {
        run.status = 'running'
      }

      this.deps.persistRun(run)
      return false
    }

    // All siblings finished — check halt policy. If any halt-policy step
    // failed, the run halts after all siblings complete.
    const stepById = buildStepById(steps)
    const haltFailure = groupStates.some((s) => {
      if (s.status === 'succeeded' || s.status === 'skipped') {
        return false
      }
      const step = stepById.get(s.stepId)
      return !step || step.onFailure !== 'continue'
    })

    if (haltFailure) {
      run.status = 'failed'
      run.finishedAt = this.deps.now()
      this.deps.persistRun(run)
      return false
    }

    // Group done, no halt — check if the entire chain is now complete.
    const totalFlat = countFlatSteps(steps)
    if (run.stepStates!.length >= totalFlat && run.stepStates!.every(isTerminal)) {
      this.finalizeRun(automation, run)
      this.deps.persistRun(run)
      return false
    }

    this.deps.persistRun(run)
    return anyAdvanced
  }

  /** Validate a runner result's outcome/status consistency. */
  private validateResult(
    result: { outcome: string; status: string },
    step: Step,
    run: AutomationRun
  ): void {
    if (result.outcome === 'done' && !isTerminal({ status: result.status } as StepRunState)) {
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
  }

  /** Deep-merge a contextPatch into run.context, preserving per-step keys
   *  under the `steps` sub-object. */
  private applyContextPatch(
    run: AutomationRun,
    contextPatch: Record<string, unknown> | undefined
  ): void {
    if (!contextPatch) {
      return
    }
    const prevSteps = (run.context?.steps as Record<string, unknown> | undefined) ?? {}
    const patchSteps = (contextPatch.steps as Record<string, unknown> | undefined) ?? {}
    const merged: Record<string, unknown> = {
      ...run.context,
      ...contextPatch
    }
    if (contextPatch.steps !== undefined) {
      merged.steps = { ...prevSteps, ...patchSteps }
    }
    run.context = merged
  }

  /** Final pass once every step in the automation has a terminal state. A
   *  step that failed-but-was-continued is `failed` in `stepStates` but,
   *  per Phase 1 design, does NOT poison the overall run — the operator's
   *  explicit `onFailure: 'continue'` declares the failure tolerable, so
   *  the run is `completed`. Only failures from halt-config steps or
   *  unhandled timeouts make the run `failed`. */
  private finalizeRun(automation: Automation, run: AutomationRun): void {
    const stepById = buildStepById(automation.steps ?? [])
    const failingHaltSteps = (run.stepStates ?? []).filter((state) => {
      if (state.status === 'succeeded' || state.status === 'skipped') {
        return false
      }
      const step = stepById.get(state.stepId)
      // No matching step (defensive) or step is halt-on-failure: treat as a
      // contributing failure. `continue` failures are intentionally ignored.
      return !step || step.onFailure !== 'continue'
    })
    run.status = failingHaltSteps.length > 0 ? 'failed' : 'completed'
    run.finishedAt = this.deps.now()
  }
}
