import * as React from 'react'
import type {
  TriggerConfig,
  AutoTrigger,
  TriggerSourceId
} from '../../../../../shared/automations-types'

export type TriggersModalProps = {
  open: boolean
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
                <li
                  key={t.id}
                  aria-label={`auto trigger ${t.id}`}
                  className="flex items-center justify-between rounded border bg-card p-2 text-xs"
                >
                  <span>{t.source}</span>
                  <button
                    type="button"
                    aria-label={`remove trigger ${t.id}`}
                    onClick={() => removeTrigger(t.id)}
                    className="rounded border border-border bg-background px-2 py-0.5 hover:bg-accent hover:text-foreground"
                  >
                    Remove
                  </button>
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
