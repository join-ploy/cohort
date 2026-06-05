import * as React from 'react'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { buildPaths, type PathEntry } from '../../../lib/available-variables-tree'
import { describeVariable } from '../../../lib/variable-descriptions'

export type VariablePickerPopoverProps = {
  open: boolean
  anchor: HTMLElement | null
  available: AvailableVariables
  query: string
  // Receives the full dotted path without braces, e.g. 'steps.cw1.worktreeId'.
  onSelect: (fullPath: string) => void
  onClose: () => void
}

function fuzzyMatch(query: string, target: string): boolean {
  if (query.length === 0) {
    return true
  }
  const lower = target.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < lower.length && qi < query.length; ti++) {
    if (lower[ti] === query[qi]) {
      qi++
    }
  }
  return qi === query.length
}

export function VariablePickerPopover(props: VariablePickerPopoverProps): React.JSX.Element | null {
  const { open, anchor, available, query, onSelect, onClose } = props

  const allPaths = React.useMemo(() => buildPaths(available), [available])
  const filtered = React.useMemo(() => {
    const q = query.toLowerCase()
    if (q.length === 0) {
      return allPaths
    }
    return allPaths.filter((p) => fuzzyMatch(q, p.path))
  }, [allPaths, query])

  const [highlightedIdx, setHighlightedIdx] = React.useState(0)

  React.useEffect(() => {
    setHighlightedIdx(0)
  }, [open, query])

  React.useEffect(() => {
    if (!open) {
      return
    }
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightedIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightedIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const entry = filtered[highlightedIdx]
        if (entry) {
          onSelect(entry.path)
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, filtered, highlightedIdx, onSelect, onClose])

  if (!open || filtered.length === 0) {
    return null
  }

  const rect = anchor?.getBoundingClientRect()
  const style: React.CSSProperties = rect
    ? { position: 'fixed', top: rect.bottom + 4, left: rect.left, zIndex: 50 }
    : {}

  const automation = filtered.filter((p) => p.namespace === 'automation')
  const trigger = filtered.filter((p) => p.namespace === 'trigger')
  const group = filtered.filter((p) => p.namespace === 'group')
  const steps = filtered.filter((p) => p.namespace === 'steps')

  return (
    <div
      role="listbox"
      style={style}
      className="bg-popover text-popover-foreground border border-border rounded-md shadow-md min-w-[280px] max-h-[320px] overflow-y-auto py-1"
    >
      {renderSection('Automation', automation, filtered, highlightedIdx, onSelect, onClose, false)}
      {renderSection('Trigger', trigger, filtered, highlightedIdx, onSelect, onClose, false)}
      {renderSection('Group', group, filtered, highlightedIdx, onSelect, onClose, false)}
      {renderSection('Steps', steps, filtered, highlightedIdx, onSelect, onClose, true)}
    </div>
  )
}

function renderSection(
  label: string,
  entries: PathEntry[],
  allPaths: PathEntry[],
  highlightedIdx: number,
  onSelect: (p: string) => void,
  onClose: () => void,
  groupByStep: boolean
): React.JSX.Element | null {
  if (entries.length === 0) {
    return null
  }
  return (
    <div key={label} className="px-1 py-0.5">
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      {groupByStep
        ? Object.entries(groupByStepId(entries)).map(([stepId, group]) => (
            <div key={stepId}>
              <div className="px-2 py-0.5 text-[10px] text-muted-foreground/60">{stepId}</div>
              {group.map((entry) =>
                renderRow(entry, allPaths.indexOf(entry) === highlightedIdx, onSelect, onClose)
              )}
            </div>
          ))
        : entries.map((entry) =>
            renderRow(entry, allPaths.indexOf(entry) === highlightedIdx, onSelect, onClose)
          )}
    </div>
  )
}

function groupByStepId(entries: PathEntry[]): Record<string, PathEntry[]> {
  const out: Record<string, PathEntry[]> = {}
  for (const e of entries) {
    if (e.stepId) {
      if (!out[e.stepId]) {
        out[e.stepId] = []
      }
      out[e.stepId].push(e)
    }
  }
  return out
}

function renderRow(
  entry: PathEntry,
  highlighted: boolean,
  onSelect: (p: string) => void,
  onClose: () => void
): React.JSX.Element {
  const base = 'w-full flex flex-col items-stretch gap-0.5 px-2 py-1 text-left'
  const stateClasses = highlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40'
  const description = describeVariable(entry)
  return (
    <button
      key={entry.path}
      type="button"
      role="option"
      aria-selected={highlighted}
      onClick={() => {
        onSelect(entry.path)
        onClose()
      }}
      className={`${base} ${stateClasses}`}
    >
      <span className="flex items-center justify-between text-xs font-mono">
        <span>{entry.path}</span>
        <span className="text-muted-foreground text-[10px]">{entry.type}</span>
      </span>
      {/* Prose, so sans not mono — mono is reserved for the literal path. */}
      {description && <span className="text-[11px] text-muted-foreground">{description}</span>}
    </button>
  )
}
