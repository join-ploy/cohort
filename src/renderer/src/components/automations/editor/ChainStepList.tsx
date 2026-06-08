import * as React from 'react'
import { Plus, GripVertical, ArrowUpFromLine, ClipboardPaste } from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
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
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type {
  HttpConnection,
  Step,
  StepConfig,
  StepKind,
  StepOrGroup
} from '../../../../../shared/automations-types'
import type { Repo, SidebarPromptCommand } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import {
  generateDefaultStepId,
  groupStepAt,
  moveStepIntoGroup,
  renameStepWithRewrites,
  reorderSteps,
  ungroupStep
} from '../../../lib/chain-editor-state'
import { parseStepFromClipboard } from '../../../lib/chain-editor-clipboard'
import { ChainEditorStepCardRouter } from './ChainEditorStepCardRouter'
import { STEP_KIND_LABELS } from './chain-editor-modal-state'

const STEP_CARD_WIDTH_CLASS = 'w-[min(calc(100vw-5rem),40rem)]'

export type ChainStepListProps = {
  /** The steps to render and edit. The component never mutates this array —
   *  every change flows out through `onStepsChange` so the owner stays the
   *  single source of truth (the top-level draft, or a watch node's
   *  `branchSteps`). */
  steps: StepOrGroup[]
  onStepsChange: (next: StepOrGroup[]) => void
  /** Addable kinds for the palette. The branch (nested) editor passes a list
   *  with `watch-pr` filtered out — v1 forbids nested loops. */
  availableStepKinds: StepKind[]
  /** Builds the AvailableVariables snapshot for the step at a flat index. The
   *  owner controls scope so the same list works at the top level and inside a
   *  branch (where upstream parent vars + the per-cycle payload are in scope). */
  getAvailableAtIndex: (flatIndex: number) => AvailableVariables
  repos: Repo[]
  reviewCommands: SidebarPromptCommand[]
  createPrCommands: SidebarPromptCommand[]
  httpConnections: HttpConnection[]
  /** Default `worktreeRef` for a newly added step that has a worktreeRef slot,
   *  or null to leave it blank. Lets the owner reuse its chain-aware default. */
  pickDefaultWorktreeRef: (steps: StepOrGroup[]) => string | null
  /** Builds the default config for a freshly added step kind. Threaded so the
   *  owner stays the single source of per-kind defaults. */
  getDefaultConfigForKind: (kind: StepKind) => StepConfig
  /** Copy shown when the list is empty. */
  emptyLabel?: string
}

/**
 * Reusable chain step-list editor: renders the step cards (solo + parallel
 * groups), owns drag-to-reorder, add/remove, parallel grouping, copy/paste, and
 * routes each card through ChainEditorStepCardRouter. Extracted from
 * ChainEditorModal so the watch-pr node can embed the same editor for its
 * `branchSteps` sub-chain. All mutations are pure transforms over the incoming
 * `steps` prop, emitted via `onStepsChange`.
 */
