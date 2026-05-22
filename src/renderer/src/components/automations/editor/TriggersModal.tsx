import * as React from 'react'
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
  // "+ Add condition" until the catalog arrives.
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
  // the cache lives only as long as the component instance).
  const [optionsCache, setOptionsCache] = React.useState<
    Map<string, { value: string; label: string }[]>
  >(new Map())
  const loadOptionsFor = React.useCallback(
    (sourceId: TriggerSourceId) =>
      async (field: string): Promise<{ value: string; label: string }[]> => {
        const cacheKey = `${sourceId}|${field}`
        const cached = optionsCache.get(cacheKey)
        if (cached) {
          return cached
        }
        const opts = await window.api.triggerSources.fetchOptions({ sourceId, field })
        setOptionsCache((m) => {
          const next = new Map(m)
          next.set(cacheKey, opts)
          return next
        })
        return opts
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

  // Why: Phase 12/13 introduce validation; for the scaffolding phase Save is
  // always available.
  const canSave = true

  const save = (): void => {
    props.onSave({ trigger: draftTrigger, autoTriggers: draftAutoTriggers })
  }

  return (
    <div
      role="dialog"
      aria-label="Triggers"
      className="fixed inset-0 z-30 flex items-center justify-center bg-background/40"
    >
      <div className="w-[28rem] rounded-md border bg-popover p-4 text-sm shadow-md">
        <h2 className="text-base font-semibold">Triggers</h2>

        <section aria-label="Manual">
          <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Manual
          </h3>
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Accept Linear ticket on Run"
              checked={linearOn}
              onChange={toggleLinear}
            />
            Accept Linear ticket on Run
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Pick project on Run"
              checked={projectOn}
              onChange={toggleProject}
            />
            Pick project on Run
          </label>
        </section>

        <hr className="my-3" />

        <section aria-label="Automatic">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Automatic
            </h3>
            <div className="relative">
              <button
                type="button"
                aria-label="Add automatic trigger"
                aria-haspopup="menu"
                aria-expanded={addOpen}
                onClick={() => setAddOpen((v) => !v)}
                className="rounded border border-border bg-background px-2 py-0.5 text-xs hover:bg-accent hover:text-foreground"
              >
                + Add ▾
              </button>
              {addOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 mt-1 rounded-md border bg-popover p-1 shadow-md"
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
                      className="block w-full px-2 py-1 text-left text-xs hover:bg-accent hover:text-foreground"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {draftAutoTriggers.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No automatic triggers configured.</p>
          ) : (
            <ul className="mt-2 space-y-2">
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

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded border border-border bg-background px-3 py-1 text-xs hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={save}
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
