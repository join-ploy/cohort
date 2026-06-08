import * as React from 'react'
import { Globe, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Separator } from '@/components/ui/separator'
import {
  type AutoTrigger,
  type HttpConnection,
  type HttpRequestConfig
} from '../../../../../shared/automations-types'
import { parseDateValue } from '../../../../../shared/http-endpoint-mapping'
import {
  setDateGateField,
  setDedupeFields,
  setIdField,
  setIntervalMs,
  setLabelField,
  setManualEnabled,
  setPollingEnabled,
  setSubtitleField
} from './http-endpoint-card-state'
import { httpFieldsToCatalog } from './http-endpoint-field-catalog'
import {
  addCondition,
  addRule,
  removeCondition,
  removeRule,
  reorderRule,
  updateCondition,
  updateRule
} from './AutoTriggerCard'
import { AutoTriggerRuleRow } from './AutoTriggerRuleRow'
import type { LoadOptionsFn } from './ConditionRow'
import { HttpRequestEditor } from './HttpRequestEditor'
import { type HttpRequestEditorValue } from './http-request-editor-state'
import { SectionHeading } from './SectionHeading'

export type HttpEndpointTriggerCardProps = {
  trigger: AutoTrigger
  onChange: (next: AutoTrigger) => void
  onRemove: () => void
  /** Owning automation id — forwarded to the Test IPC so the main process can
   *  decrypt this trigger's sealed secrets. Empty string when unsaved. */
  automationId: string
  /** Used for the per-rule project picker in the conditions section. */
  projects: { id: string; displayName: string }[]
  /** Reusable connection library — the picker references one by id; when set, the
   *  URL field becomes a path joined to the connection's base URL. */
  httpConnections: HttpConnection[]
}

const INTERVAL_OPTIONS: { label: string; ms: number | undefined }[] = [
  { label: 'Default', ms: undefined },
  { label: '30 seconds', ms: 30_000 },
  { label: '1 minute', ms: 60_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '15 minutes', ms: 900_000 }
]

// HTTP fields have no option lookups, so the conditions UI never fetches.
const noopLoadOptions: LoadOptionsFn = () => Promise.resolve([])

type CapabilitySwitchProps = {
  label: string
  checked: boolean
  onChange: () => void
}

function CapabilitySwitch(props: CapabilitySwitchProps): React.JSX.Element {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2">
      <input
        type="checkbox"
        aria-label={props.label}
        checked={props.checked}
        onChange={props.onChange}
        className="size-4 cursor-pointer rounded border-input"
      />
      <span className="text-xs">{props.label}</span>
    </label>
  )
}

