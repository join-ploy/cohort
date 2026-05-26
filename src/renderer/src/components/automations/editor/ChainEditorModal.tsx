import * as React from 'react'
import { Plus, Play, X, GripVertical, ArrowUpFromLine } from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'

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
  RunNowPayload,
  Step,
  StepConfig,
  StepKind,
  StepOrGroup,
  TriggerConfig,
  TriggerSourceId
} from '../../../../../shared/automations-types'
import type { Repo, SidebarPromptCommand } from '../../../../../shared/types'
import {
  type ChainDraft,
  flattenSteps,
  generateDefaultStepId,
  groupStepAt,
  renameStepWithRewrites,
  reorderSteps,
  ungroupStep
} from '../../../lib/chain-editor-state'
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
  STEP_KIND_LABELS,
  STEP_KIND_ORDER,
  type ChainEditorError
} from './chain-editor-modal-state'
import { AvailableVariablesPanel } from './AvailableVariablesPanel'
import { ChainEditorStepCardRouter } from './ChainEditorStepCardRouter'
import { RunNowConfirmModal } from './RunNowConfirmModal'
import { TriggerPill } from './TriggerPill'
import { TriggersModal } from './TriggersModal'

// Why: Phase 13 will replace this with an IPC call to the source registry.
// For now ChainEditorModal hardcodes the only registered source.
const AVAILABLE_TRIGGER_SOURCES: { id: TriggerSourceId; label: string }[] = [
  { id: 'linear-issue', label: 'Linear issue' }
]

