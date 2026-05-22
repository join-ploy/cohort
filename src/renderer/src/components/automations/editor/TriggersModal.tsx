import * as React from 'react'
import { Plus, X, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useAppStore } from '@/store'
import type {
  TriggerConfig,
  AutoTrigger,
  SerializableFieldDescriptor,
  SerializableTriggerSource,
  TriggerSourceId
} from '../../../../../shared/automations-types'
import type { Repo } from '../../../../../shared/types'
import { AutoTriggerCard } from './AutoTriggerCard'

export type TriggersModalProps = {
  open: boolean
  /** Owning automation id — forwarded to AutoTriggerCard so it can query the
   *  dedup IPC. Empty string for unsaved automations. */
  automationId: string
  trigger: TriggerConfig
  autoTriggers: AutoTrigger[]
  /** Registered source ids the user can add. Phase 13 will wire this to the
   *  source-registry IPC. For now ChainEditorModal hardcodes the list. */
  availableSources: { id: TriggerSourceId; label: string }[]
  onSave: (next: { trigger: TriggerConfig; autoTriggers: AutoTrigger[] }) => void
  onCancel: () => void
}

// Why: shadcn Dialog renders via Radix Portal which doesn't appear in
// renderToStaticMarkup-based tests. We render the modal body as a conditional
// inline <div> so the surface is testable without an extra jsdom harness —
// same pattern as TriggerPill's prior inline popover.
export function TriggersModal(props: TriggersModalProps): React.JSX.Element | null {
  const [draftTrigger, setDraftTrigger] = React.useState<TriggerConfig>(props.trigger)
  const [draftAutoTriggers, setDraftAutoTriggers] = React.useState<AutoTrigger[]>(
    props.autoTriggers
  )
  const [addOpen, setAddOpen] = React.useState(false)

  const repos = useAppStore((s) => s.repos as Repo[])
  const projects = React.useMemo(
    () => repos.map((r) => ({ id: r.id, displayName: r.displayName })),
    [repos]
  )

  // Why: load the source catalog from main on each modal open so a fresh
  // Linear connect/disconnect is reflected without a reload. Empty default keeps
  // the UI usable while the IPC roundtrip resolves; rules render with disabled
  // "Add condition" until the catalog arrives.
  const [sources, setSources] = React.useState<SerializableTriggerSource[]>([])
  React.useEffect(() => {
    if (!props.open) {
      return
    }
    void window.api.triggerSources.list().then(setSources)
  }, [props.open])

  const fieldCatalogBySource = React.useMemo(() => {
    const map = new Map<TriggerSourceId, SerializableFieldDescriptor[]>()
    for (const s of sources) {
      map.set(s.id, s.fieldCatalog)
    }
    return map
  }, [sources])

  // Why: per-(sourceId, field) option cache. The first ConditionRow mount for a
  // field hits IPC; subsequent renders reuse the cached array. Cleared whenever
  // the modal closes (the effect above re-runs on open and seeds fresh sources;
  // the cache lives only as long as the component instance). Passing
  // { force: true } bypasses the cache so newly-added Linear tags/labels show
  // up when the dropdown reopens.
  const [optionsCache, setOptionsCache] = React.useState<
    Map<string, { value: string; label: string }[]>
  >(new Map())
  const loadOptionsFor = React.useCallback(
    (sourceId: TriggerSourceId) =>
      async (
        field: string,
        opts?: { force?: boolean }
      ): Promise<{ value: string; label: string }[]> => {
        const cacheKey = `${sourceId}|${field}`
        if (!opts?.force) {
          const cached = optionsCache.get(cacheKey)
          if (cached) {
            return cached
          }
        }
        const fresh = await window.api.triggerSources.fetchOptions({ sourceId, field })
        setOptionsCache((m) => {
          const next = new Map(m)
          next.set(cacheKey, fresh)
          return next
        })
        return fresh
      },
    [optionsCache]
  )

  // Why: re-seed the draft each time the modal opens so a prior Cancel doesn't
  // bleed stale local edits into the next session.
  React.useEffect(() => {
    if (props.open) {
      setDraftTrigger(props.trigger)
      setDraftAutoTriggers(props.autoTriggers)
      setAddOpen(false)
    }
    // Intentionally only depends on `open` — props.trigger / props.autoTriggers
    // are the seed, not a live binding; resyncing on every parent re-render
    // would clobber in-flight edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open])

  if (!props.open) {
    return null
  }

  const linearOn = draftTrigger.acceptsLinearTicket === true
  const projectOn = draftTrigger.acceptsProjectSelection === true

  const toggleLinear = (): void => {
    setDraftTrigger((t) => ({ ...t, acceptsLinearTicket: !linearOn }))
  }
  const toggleProject = (): void => {
    setDraftTrigger((t) => ({ ...t, acceptsProjectSelection: !projectOn }))
  }

  const addTrigger = (source: TriggerSourceId): void => {
    setDraftAutoTriggers((list) => [
      ...list,
      {
        id: crypto.randomUUID(),
        source,
        enabled: true,
        enabledAt: Date.now(),
        rules: []
      }
    ])
  }

  const removeTrigger = (id: string): void => {
    setDraftAutoTriggers((list) => list.filter((t) => t.id !== id))
  }

  const save = (): void => {
    props.onSave({ trigger: draftTrigger, autoTriggers: draftAutoTriggers })
  }

  return (
    <div
      role="dialog"
      aria-label="Triggers"
      className="fixed inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div className="flex max-h-[calc(100vh-4rem)] w-[32rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Triggers</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Configure how this automation runs.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close triggers"
            onClick={props.onCancel}
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="scrollbar-sleek flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section aria-label="Manual" className="space-y-2">
            <div className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                Manual
              </h3>
              <p className="text-xs text-muted-foreground">
                Prompt the operator for input when running on demand.
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent/40">
              <input
                type="checkbox"
                aria-label="Accept Linear ticket on Run"
                checked={linearOn}
                onChange={toggleLinear}
                className="size-4 rounded border-input"
              />
              <span className="text-sm">Accept Linear ticket on Run</span>
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent/40">
              <input
                type="checkbox"
                aria-label="Pick project on Run"
                checked={projectOn}
                onChange={toggleProject}
                className="size-4 rounded border-input"
              />
              <span className="text-sm">Pick project on Run</span>
            </label>
          </section>

          <Separator />

          <section aria-label="Automatic" className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div className="space-y-1">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                  Automatic
                </h3>
                <p className="text-xs text-muted-foreground">
                  Auto-fire this automation when an event matches your rules.
                </p>
              </div>
              <div className="relative">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Add automatic trigger"
                  aria-haspopup="menu"
                  aria-expanded={addOpen}
                  onClick={() => setAddOpen((v) => !v)}
                >
                  <Plus className="size-3.5" />
                  Add trigger
                </Button>
                {addOpen ? (
                  <div
                    role="menu"
                    className="absolute right-0 top-full z-40 mt-1 min-w-[12rem] rounded-md border border-border bg-popover p-1 shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
                  >
                    {props.availableSources.map((s) => (
                      <button
                        key={s.id}
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          addTrigger(s.id)
                          setAddOpen(false)
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                      >
                        <Zap className="size-3.5 text-muted-foreground" />
                        {s.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            {draftAutoTriggers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-card/50 p-6 text-center">
                <p className="text-sm text-muted-foreground">No automatic triggers configured.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Auto-fire this automation when an event matches your rules.
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {draftAutoTriggers.map((t) => (
                  <li key={t.id}>
                    <AutoTriggerCard
                      trigger={t}
                      automationId={props.automationId}
                      onChange={(next) =>
                        setDraftAutoTriggers((arr) => arr.map((x) => (x.id === t.id ? next : x)))
                      }
                      onRemove={() => removeTrigger(t.id)}
                      projects={projects}
                      fieldCatalog={fieldCatalogBySource.get(t.source) ?? []}
                      loadOptions={loadOptionsFor(t.source)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={save}>
            Save
          </Button>
        </footer>
      </div>
    </div>
  )
}
