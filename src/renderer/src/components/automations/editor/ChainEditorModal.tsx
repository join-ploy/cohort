import * as React from 'react'
import { Play, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// Why: the editor renders as a fullscreen overlay covering the native macOS
// traffic lights. Reserve the same 80px pad used by .titlebar-left so the
// close/minimize/expand buttons don't sit on top of the header controls.
const isMac =
  typeof navigator !== 'undefined' &&
  typeof navigator.userAgent === 'string' &&
  navigator.userAgent.includes('Mac')
import type {
  Automation,
  AutoTrigger,
  HttpConnection,
  RunNowPayload,
  StepOrGroup,
  TriggerConfig
} from '../../../../../shared/automations-types'
import type { Repo, SidebarPromptCommand } from '../../../../../shared/types'
import { type ChainDraft, flattenSteps } from '../../../lib/chain-editor-state'
import {
  chainHasStep,
  computeAllErrors,
  createBlankAutomation,
  defaultConfigForKind,
  getAvailableVariablesAtStep,
  isProjectRequired,
  LEGACY_AUTOMATION_FIELDS,
  pickDefaultWorktreeRef,
  seedDraft,
  STEP_KIND_ORDER,
  type ChainEditorError
} from './chain-editor-modal-state'
import { AvailableVariablesPanel } from './AvailableVariablesPanel'
import { ChainStepList } from './ChainStepList'
import { RunNowConfirmModal } from './RunNowConfirmModal'
import { automationNeedsRunNowPayload } from './run-now-payload-gate'
import { TriggerPill } from './TriggerPill'
import { TriggersModal } from './TriggersModal'

export type ChainEditorModalProps = {
  open: boolean
  automation: Automation | null
  repos: Repo[]
  reviewCommands: SidebarPromptCommand[]
  createPrCommands: SidebarPromptCommand[]
  httpConnections: HttpConnection[]
  onClose: () => void
  onSave: (automation: Automation) => Promise<void>
  onRunNow?: (automationId: string, payload?: RunNowPayload) => void | Promise<void>
}

export function ChainEditorModal(props: ChainEditorModalProps): React.JSX.Element | null {
  if (!props.open) {
    return null
  }
  return <ChainEditorModalBody {...props} />
}

/**
 * Body component mounted only while open=true so internal state is freshly
 * seeded each time the modal opens.
 */
function ChainEditorModalBody(props: ChainEditorModalProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<ChainDraft>(() => seedDraft(props.automation))
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [runConfirmOpen, setRunConfirmOpen] = React.useState(false)
  const [triggersModalOpen, setTriggersModalOpen] = React.useState(false)

  const availableStepKinds = STEP_KIND_ORDER

  // Why: project-required gating now lives inside computeAllErrors so it can
  // factor in chain shape (e.g. a create-workspace-group chain genuinely
  // doesn't need an upfront projectId — see chain-editor-modal-state).
  const errors = React.useMemo<ChainEditorError[]>(
    () => computeAllErrors(draft, props.repos, props.httpConnections),
    [draft, props.repos, props.httpConnections]
  )

  const updateDraft = React.useCallback((patch: Partial<ChainDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setDirty(true)
  }, [])

  // ChainStepList owns all step mutations as pure transforms; the modal just
  // commits the new array and marks the draft dirty. dirty stays unconditional
  // so even a same-shape reorder enables Save — the persisted order must match
  // what the user sees, and computeAllErrors re-validates future references.
  const setStepsAndDirty = React.useCallback((next: StepOrGroup[]) => {
    setDraft((current) => ({ ...current, steps: next }))
    setDirty(true)
  }, [])

  const handleCancel = React.useCallback(() => {
    if (dirty && !confirm('Discard changes?')) {
      return
    }
    props.onClose()
  }, [dirty, props])

  const handleSave = React.useCallback(async () => {
    if (errors.length > 0 || !dirty || saving) {
      return
    }
    setSaving(true)
    try {
      const now = Date.now()
      const base: Automation = props.automation ?? createBlankAutomation(draft.id || '', now)
      const next: Automation = {
        ...base,
        id: draft.id || base.id,
        name: draft.name,
        projectId: draft.projectId,
        enabled: draft.enabled,
        trigger: draft.trigger,
        steps: draft.steps,
        autoTriggers: draft.autoTriggers,
        updatedAt: now,
        createdAt: base.createdAt || now
      }
      if (props.automation) {
        // Why: dormant legacy fields aren't editable in v2 but must round-trip
        // unchanged so we don't regress scheduled rows.
        for (const key of LEGACY_AUTOMATION_FIELDS) {
          ;(next as Record<string, unknown>)[key] = (props.automation as Record<string, unknown>)[
            key
          ]
        }
      }
      await props.onSave(next)
      setSaving(false)
      props.onClose()
    } catch {
      // Parent is expected to surface the error (toast/inline) via onSave's
      // rejection. Keep the modal open so the user can correct and retry.
      setSaving(false)
    }
  }, [draft, errors.length, dirty, saving, props])

  const availableAtEnd = React.useMemo(
    () => getAvailableVariablesAtStep(draft, flattenSteps(draft.steps).length, props.repos),
    [draft, props.repos]
  )

  const getAvailableAtIndex = React.useCallback(
    (flatIndex: number) => getAvailableVariablesAtStep(draft, flatIndex, props.repos),
    [draft, props.repos]
  )

  const canSave = errors.length === 0 && dirty && !saving
  const canRunNow = props.automation !== null && !dirty
  const issueCount = errors.length

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit automation chain"
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
    >
      <ChainEditorHeader
        name={draft.name}
        projectId={draft.projectId}
        repos={props.repos}
        enabled={draft.enabled}
        trigger={draft.trigger}
        autoTriggers={draft.autoTriggers}
        canRunNow={canRunNow}
        projectOptional={!isProjectRequired(draft)}
        onNameChange={(name) => updateDraft({ name })}
        onProjectChange={(projectId) => updateDraft({ projectId })}
        onEnabledChange={(enabled) => updateDraft({ enabled })}
        onOpenTriggers={() => setTriggersModalOpen(true)}
        onRunNow={() => {
          if (!props.automation || !props.onRunNow) {
            return
          }
          // Why: when the run needs extra inputs (Linear ticket, picked project, or
          // a manual http item), defer to the confirm modal so the operator can
          // supply them. Otherwise dispatch directly.
          if (automationNeedsRunNowPayload(draft)) {
            setRunConfirmOpen(true)
          } else {
            void props.onRunNow(props.automation.id)
          }
        }}
        onClose={handleCancel}
      />

      {props.automation && props.onRunNow ? (
        <RunNowConfirmModal
          open={runConfirmOpen}
          automation={props.automation}
          onClose={() => setRunConfirmOpen(false)}
          onRun={async (payload) => {
            await props.onRunNow?.(props.automation!.id, payload)
          }}
        />
      ) : null}

      <TriggersModal
        open={triggersModalOpen}
        automationId={props.automation?.id ?? ''}
        trigger={draft.trigger}
        autoTriggers={draft.autoTriggers}
        chainProvidesProject={chainHasStep(draft, 'create-workspace-group')}
        onSave={(next) => {
          updateDraft({ trigger: next.trigger, autoTriggers: next.autoTriggers })
          setTriggersModalOpen(false)
        }}
        onCancel={() => setTriggersModalOpen(false)}
      />

      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4"
        style={{
          backgroundColor: 'var(--background)',
          backgroundImage:
            'linear-gradient(color-mix(in srgb, var(--border) 18%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 18%, transparent) 1px, transparent 1px)',
          backgroundSize: '24px 24px'
        }}
      >
        <div className="mx-auto flex w-full max-w-7xl flex-col">
          <ChainStepList
            steps={draft.steps}
            onStepsChange={setStepsAndDirty}
            availableStepKinds={availableStepKinds}
            getAvailableAtIndex={getAvailableAtIndex}
            repos={props.repos}
            reviewCommands={props.reviewCommands}
            createPrCommands={props.createPrCommands}
            httpConnections={props.httpConnections}
            pickDefaultWorktreeRef={pickDefaultWorktreeRef}
            getDefaultConfigForKind={defaultConfigForKind}
          />

          <AvailableVariablesPanel available={availableAtEnd} className="mt-2" />
        </div>
      </div>

      <ChainEditorFooter
        issueCount={issueCount}
        saving={saving}
        canSave={canSave}
        onCancel={handleCancel}
        onSave={() => void handleSave()}
      />
    </div>
  )
}

