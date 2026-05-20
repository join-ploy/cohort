import * as React from 'react'
import { Plus, Play, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type {
  Automation,
  Step,
  StepConfig,
  StepKind
} from '../../../../../shared/automations-types'
import type { Repo, SidebarPromptCommand } from '../../../../../shared/types'
import {
  type ChainDraft,
  generateDefaultStepId,
  renameStepWithRewrites
} from '../../../lib/chain-editor-state'
import {
  computeAllErrors,
  createBlankAutomation,
  defaultConfigForKind,
  getAvailableVariablesAtStep,
  LEGACY_AUTOMATION_FIELDS,
  seedDraft,
  STEP_KIND_LABELS,
  STEP_KIND_ORDER,
  type ChainEditorError
} from './chain-editor-modal-state'
import { AvailableVariablesPanel } from './AvailableVariablesPanel'
import { ChainEditorStepCardRouter } from './ChainEditorStepCardRouter'

export type ChainEditorModalProps = {
  open: boolean
  automation: Automation | null
  repos: Repo[]
  reviewCommands: SidebarPromptCommand[]
  createPrCommands: SidebarPromptCommand[]
  onClose: () => void
  onSave: (automation: Automation) => Promise<void>
  onRunNow?: (automationId: string) => void
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
  const [addOpen, setAddOpen] = React.useState(false)

  const errors = React.useMemo<ChainEditorError[]>(() => {
    const base = computeAllErrors(draft)
    if (!draft.projectId) {
      // Why: project is required to dispatch — surface the missing selection as
      // a top-level error so Save is disabled until the user picks a project.
      base.push({
        path: 'projectId',
        code: 'unknown-path',
        message: 'Project is required',
        stepId: '',
        field: 'projectId'
      })
    }
    return base
  }, [draft])

  const updateDraft = React.useCallback((patch: Partial<ChainDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setDirty(true)
  }, [])

  const updateStep = React.useCallback((index: number, patch: Partial<Step>) => {
    setDraft((current) => {
      const nextSteps = current.steps.slice()
      nextSteps[index] = { ...nextSteps[index], ...patch }
      return { ...current, steps: nextSteps }
    })
    setDirty(true)
  }, [])

  const updateStepConfig = React.useCallback(
    (index: number, config: StepConfig) => {
      updateStep(index, { config })
    },
    [updateStep]
  )

  const renameStep = React.useCallback((index: number, newId: string) => {
    setDraft((current) => {
      const oldId = current.steps[index]?.id
      if (!oldId) {
        return current
      }
      try {
        const nextSteps = renameStepWithRewrites(current.steps, oldId, newId)
        return { ...current, steps: nextSteps }
      } catch {
        // Why: StepCardChrome only commits when isValidStepId passes, so the
        // only path here is a collision with another step id. Drop the rename
        // silently — the chrome will snap back to the previous id.
        return current
      }
    })
    setDirty(true)
  }, [])

  const deleteStep = React.useCallback((index: number) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.filter((_, i) => i !== index)
    }))
    setDirty(true)
  }, [])

  const addStep = React.useCallback((kind: StepKind) => {
    setDraft((current) => {
      const newStep: Step = {
        id: generateDefaultStepId(kind, current.steps),
        kind,
        config: defaultConfigForKind(kind),
        onFailure: 'halt',
        timeoutSeconds: null
      }
      return { ...current, steps: [...current.steps, newStep] }
    })
    setDirty(true)
    setAddOpen(false)
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
    () => getAvailableVariablesAtStep(draft, draft.steps.length),
    [draft]
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
        canRunNow={canRunNow}
        onNameChange={(name) => updateDraft({ name })}
        onProjectChange={(projectId) => updateDraft({ projectId })}
        onEnabledChange={(enabled) => updateDraft({ enabled })}
        onRunNow={() => {
          if (props.automation && props.onRunNow) {
            props.onRunNow(props.automation.id)
          }
        }}
        onClose={handleCancel}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {draft.steps.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
              No steps yet. Click &ldquo;Add step&rdquo; to start your chain.
            </div>
          ) : null}
          {draft.steps.map((step, index) => (
            <ChainEditorStepCardRouter
              key={`${step.id}:${index}`}
              step={step}
              index={index}
              available={getAvailableVariablesAtStep(draft, index)}
              reviewCommands={props.reviewCommands}
              createPrCommands={props.createPrCommands}
              onIdChange={(newId) => renameStep(index, newId)}
              onConfigChange={(config) => updateStepConfig(index, config)}
              onOnFailureChange={(val) => updateStep(index, { onFailure: val })}
              onTimeoutChange={(val) => updateStep(index, { timeoutSeconds: val })}
              onDelete={() => deleteStep(index)}
            />
          ))}

          <AddStepControl open={addOpen} onToggle={setAddOpen} onPick={addStep} />

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
  canRunNow: boolean
  onNameChange: (name: string) => void
  onProjectChange: (projectId: string) => void
  onEnabledChange: (enabled: boolean) => void
  onRunNow: () => void
  onClose: () => void
}

function ChainEditorHeader(props: ChainEditorHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3">
      <input
        aria-label="Automation name"
        type="text"
        value={props.name}
        onChange={(e) => props.onNameChange(e.target.value)}
        placeholder="Untitled automation"
        className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-base font-semibold outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
      />
      <select
        aria-label="Project"
        value={props.projectId}
        onChange={(e) => props.onProjectChange(e.target.value)}
        className="min-w-[10rem] rounded-md border border-input bg-background px-2 py-2 text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
      >
        <option value="">Pick a project…</option>
        {props.repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.displayName}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          aria-label="Enabled"
          type="checkbox"
          checked={props.enabled}
          onChange={(e) => props.onEnabledChange(e.target.checked)}
        />
        Enabled
      </label>
      <span
        aria-label="Trigger"
        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      >
        Trigger: Manual
      </span>
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

type AddStepControlProps = {
  open: boolean
  onToggle: (next: boolean) => void
  onPick: (kind: StepKind) => void
}

function AddStepControl(props: AddStepControlProps): React.JSX.Element {
  return (
    <div className="relative flex justify-center py-2">
      <Button
        variant="outline"
        size="sm"
        aria-label="Add step"
        aria-expanded={props.open}
        onClick={() => props.onToggle(!props.open)}
      >
        <Plus className="size-3.5" />
        Add step
      </Button>
      {props.open ? (
        <div
          role="menu"
          aria-label="Step kinds"
          className="absolute top-full z-10 mt-1 flex flex-col rounded-md border border-border bg-background shadow-md"
        >
          {STEP_KIND_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => props.onPick(kind)}
              className="px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-foreground"
            >
              {STEP_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
