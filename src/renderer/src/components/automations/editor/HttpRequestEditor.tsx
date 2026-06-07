import * as React from 'react'
import { Loader2, Lock, Plus, Trash2, Unlock, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Separator } from '@/components/ui/separator'
import {
  HTTP_SECRET_MASK,
  type HttpConnection,
  type HttpKeyValue,
  type HttpMethod,
  type HttpRequestConfig,
  type MappedField
} from '../../../../../shared/automations-types'
import {
  detectArrayPaths,
  flattenItem,
  resolveItems
} from '../../../../../shared/http-endpoint-mapping'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { TemplateInput } from './TemplateInput'
import {
  addHeader,
  addQuery,
  applyTestMapping,
  removeHeader,
  removeQuery,
  renameField,
  setConnectionId,
  setRequestField,
  toggleBodySecret,
  toggleFieldEnabled,
  toggleHeaderSecret,
  updateHeader,
  updateQuery,
  type HttpRequestEditorValue
} from './http-request-editor-state'
import { SectionHeading } from './SectionHeading'

// The Test IPC's response triple. Declared locally because the shared
// HttpEndpointResponse type lives in main and isn't exposed to the renderer.
type HttpTestResult = { status: number; durationMs: number; body: unknown }

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

export type HttpRequestEditorProps = {
  value: HttpRequestEditorValue
  onChange: (next: HttpRequestEditorValue) => void
  httpConnections: HttpConnection[]
  // When provided (step context), the path/URL field becomes a TemplateInput with
  // the {{…}} variable picker so previous-step outputs can be referenced. Omitted
  // in the trigger context, where no prior steps exist to template from.
  available?: AvailableVariables
  // Decoupled Test: the trigger supplies a wrapper around window.api.httpEndpoint.test
  // that adds automationId/autoTriggerId; the step will supply its own.
  onTest: (args: { request: HttpRequestConfig; connectionId?: string }) => Promise<HttpTestResult>
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

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

export function HttpRequestEditor(props: HttpRequestEditorProps): React.JSX.Element {
  const { value, onChange, httpConnections, available } = props
  const request = value.request

  // Why: persisted sample drives the items dropdown + remapping offline, so
  // seed from it; a fresh Test overwrites it. Status badge tracks only the live
  // request so a reopened card doesn't show a stale "200".
  const [sampleBody, setSampleBody] = React.useState<unknown>(value.sampleResponse)
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
  const duplicateNames = React.useMemo(
    () => findDuplicateVariableNames(value.fields),
    [value.fields]
  )
  const duplicateSet = React.useMemo(() => new Set(duplicateNames), [duplicateNames])

  // A dangling connectionId (connection deleted, no D7 validation yet) resolves to
  // undefined, which falls the field back to absolute-URL labeling — acceptable.
  const connection = value.connectionId
    ? httpConnections.find((c) => c.id === value.connectionId)
    : undefined

  const onTest = async (): Promise<void> => {
    setTesting(true)
    setTestError(null)
    try {
      const res = await props.onTest({ request: value.request, connectionId: value.connectionId })
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
      applyTestMapping(value, {
        itemsPath,
        fields: discovered,
        sampleResponse: sampleBody
      })
    )
  }

  const itemsToken = value.itemsPath === null ? 'whole' : `path:${value.itemsPath}`
  const candidateTokens = new Set(arrayCandidates.map((c) => `path:${c.path}`))
  const onItemsSelect = (token: string): void => {
    if (token === 'whole') {
      applyItemsPath(null)
    } else if (token.startsWith('path:')) {
      applyItemsPath(token.slice('path:'.length))
    }
  }

  return (
    <>
      {/* 2. Request */}
      <div className="space-y-2">
        <SectionHeading>Request</SectionHeading>
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">Connection</p>
          <NativeSelect
            ariaLabel="Connection"
            value={value.connectionId ?? ''}
            onChange={(id) => onChange(setConnectionId(value, id === '' ? undefined : id))}
          >
            <option value="">None — inline URL</option>
            {httpConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex items-center gap-2">
          <NativeSelect
            ariaLabel="Method"
            value={request.method}
            onChange={(method) =>
              onChange(setRequestField(value, { method: method as HttpMethod }))
            }
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </NativeSelect>
          {available ? (
            <TemplateInput
              ariaLabel={connection ? 'Path' : 'URL'}
              value={request.url}
              placeholder={connection ? '/items' : 'https://api.example.com/items'}
              onChange={(url) => onChange(setRequestField(value, { url }))}
              available={available}
              className="flex-1"
            />
          ) : (
            <Input
              aria-label={connection ? 'Path' : 'URL'}
              value={request.url}
              placeholder={connection ? '/items' : 'https://api.example.com/items'}
              onChange={(e) => onChange(setRequestField(value, { url: e.target.value }))}
              className="h-8 flex-1 text-xs"
            />
          )}
        </div>
        {connection ? (
          <p className="text-[11px] text-muted-foreground">
            Joined to {connection.baseUrl} · headers from {connection.displayName}
          </p>
        ) : null}

        <div className="space-y-1.5">
          {/* Why: block label (not inline span) so the Add button below doesn't
              collapse onto the label's line when there are no rows yet. */}
          <p className="text-[11px] font-medium text-muted-foreground">Headers</p>
          {request.headers.map((h, i) => (
            <KeyValueRow
              key={i}
              pair={h}
              rowLabel="Header"
              onKeyChange={(key) => onChange(updateHeader(value, i, { key }))}
              onValueChange={(v) => onChange(updateHeader(value, i, { value: v }))}
              onToggleSecret={() => onChange(toggleHeaderSecret(value, i))}
              onRemove={() => onChange(removeHeader(value, i))}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onChange(addHeader(value))}
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
              onKeyChange={(key) => onChange(updateQuery(value, i, { key }))}
              onValueChange={(v) => onChange(updateQuery(value, i, { value: v }))}
              onRemove={() => onChange(removeQuery(value, i))}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onChange(addQuery(value))}
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
              onClick={() => onChange(toggleBodySecret(value))}
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
                onClick={() => onChange(setRequestField(value, { body: '' }))}
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
              onChange={(e) => onChange(setRequestField(value, { body: e.target.value }))}
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
              {value.itemsPath !== null && !candidateTokens.has(itemsToken) ? (
                <option value={itemsToken}>{value.itemsPath} (current)</option>
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
      {value.fields.length > 0 ? (
        <>
          <Separator />
          <div className="space-y-2">
            <SectionHeading>Fields</SectionHeading>
            {duplicateNames.length > 0 ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                Duplicate variable name
                {duplicateNames.length === 1 ? '' : 's'}: {duplicateNames.join(', ')}. Each enabled
                field needs a unique name.
              </p>
            ) : null}
            <ul className="space-y-1.5">
              {value.fields.map((field) => {
                const isDuplicate = field.enabled && duplicateSet.has(field.variableName)
                return (
                  <li key={field.path} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Enable ${field.path}`}
                      checked={field.enabled}
                      onChange={() => onChange(toggleFieldEnabled(value, field.path))}
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
                      onChange={(e) => onChange(renameField(value, field.path, e.target.value))}
                      className="h-8 w-40 text-xs"
                    />
                  </li>
                )
              })}
            </ul>
          </div>
        </>
      ) : null}
    </>
  )
}
