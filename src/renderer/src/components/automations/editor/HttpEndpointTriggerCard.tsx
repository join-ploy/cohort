import * as React from 'react'
import { Globe, Loader2, Lock, Plus, Trash2, Unlock, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Separator } from '@/components/ui/separator'
import {
  HTTP_SECRET_MASK,
  type AutoTrigger,
  type HttpKeyValue,
  type HttpMethod,
  type MappedField
} from '../../../../../shared/automations-types'
import {
  detectArrayPaths,
  flattenItem,
  parseDateValue,
  resolveItems
} from '../../../../../shared/http-endpoint-mapping'
import {
  addQuery,
  addHeader,
  applyTestMapping,
  removeHeader,
  removeQuery,
  renameField,
  setDateGateField,
  setDedupeFields,
  setIntervalMs,
  setLabelField,
  setManualEnabled,
  setPollingEnabled,
  setRequestField,
  setSubtitleField,
  toggleBodySecret,
  toggleFieldEnabled,
  toggleHeaderSecret,
  updateHeader,
  updateQuery
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

export type HttpEndpointTriggerCardProps = {
  trigger: AutoTrigger
  onChange: (next: AutoTrigger) => void
  onRemove: () => void
  /** Owning automation id — forwarded to the Test IPC so the main process can
   *  decrypt this trigger's sealed secrets. Empty string when unsaved. */
  automationId: string
  /** Used for the per-rule project picker in the conditions section. */
  projects: { id: string; displayName: string }[]
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const INTERVAL_OPTIONS: { label: string; ms: number | undefined }[] = [
  { label: 'Default', ms: undefined },
  { label: '30 seconds', ms: 30_000 },
  { label: '1 minute', ms: 60_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '15 minutes', ms: 900_000 }
]

// HTTP fields have no option lookups, so the conditions UI never fetches.
const noopLoadOptions: LoadOptionsFn = () => Promise.resolve([])

// Why: variableNames must be unique among ENABLED fields — the condition catalog
// and downstream `trigger.http.<name>` resolution key on them, and
// defaultVariableName can collapse distinct paths (e.g. `a.b` and `a_b`) to the
// same name. Returns the names that collide so the card can flag them.
export function findDuplicateVariableNames(fields: MappedField[]): string[] {
  const counts = new Map<string, number>()
  for (const f of fields) {
    if (!f.enabled) {
      continue
    }
    counts.set(f.variableName, (counts.get(f.variableName) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name)
}

function formatSample(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (value === undefined) {
    return '—'
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {children}
    </p>
  )
}

type KeyValueRowProps = {
  pair: HttpKeyValue
  rowLabel: string
  onKeyChange: (key: string) => void
  onValueChange: (value: string) => void
  onRemove: () => void
  onToggleSecret?: () => void
}

function KeyValueRow(props: KeyValueRowProps): React.JSX.Element {
  const { pair, rowLabel } = props
  // Why: a sealed secret arrives from main as the mask sentinel — show it as
  // "set" and disabled so the user can't silently overwrite it by tabbing
  // through; an explicit Replace clears it back to an editable field.
  const masked = pair.secret === true && pair.value === HTTP_SECRET_MASK
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={`${rowLabel} key`}
        value={pair.key}
        placeholder="Key"
        onChange={(e) => props.onKeyChange(e.target.value)}
        className="h-8 flex-1 text-xs"
      />
      {masked ? (
        <div className="flex h-8 flex-1 items-center gap-2 rounded-md border border-input bg-muted/30 px-3 text-xs text-muted-foreground">
          <Lock className="size-3" />
          <span className="flex-1">•••• (set)</span>
          <button
            type="button"
            className="cursor-pointer font-medium text-foreground hover:underline"
            onClick={() => props.onValueChange('')}
          >
            Replace
          </button>
        </div>
      ) : (
        <Input
          aria-label={`${rowLabel} value`}
          value={pair.value}
          placeholder={pair.secret ? 'Secret value' : 'Value'}
          onChange={(e) => props.onValueChange(e.target.value)}
          className="h-8 flex-1 text-xs"
        />
      )}
      {props.onToggleSecret ? (
        <Button
          type="button"
          variant={pair.secret ? 'secondary' : 'ghost'}
          size="icon-xs"
          aria-label={`Toggle ${rowLabel} secret`}
          aria-pressed={pair.secret ?? false}
          title={pair.secret ? 'Secret — encrypted at rest' : 'Mark as secret'}
          onClick={props.onToggleSecret}
        >
          {pair.secret ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${rowLabel}`}
        onClick={props.onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

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
  const { trigger, onChange, onRemove, automationId, projects } = props
  const http = trigger.http

  // Why: persisted sample drives the items dropdown + remapping offline, so
  // seed from it; a fresh Test overwrites it. Status badge tracks only the live
  // request so a reopened card doesn't show a stale "200".
  const [sampleBody, setSampleBody] = React.useState<unknown>(http?.sampleResponse)
  const [lastTest, setLastTest] = React.useState<{
    status: number
    durationMs: number
  } | null>(null)
  const [testing, setTesting] = React.useState(false)
  const [testError, setTestError] = React.useState<string | null>(null)
  const [manualPath, setManualPath] = React.useState('')

  const arrayCandidates = React.useMemo(
    () => (sampleBody === undefined ? [] : detectArrayPaths(sampleBody)),
    [sampleBody]
  )
  const fieldCatalog = React.useMemo(() => (http ? httpFieldsToCatalog(http.fields) : []), [http])
  const duplicateNames = React.useMemo(
    () => (http ? findDuplicateVariableNames(http.fields) : []),
    [http]
  )
  const duplicateSet = React.useMemo(() => new Set(duplicateNames), [duplicateNames])

  if (!http) {
    // Why: this card only renders for http-endpoint triggers, which always carry
    // a config; guard so a malformed trigger degrades instead of crashing.
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
        This trigger is missing its HTTP configuration.
      </div>
    )
  }

  const request = http.request
  // Why: the whole-item + array outputs (json) are usable as variables but not as
  // dedupe keys, date gates, or picker labels — those need scalar leaf fields.
  const scalarFields = http.fields.filter((f) => f.enabled && f.type !== 'json')

  const onTest = async (): Promise<void> => {
    setTesting(true)
    setTestError(null)
    try {
      const res = await window.api.httpEndpoint.test({
        request,
        automationId,
        autoTriggerId: trigger.id
      })
      setSampleBody(res.body)
      setLastTest({ status: res.status, durationMs: res.durationMs })
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err))
      // Why: a failed Test must not leave a stale success badge next to the error.
      setLastTest(null)
    } finally {
      setTesting(false)
    }
  }

  // Why: re-flatten the chosen item and let applyTestMapping merge it against the
  // prior fields so existing enable/rename choices survive a re-Test (drift).
  const applyItemsPath = (itemsPath: string | null): void => {
    if (sampleBody === undefined) {
      return
    }
    const items = resolveItems(sampleBody, itemsPath)
    const discovered = flattenItem(items[0] ?? sampleBody)
    onChange(
      applyTestMapping(trigger, {
        itemsPath,
        fields: discovered,
        sampleResponse: sampleBody
      })
    )
  }

  const itemsToken = http.itemsPath === null ? 'whole' : `path:${http.itemsPath}`
  const candidateTokens = new Set(arrayCandidates.map((c) => `path:${c.path}`))
  const onItemsSelect = (token: string): void => {
    if (token === 'whole') {
      applyItemsPath(null)
    } else if (token.startsWith('path:')) {
      applyItemsPath(token.slice('path:'.length))
    }
  }

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

        {/* 2. Request */}
        <div className="space-y-2">
          <SectionHeading>Request</SectionHeading>
          <div className="flex items-center gap-2">
            <NativeSelect
              ariaLabel="Method"
              value={request.method}
              onChange={(method) =>
                onChange(setRequestField(trigger, { method: method as HttpMethod }))
              }
            >
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
            <Input
              aria-label="URL"
              value={request.url}
              placeholder="https://api.example.com/items"
              onChange={(e) => onChange(setRequestField(trigger, { url: e.target.value }))}
              className="h-8 flex-1 text-xs"
            />
          </div>

          <div className="space-y-1.5">
            {/* Why: block label (not inline span) so the Add button below doesn't
                collapse onto the label's line when there are no rows yet. */}
            <p className="text-[11px] font-medium text-muted-foreground">Headers</p>
            {request.headers.map((h, i) => (
              <KeyValueRow
                key={i}
                pair={h}
                rowLabel="Header"
                onKeyChange={(key) => onChange(updateHeader(trigger, i, { key }))}
                onValueChange={(value) => onChange(updateHeader(trigger, i, { value }))}
                onToggleSecret={() => onChange(toggleHeaderSecret(trigger, i))}
                onRemove={() => onChange(removeHeader(trigger, i))}
              />
            ))}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onChange(addHeader(trigger))}
            >
              <Plus className="size-3" />
              Add header
            </Button>
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-muted-foreground">Query parameters</p>
            {request.query.map((q, i) => (
              <KeyValueRow
                key={i}
                pair={q}
                rowLabel="Query"
                onKeyChange={(key) => onChange(updateQuery(trigger, i, { key }))}
                onValueChange={(value) => onChange(updateQuery(trigger, i, { value }))}
                onRemove={() => onChange(removeQuery(trigger, i))}
              />
            ))}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onChange(addQuery(trigger))}
            >
              <Plus className="size-3" />
              Add query parameter
            </Button>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium text-muted-foreground">Body (optional)</p>
              <Button
                type="button"
                variant={request.bodySecret ? 'secondary' : 'ghost'}
                size="xs"
                aria-label="Toggle body secret"
                aria-pressed={request.bodySecret ?? false}
                onClick={() => onChange(toggleBodySecret(trigger))}
              >
                {request.bodySecret ? <Lock className="size-3" /> : <Unlock className="size-3" />}
                Secret
              </Button>
            </div>
            {request.bodySecret && request.body === HTTP_SECRET_MASK ? (
              <div className="flex items-center gap-2 rounded-md border border-input bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <Lock className="size-3" />
                <span className="flex-1">•••• (set)</span>
                <button
                  type="button"
                  className="cursor-pointer font-medium text-foreground hover:underline"
                  onClick={() => onChange(setRequestField(trigger, { body: '' }))}
                >
                  Replace
                </button>
              </div>
            ) : (
              <textarea
                aria-label="Body"
                value={request.body ?? ''}
                placeholder='{"key": "value"}'
                rows={3}
                onChange={(e) => onChange(setRequestField(trigger, { body: e.target.value }))}
                className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            )}
          </div>
        </div>

        <Separator />

        {/* 3. Test */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" size="xs" disabled={testing} onClick={onTest}>
              {testing ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />}
              Test
            </Button>
            {lastTest ? (
              <Badge
                variant={
                  lastTest.status >= 200 && lastTest.status < 300 ? 'secondary' : 'destructive'
                }
                className="font-normal"
              >
                {lastTest.status} · {lastTest.durationMs}ms
              </Badge>
            ) : null}
          </div>
          {testError ? <p className="text-xs text-destructive">{testError}</p> : null}

          {sampleBody !== undefined ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">Items</p>
              <NativeSelect ariaLabel="Items path" value={itemsToken} onChange={onItemsSelect}>
                <option value="whole">Whole response is a single item</option>
                {arrayCandidates.map((c) => (
                  <option key={c.path} value={`path:${c.path}`}>
                    {c.path === '' ? '(top-level array)' : c.path} · {c.length} items
                  </option>
                ))}
                {http.itemsPath !== null && !candidateTokens.has(itemsToken) ? (
                  <option value={itemsToken}>{http.itemsPath} (current)</option>
                ) : null}
              </NativeSelect>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Manual items path"
                  value={manualPath}
                  placeholder="Or enter a dot-path, e.g. data.results"
                  onChange={(e) => setManualPath(e.target.value)}
                  className="h-8 flex-1 text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={manualPath === ''}
                  onClick={() => applyItemsPath(manualPath)}
                >
                  Apply
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* 4. Field mapping checklist */}
        {http.fields.length > 0 ? (
          <>
            <Separator />
            <div className="space-y-2">
              <SectionHeading>Fields</SectionHeading>
              {duplicateNames.length > 0 ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Duplicate variable name
                  {duplicateNames.length === 1 ? '' : 's'}: {duplicateNames.join(', ')}. Each
                  enabled field needs a unique name.
                </p>
              ) : null}
              <ul className="space-y-1.5">
                {http.fields.map((field) => {
                  const isDuplicate = field.enabled && duplicateSet.has(field.variableName)
                  return (
                    <li key={field.path} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={`Enable ${field.path}`}
                        checked={field.enabled}
                        onChange={() => onChange(toggleFieldEnabled(trigger, field.path))}
                        className="size-4 cursor-pointer rounded border-input"
                      />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-mono text-xs">
                          {field.path === '' ? '(whole item)' : field.path}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {formatSample(field.sampleValue)}
                        </span>
                      </div>
                      <Input
                        aria-label={`Variable name for ${field.path}`}
                        value={field.variableName}
                        aria-invalid={isDuplicate}
                        onChange={(e) => onChange(renameField(trigger, field.path, e.target.value))}
                        className="h-8 w-40 text-xs"
                      />
                    </li>
                  )
                })}
              </ul>
            </div>
          </>
        ) : null}

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