export function ChainStepList(props: ChainStepListProps): React.JSX.Element {
  const { steps, onStepsChange } = props

  const renameStep = React.useCallback(
    (oldId: string, newId: string) => {
      try {
        onStepsChange(renameStepWithRewrites(steps, oldId, newId))
      } catch {
        // StepCardChrome only commits a valid, unique id; the only failure path
        // is a collision, which we drop silently (the chrome snaps back).
      }
    },
    [steps, onStepsChange]
  )

  const updateStep = React.useCallback(
    (stepId: string, patch: Partial<Step>) => {
      const next = steps.map((item) => {
        if (Array.isArray(item)) {
          return item.map((s) => (s.id === stepId ? { ...s, ...patch } : s))
        }
        return item.id === stepId ? { ...item, ...patch } : item
      })
      onStepsChange(next)
    },
    [steps, onStepsChange]
  )

  const updateStepConfig = React.useCallback(
    (stepId: string, config: StepConfig) => {
      updateStep(stepId, { config })
    },
    [updateStep]
  )

  const deleteStep = React.useCallback(
    (stepId: string) => {
      const next: StepOrGroup[] = []
      for (const item of steps) {
        if (Array.isArray(item)) {
          const remaining = item.filter((s) => s.id !== stepId)
          if (remaining.length === 0) {
            continue
          }
          next.push(remaining.length === 1 ? remaining[0] : remaining)
        } else if (item.id !== stepId) {
          next.push(item)
        }
      }
      onStepsChange(next)
    },
    [steps, onStepsChange]
  )

  const moveStep = React.useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) {
        return
      }
      if (fromIndex < 0 || fromIndex >= steps.length || toIndex < 0 || toIndex >= steps.length) {
        return
      }
      onStepsChange(reorderSteps(steps, fromIndex, toIndex))
    },
    [steps, onStepsChange]
  )

  const buildNewStep = React.useCallback(
    (kind: StepKind): Step => {
      const config = props.getDefaultConfigForKind(kind)
      // Prefill a worktreeRef slot with the most recent create-* step's output
      // so the user doesn't retype the same template on every new step.
      if ('worktreeRef' in config && (config as { worktreeRef: string }).worktreeRef === '') {
        const ref = props.pickDefaultWorktreeRef(steps)
        if (ref) {
          ;(config as { worktreeRef: string }).worktreeRef = ref
        }
      }
      return {
        id: generateDefaultStepId(kind, steps),
        kind,
        config,
        onFailure: 'halt',
        timeoutSeconds: null
      }
    },
    [steps, props]
  )

  const [addOpen, setAddOpen] = React.useState(false)
  const addStep = React.useCallback(
    (kind: StepKind) => {
      onStepsChange([...steps, buildNewStep(kind)])
      setAddOpen(false)
    },
    [steps, onStepsChange, buildNewStep]
  )

  const [parallelAddOpen, setParallelAddOpen] = React.useState<number | null>(null)
  const addParallelStep = React.useCallback(
    (topIndex: number, kind: StepKind) => {
      onStepsChange(groupStepAt(steps, topIndex, buildNewStep(kind)))
      setParallelAddOpen(null)
    },
    [steps, onStepsChange, buildNewStep]
  )

  const pasteStep = React.useCallback(
    async (place: (steps: StepOrGroup[], step: Step) => StepOrGroup[]) => {
      let text: string
      try {
        text = await window.api.ui.readClipboardText()
      } catch {
        toast.error('No automation node on the clipboard')
        return
      }
      const step = parseStepFromClipboard(text)
      if (!step) {
        toast.error('No automation node on the clipboard')
        return
      }
      // Reject kinds the palette excludes (the branch editor omits 'watch-pr')
      // so copy-paste can't bypass the no-nested-watch-pr invariant the runtime
      // relies on. The top-level chain's availableStepKinds includes every kind,
      // so its paste is unaffected.
      if (!isPasteAllowed(step.kind, props.availableStepKinds)) {
        toast.error("Watch PR can't be nested inside a review-loop branch.")
        return
      }
      onStepsChange(place(steps, step))
      toast.success('Node pasted')
    },
    [steps, onStepsChange, props.availableStepKinds]
  )

  const extractFromGroup = React.useCallback(
    (groupIndex: number, innerIndex: number) => {
      const group = steps[groupIndex]
      if (!Array.isArray(group)) {
        return
      }
      const step = group[innerIndex]
      if (!step) {
        return
      }
      const afterUngroup = ungroupStep(steps, groupIndex, innerIndex)
      const insertAt = groupIndex + 1
      onStepsChange([...afterUngroup.slice(0, insertAt), step, ...afterUngroup.slice(insertAt)])
    },
    [steps, onStepsChange]
  )

  // Matches TabBar's 5px activation so a click without movement still focuses.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const topLevelIds = React.useMemo(
    () =>
      steps.map((item) =>
        Array.isArray(item) ? `group-${item.map((s) => s.id).join('+')}` : item.id
      ),
    [steps]
  )

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) {
        return
      }
      const overId = String(over.id)
      if (overId.startsWith('parallel-drop-')) {
        const targetTopIndex = Number(overId.slice('parallel-drop-'.length))
        const fromIndex = topLevelIds.indexOf(String(active.id))
        if (fromIndex === -1 || fromIndex === targetTopIndex) {
          return
        }
        onStepsChange(moveStepIntoGroup(steps, fromIndex, targetTopIndex))
        return
      }
      const fromIndex = topLevelIds.indexOf(String(active.id))
      const toIndex = topLevelIds.indexOf(overId)
      if (fromIndex === -1 || toIndex === -1) {
        return
      }
      moveStep(fromIndex, toIndex)
    },
    [topLevelIds, moveStep, steps, onStepsChange]
  )

  return (
    <div className="flex w-full flex-col">
      {steps.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
          {props.emptyLabel ?? 'No steps yet. Click “Add step” to start your chain.'}
        </div>
      ) : null}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={topLevelIds} strategy={verticalListSortingStrategy}>
          {steps.map((item, topIndex) => {
            if (Array.isArray(item)) {
              const groupId = `group-${item.map((s) => s.id).join('+')}`
              return (
                <div key={groupId}>
                  {topIndex > 0 && <StepConnector />}
                  <ParallelGroupContainer groupId={groupId}>
                    {item.map((step, innerIndex) => {
                      const flatIndex = computeFlatIndex(steps, topIndex, innerIndex)
                      return (
                        <div
                          key={step.id}
                          className={cn('relative shrink-0', STEP_CARD_WIDTH_CLASS)}
                        >
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
                            available={props.getAvailableAtIndex(flatIndex)}
                            repos={props.repos}
                            reviewCommands={props.reviewCommands}
                            createPrCommands={props.createPrCommands}
                            httpConnections={props.httpConnections}
                            onIdChange={(newId) => renameStep(step.id, newId)}
                            onConfigChange={(config) => updateStepConfig(step.id, config)}
                            onOnFailureChange={(val) => updateStep(step.id, { onFailure: val })}
                            onTimeoutChange={(val) => updateStep(step.id, { timeoutSeconds: val })}
                            onDelete={() => deleteStep(step.id)}
                          />
                        </div>
                      )
                    })}
                    <div className="absolute bottom-0 left-full top-0 ml-2 flex">
                      <AddParallelButton
                        open={parallelAddOpen === topIndex}
                        kinds={props.availableStepKinds}
                        droppableId={`parallel-drop-${topIndex}`}
                        onToggle={() =>
                          setParallelAddOpen(parallelAddOpen === topIndex ? null : topIndex)
                        }
                        onPick={(kind) => addParallelStep(topIndex, kind)}
                        onPaste={() => void pasteStep((s, step) => groupStepAt(s, topIndex, step))}
                      />
                    </div>
                  </ParallelGroupContainer>
                </div>
              )
            }
            const flatIndex = computeFlatIndex(steps, topIndex, 0)
            return (
              <div key={item.id}>
                {topIndex > 0 && <StepConnector />}
                <div className="flex justify-center">
                  <div className={cn('relative', STEP_CARD_WIDTH_CLASS)}>
                    <ChainEditorStepCardRouter
                      step={item}
                      index={flatIndex}
                      available={props.getAvailableAtIndex(flatIndex)}
                      repos={props.repos}
                      reviewCommands={props.reviewCommands}
                      createPrCommands={props.createPrCommands}
                      httpConnections={props.httpConnections}
                      onIdChange={(newId) => renameStep(item.id, newId)}
                      onConfigChange={(config) => updateStepConfig(item.id, config)}
                      onOnFailureChange={(val) => updateStep(item.id, { onFailure: val })}
                      onTimeoutChange={(val) => updateStep(item.id, { timeoutSeconds: val })}
                      onDelete={() => deleteStep(item.id)}
                    />
                    <div className="absolute bottom-0 left-full top-0 ml-2 flex">
                      <AddParallelButton
                        open={parallelAddOpen === topIndex}
                        kinds={props.availableStepKinds}
                        droppableId={`parallel-drop-${topIndex}`}
                        onToggle={() =>
                          setParallelAddOpen(parallelAddOpen === topIndex ? null : topIndex)
                        }
                        onPick={(kind) => addParallelStep(topIndex, kind)}
                        onPaste={() => void pasteStep((s, step) => groupStepAt(s, topIndex, step))}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </SortableContext>
      </DndContext>

      <AddStepControl
        open={addOpen}
        kinds={props.availableStepKinds}
        onToggle={setAddOpen}
        onPick={addStep}
        onPaste={() => void pasteStep((s, step) => [...s, step])}
      />
    </div>
  )
}

/**
 * True when a clipboard step of `kind` may be pasted into a list whose palette
 * offers `availableStepKinds`. The branch (nested) editor omits 'watch-pr', so
 * this keeps paste consistent with the palette and closes the copy-paste hole
 * around the no-nested-watch-pr invariant.
 */
export function isPasteAllowed(kind: StepKind, availableStepKinds: StepKind[]): boolean {
  return availableStepKinds.includes(kind)
}

/**
 * Returns the flat (linear) index of a step given its top-level position and
 * inner offset within a parallel group. Solo steps use innerIndex=0.
 */
export function computeFlatIndex(
  steps: StepOrGroup[],
  topIndex: number,
  innerIndex: number
): number {
  let count = 0
  for (let i = 0; i < topIndex; i++) {
    const item = steps[i]
    count += Array.isArray(item) ? item.length : 1
  }
  return count + innerIndex
}

function StepConnector(): React.JSX.Element {
  return (
    <div className="-my-px flex justify-center">
      <div className="h-6 w-px bg-border" />
    </div>
  )
}

/**
 * Sortable wrapper for a parallel group row. Owns the vertical drag handle for
 * the whole group so member cards don't need their own.
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
      <div className="relative left-1/2 w-screen -translate-x-1/2 overflow-x-auto px-12 pb-2 pt-3">
        <div className="mx-auto flex w-max items-stretch gap-2">
          <div className="relative flex items-stretch gap-2">{children}</div>
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label="Reorder group"
            {...listeners}
            className={cn(
              'absolute bottom-0 left-2 top-0 z-10 flex items-center rounded bg-background/80 text-muted-foreground/50 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50',
              isDragging ? 'cursor-grabbing' : 'cursor-grab'
            )}
          >
            <GripVertical className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

type AddParallelButtonProps = {
  open: boolean
  kinds: StepKind[]
  droppableId: string
  onToggle: () => void
  onPick: (kind: StepKind) => void
  onPaste: () => void
}

function AddParallelButton(props: AddParallelButtonProps): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: props.droppableId })
  return (
    <div
      ref={setNodeRef}
      className={cn('relative flex shrink-0 items-center', isOver && 'rounded-md ring-2 ring-ring')}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          <ContextMenuItem onSelect={props.onPaste}>
            <ClipboardPaste className="size-3.5" />
            Paste node
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
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

type AddStepControlProps = {
  open: boolean
  kinds: StepKind[]
  onToggle: (next: boolean) => void
  onPick: (kind: StepKind) => void
  onPaste: () => void
}

function AddStepControl(props: AddStepControlProps): React.JSX.Element {
  return (
    <div className="relative flex justify-center py-2">
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          <ContextMenuItem onSelect={props.onPaste}>
            <ClipboardPaste className="size-3.5" />
            Paste node
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
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
