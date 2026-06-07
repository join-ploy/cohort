import { useEffect, useState } from 'react'
import type { Automation } from '../../../../shared/automations-types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { AUTOMATIONS_PANE_SEARCH_ENTRIES } from './automations-search'
import { HttpConnectionsSection } from './HttpConnectionsSection'

export { AUTOMATIONS_PANE_SEARCH_ENTRIES }

// Default mirrors `getAutomationsPollIntervalSeconds` on the main side. The
// IPC layer clamps to [15, 600] so the UI only needs to show the current
// value and forward edits without local clamp duplication.
const DEFAULT_POLL_INTERVAL_SECONDS = 60

export function hasAnyEnabledLinearIssueTrigger(automations: Automation[]): boolean {
  for (const automation of automations) {
    const triggers = automation.autoTriggers
    if (!triggers) {
      continue
    }
    for (const trigger of triggers) {
      if (trigger.enabled && trigger.source === 'linear-issue') {
        return true
      }
    }
  }
  return false
}

type AutomationsPaneViewProps = {
  pollIntervalSeconds: number
  linearConnected: boolean
  hasEnabledLinearTrigger: boolean
  onCommitPollInterval: (next: number) => void
}

// Why: separated from the container so tests can render the visual states
// (input value, banner-present, banner-absent) without standing up the
// effects that load automations or the store wiring.
export function AutomationsPaneView({
  pollIntervalSeconds,
  linearConnected,
  hasEnabledLinearTrigger,
  onCommitPollInterval
}: AutomationsPaneViewProps): React.JSX.Element {
  const [draft, setDraft] = useState<string>(String(pollIntervalSeconds))
  const [lastSyncedValue, setLastSyncedValue] = useState<number>(pollIntervalSeconds)

  // Why: re-sync the draft when the canonical value changes from outside
  // this component (e.g. after the IPC clamp returns a different number).
  if (pollIntervalSeconds !== lastSyncedValue) {
    setLastSyncedValue(pollIntervalSeconds)
    setDraft(String(pollIntervalSeconds))
  }

  const commitPollInterval = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      // Why: revert to the canonical value when the user typed something
      // unparseable instead of silently sending NaN through the IPC.
      setDraft(String(pollIntervalSeconds))
      return
    }
    if (parsed === pollIntervalSeconds) {
      return
    }
    onCommitPollInterval(parsed)
  }

  const showBanner = !linearConnected && hasEnabledLinearTrigger

  return (
    <div className="space-y-4">
      {showBanner ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300"
        >
          <span className="font-medium">Linear not connected — auto triggers paused.</span>
          <span className="text-amber-700/80 dark:text-amber-300/80">
            Reconnect from Settings → Integrations to resume Linear issue auto-triggers.
          </span>
        </div>
      ) : null}

      <SearchableSetting
        title="Linear Poll Interval"
        description="How often Orca polls Linear for auto-trigger sources. 15 – 600 seconds."
        keywords={AUTOMATIONS_PANE_SEARCH_ENTRIES[0].keywords}
        className="flex items-center justify-between gap-4 px-1 py-2"
        id="automations-poll-interval"
      >
        <div className="space-y-0.5">
          <Label>Linear Poll Interval</Label>
          <p className="text-xs text-muted-foreground">
            How often Orca polls Linear for auto-trigger sources. 15 - 600 seconds. Default: 60.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            type="number"
            min={15}
            max={600}
            step={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitPollInterval}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitPollInterval()
              }
            }}
            aria-label="Linear poll interval in seconds"
            className="number-input-clean w-24 text-right tabular-nums"
          />
          <span className="text-xs text-muted-foreground">s</span>
        </div>
      </SearchableSetting>
    </div>
  )
}

export function AutomationsPane(): React.JSX.Element {
  const pollIntervalSeconds = useAppStore(
    (s) => s.settings?.automationsPollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const httpConnections = useAppStore((s) => s.settings?.httpConnections ?? [])

  // Why: automations aren't in the global store, so fetch them here and
  // refresh on the existing `automations:changed` broadcast. The banner is
  // only worth showing when an enabled linear-issue trigger would actually
  // be paused.
  const [hasEnabledLinearTrigger, setHasEnabledLinearTrigger] = useState(false)
  useEffect(() => {
    let cancelled = false

    const refresh = async (): Promise<void> => {
      try {
        const automations = await window.api.automations.list()
        if (cancelled) {
          return
        }
        setHasEnabledLinearTrigger(hasAnyEnabledLinearIssueTrigger(automations))
      } catch {
        // Swallow — the banner is a passive hint. If listing fails we leave
        // the previous state in place instead of flashing the banner off.
      }
    }

    void refresh()
    const unsubscribe = window.api.automations.onChanged(() => {
      void refresh()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return (
    <div className="space-y-8">
      <AutomationsPaneView
        pollIntervalSeconds={pollIntervalSeconds}
        linearConnected={linearStatus.connected}
        hasEnabledLinearTrigger={hasEnabledLinearTrigger}
        onCommitPollInterval={(next) => {
          void updateSettings({ automationsPollIntervalSeconds: next })
        }}
      />
      <HttpConnectionsSection
        httpConnections={httpConnections}
        onChange={(next) => void updateSettings({ httpConnections: next })}
      />
    </div>
  )
}
