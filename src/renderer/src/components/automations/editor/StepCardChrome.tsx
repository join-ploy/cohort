import * as React from 'react'
import {
  FolderGit2,
  FolderTree,
  Hourglass,
  Sparkles,
  TerminalSquare,
  Ticket,
  GripVertical,
  Trash2
} from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import type { Step, StepConfig, StepKind } from '../../../../../shared/automations-types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { isValidStepId } from '../../../lib/chain-editor-state'

export type StepCardChromeProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  onIdChange: (newId: string) => void
  onConfigChange: (config: StepConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
  children: React.ReactNode
}

const KIND_META: Record<
  StepKind,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  'create-worktree': { label: 'Create worktree', icon: FolderGit2 },
  'create-workspace-group': { label: 'Create workspace group', icon: FolderTree },
  'wait-for-setup': { label: 'Wait for setup', icon: Hourglass },
  'run-prompt': { label: 'Run prompt', icon: Sparkles },
  'run-command': { label: 'Run command', icon: TerminalSquare },
  'update-linear-issue': { label: 'Update Linear issue', icon: Ticket }
}

/**
 * Shared header + footer chrome for every step card kind. The middle slot is
 * the per-kind body, supplied as `children`. Header carries the drag handle
 * (wired via `useSortable` — only the GripVertical receives drag listeners so
 * form controls inside the body stay clickable), kind icon/badge, the inline
 * step-id editor, and the delete button. Footer carries the `onFailure`
 * segmented control + a `timeoutSeconds` input with a "no limit" toggle.
 *
 * The step-id editor is locally controlled: we keep the user's draft in
 * component state and only call `onIdChange` when the draft is a valid id
 * (`isValidStepId`) and different from the current step id. Invalid drafts
 * stay visible with a red ring so the user can fix them in place.
 */
export function StepCardChrome(props: StepCardChromeProps): React.JSX.Element {
  const { step, onIdChange, onOnFailureChange, onTimeoutChange, onDelete } = props
  const meta = KIND_META[step.kind]
  const Icon = meta.icon

  // Why: sortable id matches the step.id used in the parent's SortableContext
  // items array. Listeners are attached ONLY to the GripVertical button below
  // so the rest of the card (inputs, segmented controls) keeps native click
  // semantics — dragging on a text field would otherwise prevent text
  // selection and the surrounding pointer-down sequence.
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: step.id })

  const [idDraft, setIdDraft] = React.useState(step.id)
  // Sync draft when the canonical step.id changes from outside (e.g. parent
  // accepted a previous edit, or undo/redo). Stays a no-op when the draft
  // already matches.
  React.useEffect(() => {
    setIdDraft(step.id)
  }, [step.id])

  const draftValid = isValidStepId(idDraft)

  const commitIdDraft = React.useCallback(() => {
    if (!draftValid || idDraft === step.id) {
      // Snap back to last valid id so the user is not left with a broken value.
      setIdDraft(step.id)
      return
    }
    onIdChange(idDraft)
  }, [draftValid, idDraft, step.id, onIdChange])

  const timeoutEnabled = step.timeoutSeconds !== null
  const timeoutValue = step.timeoutSeconds ?? 0

  // Why: while dragging, hide the source card so the parent's autoScroll +
  // sibling-shift animation reads clearly. dnd-kit re-renders neighbours via
  // the SortableContext strategy, and the original card returning to opacity
  // 1 on drop is what produces the "snap into place" finish.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-step-id={step.id}
      data-step-kind={step.kind}
      data-dragging={isDragging ? 'true' : 'false'}
      {...attributes}
      className="rounded-lg border border-border bg-card text-card-foreground shadow-xs"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label="Reorder step"
          {...listeners}
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50',
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
        <span
          aria-label="Step kind"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-medium"
        >
          <Icon className="size-3.5" />
          {meta.label}
        </span>
        <input
          aria-label="Step ID"
          type="text"
          value={idDraft}
          onChange={(e) => setIdDraft(e.target.value)}
          onBlur={commitIdDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitIdDraft()
            } else if (e.key === 'Escape') {
              setIdDraft(step.id)
            }
          }}
          className={cn(
            'min-w-0 flex-1 rounded-md border bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50',
            draftValid ? 'border-input' : 'ring-1 ring-rose-500/60 border-rose-500/60'
          )}
        />
        <button
          type="button"
          aria-label="Delete step"
          onClick={onDelete}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      <div className="px-3 py-3 space-y-2">{props.children}</div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border bg-muted/30 px-3 py-2 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">On failure</span>
          <div
            role="group"
            aria-label="On failure"
            className="inline-flex overflow-hidden rounded-md border border-input"
          >
            <button
              type="button"
              aria-pressed={step.onFailure === 'halt'}
              onClick={() => onOnFailureChange('halt')}
              className={cn(
                'px-2 py-1',
                step.onFailure === 'halt'
                  ? 'bg-accent text-foreground'
                  : 'bg-background text-muted-foreground hover:text-foreground'
              )}
            >
              Halt
            </button>
            <button
              type="button"
              aria-pressed={step.onFailure === 'continue'}
              onClick={() => onOnFailureChange('continue')}
              className={cn(
                'border-l border-input px-2 py-1',
                step.onFailure === 'continue'
                  ? 'bg-accent text-foreground'
                  : 'bg-background text-muted-foreground hover:text-foreground'
              )}
            >
              Continue
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-muted-foreground">
            <input
              type="checkbox"
              aria-label="No timeout"
              checked={!timeoutEnabled}
              onChange={(e) => onTimeoutChange(e.target.checked ? null : 60)}
            />
            No limit
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">Timeout (s)</span>
            <input
              type="number"
              aria-label="Timeout seconds"
              min={1}
              value={timeoutEnabled ? timeoutValue : ''}
              disabled={!timeoutEnabled}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                onTimeoutChange(Number.isFinite(n) && n > 0 ? n : null)
              }}
              className="w-20 rounded-md border border-input bg-background px-2 py-1 outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50 disabled:opacity-50"
            />
          </label>
        </div>
      </div>
    </div>
  )
}