export type ChainEditorModalProps = {
  open: boolean
  automation: Automation | null
  repos: Repo[]
  reviewCommands: SidebarPromptCommand[]
  createPrCommands: SidebarPromptCommand[]
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
  const [addOpen, setAddOpen] = React.useState(false)
  const [runConfirmOpen, setRunConfirmOpen] = React.useState(false)
  const [triggersModalOpen, setTriggersModalOpen] = React.useState(false)

  // Why: hide the `create-workspace-group` step from the picker when the
  // experimental flag is off so the rest of the chain editor matches the
  // pre-feature surface exactly.
  const groupedEnabled = useAppStore((s) => s.settings?.experimentalGroupedWorkspaces === true)
  const availableStepKinds = React.useMemo<StepKind[]>(
    () =>
      groupedEnabled
        ? STEP_KIND_ORDER
        : STEP_KIND_ORDER.filter((k) => k !== 'create-workspace-group'),
    [groupedEnabled]
  )

  // Why: project-required gating now lives inside computeAllErrors so it can
  // factor in chain shape (e.g. a create-workspace-group chain genuinely
  // doesn't need an upfront projectId — see chain-editor-modal-state).
  const errors = React.useMemo<ChainEditorError[]>(
    () => computeAllErrors(draft, props.repos),
    [draft, props.repos]
  )

  const updateDraft = React.useCallback((patch: Partial<ChainDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setDirty(true)
  }, [])

  const updateStep = React.useCallback((stepId: string, patch: Partial<Step>) => {
    setDraft((current) => {
      const nextSteps = current.steps.map((item) => {
        if (Array.isArray(item)) {
          return item.map((s) => (s.id === stepId ? { ...s, ...patch } : s))
        }
        return item.id === stepId ? { ...item, ...patch } : item
      })
      return { ...current, steps: nextSteps }
    })
    setDirty(true)
  }, [])

  const updateStepConfig = React.useCallback(
    (stepId: string, config: StepConfig) => {
      updateStep(stepId, { config })
    },
    [updateStep]
  )

  const renameStep = React.useCallback((oldId: string, newId: string) => {
    setDraft((current) => {
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

  const deleteStep = React.useCallback((stepId: string) => {
    setDraft((current) => {
      const nextSteps: StepOrGroup[] = []
      for (const item of current.steps) {
        if (Array.isArray(item)) {
          const remaining = item.filter((s) => s.id !== stepId)
          if (remaining.length === 0) {
            continue
          }
          if (remaining.length === 1) {
            nextSteps.push(remaining[0])
          } else {
            nextSteps.push(remaining)
          }
        } else if (item.id !== stepId) {
          nextSteps.push(item)
        }
      }
      return { ...current, steps: nextSteps }
    })
    setDirty(true)
  }, [])

  const moveStep = React.useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) {
      return
    }
    setDraft((current) => {
      if (
        fromIndex < 0 ||
        fromIndex >= current.steps.length ||
        toIndex < 0 ||
        toIndex >= current.steps.length
      ) {
        return current
      }
      return { ...current, steps: reorderSteps(current.steps, fromIndex, toIndex) }
    })
    // Why: dirty stays unconditional so any reorder enables the save button —
    // even a same-shape move that the executor would treat as a no-op should
    // require an explicit save so the persisted order matches what the user
    // sees. Future-reference validation re-runs via computeAllErrors's useMemo
    // and will surface any newly-invalid {{steps.x}} reference produced by the
    // reorder, instead of silently accepting an unrunnable chain.
    setDirty(true)
  }, [])

  const addStep = React.useCallback((kind: StepKind) => {
    setDraft((current) => {
      const config = defaultConfigForKind(kind)
      // Why: if this new step has a worktreeRef slot AND there's a prior
      // create-worktree / create-workspace-group step in the chain, prefill
      // the ref with that step's output. Saves the user from retyping the
      // same {{steps.<id>.worktreeId}} / {{steps.<id>.groupId}} template
      // every time they add a run-prompt / wait-for-setup / run-command.
      if ('worktreeRef' in config && (config as { worktreeRef: string }).worktreeRef === '') {
        const ref = pickDefaultWorktreeRef(current.steps)
        if (ref) {
          ;(config as { worktreeRef: string }).worktreeRef = ref
        }
      }
      const newStep: Step = {
        id: generateDefaultStepId(kind, current.steps),
        kind,
        config,
        onFailure: 'halt',
        timeoutSeconds: null
      }
      return { ...current, steps: [...current.steps, newStep] }
    })
    setDirty(true)
    setAddOpen(false)
  }, [])

  const [parallelAddOpen, setParallelAddOpen] = React.useState<number | null>(null)

  const addParallelStep = React.useCallback((topIndex: number, kind: StepKind) => {
    setDraft((current) => {
      const config = defaultConfigForKind(kind)
      if ('worktreeRef' in config && (config as { worktreeRef: string }).worktreeRef === '') {
        const ref = pickDefaultWorktreeRef(current.steps)
        if (ref) {
          ;(config as { worktreeRef: string }).worktreeRef = ref
        }
      }
      const newStep: Step = {
        id: generateDefaultStepId(kind, current.steps),
        kind,
        config,
        onFailure: 'halt',
        timeoutSeconds: null
      }
      return { ...current, steps: groupStepAt(current.steps, topIndex, newStep) }
    })
    setDirty(true)
    setParallelAddOpen(null)
  }, [])

  // Why: extracts a step from a parallel group and inserts it right after
  // the group's top-level position. If only one sibling remains,
  // ungroupStep auto-unwraps the group to a solo step.
  const extractFromGroup = React.useCallback((groupIndex: number, innerIndex: number) => {
    setDraft((current) => {
      const group = current.steps[groupIndex]
      if (!Array.isArray(group)) {
        return current
      }
      const step = group[innerIndex]
      if (!step) {
        return current
      }
      const afterUngroup = ungroupStep(current.steps, groupIndex, innerIndex)
      const insertAt = groupIndex + 1
      const nextSteps = [...afterUngroup.slice(0, insertAt), step, ...afterUngroup.slice(insertAt)]
      return { ...current, steps: nextSteps }
    })
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

  // Why: 5px activation distance matches TabBar's PointerSensor so a click on
  // the grip without movement still falls through to focus/native behaviour.
  // KeyboardSensor is added here (TabBar omits it) because automation editing
  // is keyboard-heavy — arrow keys on a focused grip reorder a step. Both
  // sensors are passed even when the chain has zero steps so the hook order
  // remains stable across renders.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const topLevelIds = React.useMemo(
    () =>
      draft.steps.map((item) =>
        Array.isArray(item) ? `group-${item.map((s) => s.id).join('+')}` : item.id
      ),
    [draft.steps]
  )

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) {
        return
      }
      const fromIndex = topLevelIds.indexOf(String(active.id))
      const toIndex = topLevelIds.indexOf(String(over.id))
      if (fromIndex === -1 || toIndex === -1) {
        return
      }
      moveStep(fromIndex, toIndex)
    },
    [topLevelIds, moveStep]
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
          // Why: when the trigger requires extra inputs (Linear ticket or
          // worktree), defer to the confirm modal so the operator can supply
          // them. Otherwise dispatch directly.
          const needsPayload =
            !!draft.trigger?.acceptsLinearTicket || !!draft.trigger?.acceptsProjectSelection
          if (needsPayload) {
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
        availableSources={AVAILABLE_TRIGGER_SOURCES}
        chainProvidesProject={chainHasStep(draft, 'create-workspace-group')}
        onSave={(next) => {
          updateDraft({ trigger: next.trigger, autoTriggers: next.autoTriggers })
          setTriggersModalOpen(false)
        }}
        onCancel={() => setTriggersModalOpen(false)}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {draft.steps.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
              No steps yet. Click &ldquo;Add step&rdquo; to start your chain.
            </div>
          ) : null}
          {/* Why: DndContext wraps only the steps list so dnd-kit's pointer
              listeners don't interfere with the header/footer controls. The
              outer scroll container is the editor body div above, which
              DndContext.autoScroll discovers automatically and scrolls while
              the user drags near its edges. */}
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <SortableContext items={topLevelIds} strategy={verticalListSortingStrategy}>
              {draft.steps.map((item, topIndex) => {
                if (Array.isArray(item)) {
                  const groupId = `group-${item.map((s) => s.id).join('+')}`
                  return (
                    <div key={groupId}>
                      {topIndex > 0 && <StepConnector />}
                      <ParallelGroupContainer groupId={groupId}>
                        {item.map((step, innerIndex) => {
                          const flatIndex = computeFlatIndex(draft.steps, topIndex, innerIndex)
                          return (
                            <div key={step.id} className="relative min-w-[280px] flex-1">
                              {item.length > 1 && (
                                <button
                                  type="button"
                                  aria-label="Move out of parallel group"
                                  onClick={() => extractFromGroup(topIndex, innerIndex)}
                                  className="absolute -top-2 right-2 z-10 rounded-full border border-border bg-background p-0.5 text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
                                >
                                  <ArrowUpFromLine className="size-3" />
                                </button>
                              )}
                              <ChainEditorStepCardRouter
                                step={step}
                                index={flatIndex}
                                disableDrag
                                available={getAvailableVariablesAtStep(
                                  draft,
                                  flatIndex,
                                  props.repos
                                )}
                                repos={props.repos}
                                reviewCommands={props.reviewCommands}
                                createPrCommands={props.createPrCommands}
                                onIdChange={(newId) => renameStep(step.id, newId)}
                                onConfigChange={(config) => updateStepConfig(step.id, config)}
                                onOnFailureChange={(val) => updateStep(step.id, { onFailure: val })}
                                onTimeoutChange={(val) =>
                                  updateStep(step.id, { timeoutSeconds: val })
                                }
                                onDelete={() => deleteStep(step.id)}
                              />
                            </div>
                          )
                        })}
                        <AddParallelButton
                          open={parallelAddOpen === topIndex}
                          kinds={availableStepKinds}
                          onToggle={() =>
                            setParallelAddOpen(parallelAddOpen === topIndex ? null : topIndex)
                          }
                          onPick={(kind) => addParallelStep(topIndex, kind)}
                        />
                      </ParallelGroupContainer>
                    </div>
                  )
                }
                const flatIndex = computeFlatIndex(draft.steps, topIndex, 0)
                return (
                  <div key={item.id}>
                    {topIndex > 0 && <StepConnector />}
                    <div className="flex items-stretch gap-2">
                      <div className="flex-1">
                        <ChainEditorStepCardRouter
                          step={item}
                          index={flatIndex}
                          available={getAvailableVariablesAtStep(draft, flatIndex, props.repos)}
                          repos={props.repos}
                          reviewCommands={props.reviewCommands}
                          createPrCommands={props.createPrCommands}
                          onIdChange={(newId) => renameStep(item.id, newId)}
                          onConfigChange={(config) => updateStepConfig(item.id, config)}
                          onOnFailureChange={(val) => updateStep(item.id, { onFailure: val })}
                          onTimeoutChange={(val) => updateStep(item.id, { timeoutSeconds: val })}
                          onDelete={() => deleteStep(item.id)}
                        />
                      </div>
                      <AddParallelButton
                        open={parallelAddOpen === topIndex}
                        kinds={availableStepKinds}
                        onToggle={() =>
                          setParallelAddOpen(parallelAddOpen === topIndex ? null : topIndex)
                        }
                        onPick={(kind) => addParallelStep(topIndex, kind)}
                      />
                    </div>
                  </div>
                )
              })}
            </SortableContext>
          </DndContext>

          <AddStepControl
            open={addOpen}
            kinds={availableStepKinds}
            onToggle={setAddOpen}
            onPick={addStep}
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

type AddStepControlProps = {
  open: boolean
  kinds: StepKind[]
  onToggle: (next: boolean) => void
  onPick: (kind: StepKind) => void
}

/**
 * Returns the flat (linear) index of a step given its top-level position and
 * inner offset within a parallel group. Solo steps use innerIndex=0.
 */
function computeFlatIndex(steps: StepOrGroup[], topIndex: number, innerIndex: number): number {
  let count = 0
  for (let i = 0; i < topIndex; i++) {
    const item = steps[i]
    count += Array.isArray(item) ? item.length : 1
  }
  return count + innerIndex
}

function StepConnector(): React.JSX.Element {
  return (
    <div className="flex justify-center py-1">
      <div className="h-4 w-px bg-border" />
    </div>
  )
}

/**
 * Sortable wrapper for a parallel group row. Owns the vertical drag handle
 * (GripVertical) for the whole group so individual member cards don't need
 * their own. The composite `groupId` matches the entry in the parent's
 * `SortableContext` items array.
 */
function ParallelGroupContainer({
  groupId,
  children
}: {
  groupId: string
  children: React.ReactNode
}): React.JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: groupId })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div className="flex items-stretch gap-2">
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label="Reorder group"
          {...listeners}
          className={cn(
            'flex shrink-0 items-center rounded text-muted-foreground/50 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50',
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
        >
          <GripVertical className="size-4" />
        </button>
        <div className="flex flex-1 items-stretch gap-2">{children}</div>
      </div>
    </div>
  )
}

type AddParallelButtonProps = {
  open: boolean
  kinds: StepKind[]
  onToggle: () => void
  onPick: (kind: StepKind) => void
}

function AddParallelButton(props: AddParallelButtonProps): React.JSX.Element {
  return (
    <div className="relative flex shrink-0 items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Add parallel step"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </Button>
      {props.open ? (
        <div
          role="menu"
          aria-label="Step kinds"
          className="absolute left-full z-10 ml-1 flex flex-col rounded-md border border-border bg-background shadow-md"
        >
          {props.kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => props.onPick(kind)}
              className="whitespace-nowrap px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-foreground"
            >
              {STEP_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
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
          {props.kinds.map((kind) => (
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
