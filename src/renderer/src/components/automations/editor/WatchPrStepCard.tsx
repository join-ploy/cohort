import * as React from 'react'
import type {
  HttpConnection,
  Step,
  StepConfig,
  StepKind,
  StepOrGroup,
  WatchPrConfig
} from '../../../../../shared/automations-types'
import type { Repo, SidebarPromptCommand } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { TemplateInput } from './TemplateInput'
import { StepCardChrome } from './StepCardChrome'
import { ChainStepList } from './ChainStepList'
import {
  STEP_KIND_ORDER,
  defaultConfigForKind,
  getBranchAvailableVariablesAtStep,
  pickDefaultWorktreeRef
} from './chain-editor-modal-state'

export type WatchPrStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  // Threaded through to the embedded branch editor's step cards, which reuse the
  // same routing/config components as the top-level chain.
  repos: Repo[]
  reviewCommands: SidebarPromptCommand[]
  createPrCommands: SidebarPromptCommand[]
  httpConnections: HttpConnection[]
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: WatchPrConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

// v1 forbids nested watch loops, so the branch palette omits 'watch-pr'.
const BRANCH_STEP_KINDS: StepKind[] = STEP_KIND_ORDER.filter((k) => k !== 'watch-pr')

/**
 * Config panel for a `watch-pr` node: the worktree/pane refs, which review
 * events arm a cycle, poll/idle cadences, the halt-on-failed-cycle toggle, and
 * an embedded branch editor (the sub-chain run each review round). The branch
 * reuses ChainStepList; its variable scope adds the watch node's per-cycle
 * payload under `steps.<watch-id>.*` (see buildBranchAvailableAtIndex).
 */
export function WatchPrStepCard(props: WatchPrStepCardProps): React.JSX.Element {
  const config = props.step.config as WatchPrConfig
  const update = (patch: Partial<WatchPrConfig>): void => {
    props.onConfigChange({ ...config, ...patch })
  }
  const updateEvents = (patch: Partial<WatchPrConfig['events']>): void => {
    update({ events: { ...config.events, ...patch } })
  }

  // Stable reference so the branch-scope useCallback below doesn't re-evaluate
  // every render (config.branchSteps ?? [] would mint a new array each time).
  const branchSteps = React.useMemo(() => config.branchSteps ?? [], [config.branchSteps])

  // Branch scope: the parent variables visible at the watch node, plus the
  // watch node's own per-cycle payload (steps.<watch-id>.*) — the review
  // feedback the branch templates against — plus any earlier branch steps'
  // outputs (so a later branch step can reference an earlier one).
  const getBranchAvailableAtIndex = React.useCallback(
    (flatIndex: number): AvailableVariables =>
      getBranchAvailableVariablesAtStep(props.available, props.step.id, branchSteps, flatIndex),
    [branchSteps, props.available, props.step.id]
  )

  const pollInterval = config.pollIntervalSeconds ?? 30
  const idleDebounce = config.agentIdleDebounceSeconds ?? 5

  return (
    <StepCardChrome
      step={props.step}
      stepIndex={props.stepIndex}
      available={props.available}
      disableDrag={props.disableDrag}
      onIdChange={props.onIdChange}
      onConfigChange={props.onConfigChange as (config: StepConfig) => void}
      onOnFailureChange={props.onOnFailureChange}
      onTimeoutChange={props.onTimeoutChange}
      onDelete={props.onDelete}
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Worktree / PR</span>
        <TemplateInput
          value={config.worktreeRef}
          onChange={(v) => update({ worktreeRef: v })}
          placeholder="{{steps.<id>.worktreeId}}"
          available={props.available}
          ariaLabel="Worktree ref"
        />
        {/* startsWith (not includes): a whole-group ref is exactly `group:<id>`,
            whereas a member-scoped ref (`member:group:…`) targets one member and
            isn't batched, so the all-members hint would mislead there. */}
        {config.worktreeRef.startsWith('group:') && (
          <span className="text-muted-foreground text-xs">
            Watches all member PRs; batches responses on the shared pane.
          </span>
        )}
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Supervised pane</span>
        <TemplateInput
          value={config.paneRef}
          onChange={(v) => update({ paneRef: v })}
          placeholder="{{steps.<run-prompt-id>.paneKey}}"
          available={props.available}
          ariaLabel="Pane ref"
        />
      </label>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-xs text-muted-foreground">Respond on</legend>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            aria-label="Changes requested"
            checked={config.events.changesRequested}
            onChange={(e) => updateEvents({ changesRequested: e.target.checked })}
          />
          Changes requested
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            aria-label="New review comments"
            checked={config.events.newReviewComments}
            onChange={(e) => updateEvents({ newReviewComments: e.target.checked })}
          />
          New review comments
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            aria-label="Any review activity"
            checked={config.events.anyReview}
            onChange={(e) => updateEvents({ anyReview: e.target.checked })}
          />
          Any review activity
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Poll interval (s)
          <input
            type="number"
            min={10}
            max={300}
            value={pollInterval}
            onChange={(e) => update({ pollIntervalSeconds: Number(e.target.value) || 30 })}
            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
            aria-label="Poll interval seconds"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Agent idle debounce (s)
          <input
            type="number"
            min={0}
            max={300}
            value={idleDebounce}
            onChange={(e) => update({ agentIdleDebounceSeconds: Number(e.target.value) || 0 })}
            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
            aria-label="Agent idle debounce seconds"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          aria-label="Halt the loop if a response cycle fails"
          checked={config.failedCycleHaltsLoop ?? false}
          onChange={(e) => update({ failedCycleHaltsLoop: e.target.checked })}
        />
        Halt the loop if a response cycle fails
      </label>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          aria-label="End the loop when the PR is approved"
          checked={config.endOnApprove ?? false}
          onChange={(e) => update({ endOnApprove: e.target.checked })}
        />
        End the loop when the PR is approved (group: when all are approved)
      </label>

      <div className="mt-1 rounded-md border border-border bg-muted/20 p-2">
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">
          Branch — runs each review round
        </div>
        <ChainStepList
          steps={branchSteps}
          onStepsChange={(next: StepOrGroup[]) => update({ branchSteps: next })}
          availableStepKinds={BRANCH_STEP_KINDS}
          getAvailableAtIndex={getBranchAvailableAtIndex}
          repos={props.repos}
          reviewCommands={props.reviewCommands}
          createPrCommands={props.createPrCommands}
          httpConnections={props.httpConnections}
          pickDefaultWorktreeRef={pickDefaultWorktreeRef}
          getDefaultConfigForKind={defaultConfigForKind}
          emptyLabel="No branch steps yet. Add the steps that address review feedback."
        />
      </div>
    </StepCardChrome>
  )
}