type ChainEditorHeaderProps = {
  name: string
  projectId: string
  repos: Repo[]
  enabled: boolean
  trigger: TriggerConfig
  autoTriggers: AutoTrigger[]
  canRunNow: boolean
  /** True when the chain doesn't consume `automation.projectId` (e.g. a
   *  group-target chain with no create-worktree step). Drives the placeholder
   *  copy so the operator isn't told to pick a project they don't need. */
  projectOptional: boolean
  onNameChange: (name: string) => void
  onProjectChange: (projectId: string) => void
  onEnabledChange: (enabled: boolean) => void
  onOpenTriggers: () => void
  onRunNow: () => void
  onClose: () => void
}

function ChainEditorHeader(props: ChainEditorHeaderProps): React.JSX.Element {
  // Why: when the trigger picks a project at Run Now time the upfront Project
  // select would be redundant — and worse, misleading, since whatever the user
  // chose here is ignored at dispatch. Hide it in that mode.
  const picksProjectAtRunTime = props.trigger.acceptsProjectSelection === true
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3">
      {isMac ? <div className="titlebar-traffic-light-pad" /> : null}
      <input
        aria-label="Automation name"
        type="text"
        value={props.name}
        onChange={(e) => props.onNameChange(e.target.value)}
        placeholder="Untitled automation"
        className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-base font-semibold outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
      />
      {picksProjectAtRunTime ? null : (
        <select
          aria-label="Project"
          value={props.projectId}
          onChange={(e) => props.onProjectChange(e.target.value)}
          className="min-w-[10rem] rounded-md border border-input bg-background px-2 py-2 text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
        >
          <option value="">
            {props.projectOptional ? 'No project (group)' : 'Pick a project…'}
          </option>
          {props.repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName}
            </option>
          ))}
        </select>
      )}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          aria-label="Enabled"
          type="checkbox"
          checked={props.enabled}
          onChange={(e) => props.onEnabledChange(e.target.checked)}
        />
        Enabled
      </label>
      <TriggerPill
        trigger={props.trigger}
        autoTriggers={props.autoTriggers}
        onOpenTriggers={props.onOpenTriggers}
      />
      <Button
        variant="outline"
        size="sm"
        aria-label="Run Now"
        disabled={!props.canRunNow}
        title={!props.canRunNow ? 'Save changes first to run.' : undefined}
        onClick={props.onRunNow}
      >
        <Play className="size-3.5" />
        Run Now
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Close editor" onClick={props.onClose}>
        <X className="size-4" />
      </Button>
    </div>
  )
}

type ChainEditorFooterProps = {
  issueCount: number
  saving: boolean
  canSave: boolean
  onCancel: () => void
  onSave: () => void
}

function ChainEditorFooter(props: ChainEditorFooterProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-3">
      <div
        aria-label="Issue count"
        className={cn(
          'text-xs',
          props.issueCount === 0 ? 'text-muted-foreground' : 'text-rose-500'
        )}
      >
        {props.issueCount} {props.issueCount === 1 ? 'issue' : 'issues'}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!props.canSave} onClick={props.onSave}>
          {props.saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