export function HttpEndpointTriggerCard(props: HttpEndpointTriggerCardProps): React.JSX.Element {
  const { trigger, onChange, onRemove, automationId, projects, httpConnections } = props
  const http = trigger.http

  const fieldCatalog = React.useMemo(() => (http ? httpFieldsToCatalog(http.fields) : []), [http])

  if (!http) {
    // Why: this card only renders for http-endpoint triggers, which always carry
    // a config; guard so a malformed trigger degrades instead of crashing.
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
        This trigger is missing its HTTP configuration.
      </div>
    )
  }

  // Why: the whole-item + array outputs (json) are usable as variables but not as
  // dedupe keys, date gates, or picker labels — those need scalar leaf fields.
  const scalarFields = http.fields.filter((f) => f.enabled && f.type !== 'json')

  // The shared editor owns the request/connection/Test/mapping slice; the
  // write-back preserves the trigger-only http fields (dedupe, gates, etc.).
  const editorValue: HttpRequestEditorValue = {
    connectionId: http.connectionId,
    request: http.request,
    itemsPath: http.itemsPath,
    fields: http.fields,
    sampleResponse: http.sampleResponse
  }
  const onEditorChange = (next: HttpRequestEditorValue): void => {
    onChange({
      ...trigger,
      http: {
        ...http,
        connectionId: next.connectionId,
        request: next.request,
        itemsPath: next.itemsPath,
        fields: next.fields,
        sampleResponse: next.sampleResponse
      }
    })
  }

  // Why: the trigger Test must scope to this trigger so main can decrypt its
  // sealed secrets; connectionId lets the picker's selection affect the Test.
  const onTest = ({
    request,
    connectionId
  }: {
    request: HttpRequestConfig
    connectionId?: string
  }): Promise<{ status: number; durationMs: number; body: unknown }> =>
    window.api.httpEndpoint.test({ request, automationId, autoTriggerId: trigger.id, connectionId })

  const toggleDedupe = (path: string): void => {
    const next = http.dedupeFields.includes(path)
      ? http.dedupeFields.filter((p) => p !== path)
      : [...http.dedupeFields, path]
    onChange(setDedupeFields(trigger, next))
  }

  const gateField = http.fields.find((f) => f.path === http.dateGateField)
  const gateParsed = gateField ? parseDateValue(gateField.sampleValue) : null

  return (
    <div
      aria-label={`auto trigger ${trigger.id}`}
      className="rounded-lg border border-border bg-card text-sm shadow-xs"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-muted-foreground" />
          <span className="font-medium">HTTP endpoint</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove trigger ${trigger.id}`}
          title="Remove trigger"
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-4 px-4 py-3">
        {/* 1. Capability switches */}
        <div className="flex flex-wrap items-center gap-4">
          <CapabilitySwitch
            label="Poll automatically"
            checked={trigger.pollingEnabled ?? false}
            onChange={() =>
              onChange(setPollingEnabled(trigger, !(trigger.pollingEnabled ?? false)))
            }
          />
          <CapabilitySwitch
            label="Allow manual run"
            checked={trigger.manualEnabled ?? false}
            onChange={() => onChange(setManualEnabled(trigger, !(trigger.manualEnabled ?? false)))}
          />
        </div>

        <Separator />

        {/* 2-4. Shared request builder + Test + field mapping */}
        <HttpRequestEditor
          value={editorValue}
          onChange={onEditorChange}
          httpConnections={httpConnections}
          onTest={onTest}
        />

        {/* 5. Poll settings */}
        {trigger.pollingEnabled ? (
          <>
            <Separator />
            <div className="space-y-3">
              <SectionHeading>Poll settings</SectionHeading>

              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Dedupe by fields</p>
                {scalarFields.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Map at least one field to pick dedupe keys.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {scalarFields.map((field) => (
                      <label
                        key={field.path}
                        className="flex cursor-pointer select-none items-center gap-2"
                      >
                        <input
                          type="checkbox"
                          aria-label={`Dedupe by ${field.path}`}
                          checked={http.dedupeFields.includes(field.path)}
                          onChange={() => toggleDedupe(field.path)}
                          className="size-4 cursor-pointer rounded border-input"
                        />
                        <span className="font-mono text-xs">{field.path}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Date gate</p>
                <div>
                  <NativeSelect
                    ariaLabel="Date gate field"
                    value={http.dateGateField ?? ''}
                    onChange={(v) => onChange(setDateGateField(trigger, v === '' ? null : v))}
                  >
                    <option value="">— None —</option>
                    {scalarFields.map((field) => (
                      <option key={field.path} value={field.path}>
                        {field.path}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {http.dateGateField !== null ? (
                  <p className="text-[11px] text-muted-foreground">
                    {gateParsed !== null
                      ? `Sample parses to ${new Date(gateParsed).toISOString()}`
                      : 'Sample value is not a recognizable date — items will be gated out.'}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Poll interval</p>
                <div>
                  <NativeSelect
                    ariaLabel="Poll interval"
                    value={http.intervalMs === undefined ? '' : String(http.intervalMs)}
                    onChange={(v) =>
                      onChange(setIntervalMs(trigger, v === '' ? undefined : Number(v)))
                    }
                  >
                    {INTERVAL_OPTIONS.map((opt) => (
                      <option key={opt.label} value={opt.ms === undefined ? '' : String(opt.ms)}>
                        {opt.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            </div>
          </>
        ) : null}

        {/* 6. Manual settings */}
        {trigger.manualEnabled ? (
          <>
            <Separator />
            <div className="space-y-3">
              <SectionHeading>Manual run picker</SectionHeading>
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Label field</p>
                <div>
                  <NativeSelect
                    ariaLabel="Label field"
                    value={http.labelField ?? ''}
                    onChange={(v) => onChange(setLabelField(trigger, v === '' ? undefined : v))}
                  >
                    <option value="">— None —</option>
                    {scalarFields.map((field) => (
                      <option key={field.path} value={field.path}>
                        {field.path}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Subtitle field</p>
                <div>
                  <NativeSelect
                    ariaLabel="Subtitle field"
                    value={http.subtitleField ?? ''}
                    onChange={(v) => onChange(setSubtitleField(trigger, v === '' ? undefined : v))}
                  >
                    <option value="">— None —</option>
                    {scalarFields.map((field) => (
                      <option key={field.path} value={field.path}>
                        {field.path}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Status match field</p>
                <div>
                  <NativeSelect
                    ariaLabel="Status match field"
                    value={http.idField ?? ''}
                    onChange={(v) => onChange(setIdField(trigger, v === '' ? undefined : v))}
                  >
                    <option value="">— None —</option>
                    {scalarFields.map((field) => (
                      <option key={field.path} value={field.path}>
                        {field.path}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Items whose runs share this field&apos;s value show a run-status mark.
                </p>
              </div>
            </div>
          </>
        ) : null}

        <Separator />

        {/* 7. Conditions (reuse the shared rules UI) */}
        <div className="space-y-2">
          <SectionHeading>Conditions</SectionHeading>
          {trigger.rules.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-background p-4 text-center">
              <p className="text-xs text-muted-foreground">
                No rules yet — add one to filter which polled items run.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {trigger.rules.map((rule, idx) => (
                <AutoTriggerRuleRow
                  key={rule.id}
                  rule={rule}
                  index={idx}
                  total={trigger.rules.length}
                  projects={projects}
                  fieldCatalog={fieldCatalog}
                  loadOptions={noopLoadOptions}
                  onProjectChange={(projectId) =>
                    onChange(updateRule(trigger, rule.id, { projectId }))
                  }
                  onMoveUp={() => onChange(reorderRule(trigger, idx, idx - 1))}
                  onMoveDown={() => onChange(reorderRule(trigger, idx, idx + 1))}
                  onDelete={() => onChange(removeRule(trigger, rule.id))}
                  onAddCondition={() => onChange(addCondition(trigger, rule.id, fieldCatalog))}
                  onRemoveCondition={(i) => onChange(removeCondition(trigger, rule.id, i))}
                  onUpdateCondition={(i, next) =>
                    onChange(updateCondition(trigger, rule.id, i, next))
                  }
                />
              ))}
            </ul>
          )}
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onChange(addRule(trigger))}
          >
            <Plus className="size-3" />
            Add rule
          </Button>
        </div>
      </div>
    </div>
  )
}
