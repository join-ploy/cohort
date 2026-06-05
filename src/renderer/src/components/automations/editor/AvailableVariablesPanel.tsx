import * as React from 'react'
import { cn } from '@/lib/utils'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { buildPaths, type PathEntry } from '../../../lib/available-variables-tree'
import { describeVariable } from '../../../lib/variable-descriptions'

export type AvailableVariablesPanelProps = {
  available: AvailableVariables
  className?: string
}

// Footer summary that lists every variable available at the end of the
// automation chain. Pure display — no interaction beyond expand/collapse.
// Uses a <details> element so the body lives in the DOM whether open or
// closed: keeps SSR/static-markup tests trivial and gives us native a11y
// for the disclosure semantics.
export function AvailableVariablesPanel(props: AvailableVariablesPanelProps): React.JSX.Element {
  const paths = React.useMemo(() => buildPaths(props.available), [props.available])
  const automation = paths.filter((p) => p.namespace === 'automation')
  const trigger = paths.filter((p) => p.namespace === 'trigger')
  const group = paths.filter((p) => p.namespace === 'group')
  const steps = paths.filter((p) => p.namespace === 'steps')

  return (
    <details className={cn('border-t border-border bg-muted/30 text-xs', props.className)}>
      <summary
        className={cn(
          'cursor-pointer select-none px-3 py-2 text-muted-foreground',
          'hover:bg-accent/30 list-none [&::-webkit-details-marker]:hidden'
        )}
      >
        Available variables ({paths.length})
      </summary>
      <div className="px-3 pb-3 max-h-64 overflow-y-auto">
        {paths.length === 0 ? (
          <div className="px-2 py-1 text-muted-foreground/70">None</div>
        ) : (
          <>
            {renderSection('Automation', automation, false)}
            {renderSection('Trigger', trigger, false)}
            {renderSection('Group', group, false)}
            {renderSection('Steps', steps, true)}
          </>
        )}
      </div>
    </details>
  )
}

function renderSection(
  label: string,
  entries: PathEntry[],
  groupByStep: boolean
): React.JSX.Element | null {
  if (entries.length === 0) {
    return null
  }
  return (
    <div key={label} className="py-1">
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      {groupByStep
        ? Object.entries(groupByStepId(entries)).map(([stepId, group]) => (
            <div key={stepId}>
              <div className="px-2 py-0.5 text-[10px] text-muted-foreground/60">{stepId}</div>
              {group.map((entry) => renderRow(entry))}
            </div>
          ))
        : entries.map((entry) => renderRow(entry))}
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

function renderRow(entry: PathEntry): React.JSX.Element {
  const description = describeVariable(entry)
  return (
    <div key={entry.path} className="flex flex-col gap-0.5 px-2 py-0.5">
      <div className="flex items-center justify-between font-mono">
        <span>{entry.path}</span>
        <span className="text-muted-foreground text-[10px]">{entry.type}</span>
      </div>
      {/* Prose, so sans not mono — mono is reserved for the literal path. */}
      {description && <span className="text-[11px] text-muted-foreground">{description}</span>}
    </div>
  )
}
