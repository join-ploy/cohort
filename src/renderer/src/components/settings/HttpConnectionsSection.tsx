import React, { useCallback, useEffect, useState } from 'react'
import { Lock, Plus, Trash2, Unlock } from 'lucide-react'
import {
  HTTP_SECRET_MASK,
  type HttpConnection,
  type HttpKeyValue
} from '../../../../shared/automations-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { AUTOMATIONS_PANE_SEARCH_ENTRIES } from './automations-search'

type HttpConnectionsSectionProps = {
  httpConnections: HttpConnection[]
  onChange: (next: HttpConnection[]) => void
}

export function HttpConnectionsSection({
  httpConnections,
  onChange
}: HttpConnectionsSectionProps): React.JSX.Element {
  const handleAdd = useCallback(() => {
    const next: HttpConnection = {
      // Why: stable id minted up front so list keys and secret mask-reuse
      // correlation survive reorders/renames (displayName can be edited/blank).
      id: globalThis.crypto.randomUUID(),
      displayName: 'New connection',
      baseUrl: '',
      headers: []
    }
    onChange([...httpConnections, next])
  }, [httpConnections, onChange])

  const entry = AUTOMATIONS_PANE_SEARCH_ENTRIES[2]

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">HTTP Connections</h3>
        <p className="text-xs text-muted-foreground">
          Reusable base URL + headers (including secret auth) that HTTP triggers and request steps
          can point at by reference. Secrets are encrypted at rest.
        </p>
      </div>

      <SearchableSetting
        title={entry.title}
        description={entry.description}
        keywords={entry.keywords}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <h5 className="text-sm font-semibold">HTTP Connections</h5>
              <p className="text-xs text-muted-foreground">
                Define a connection once, then reference it from HTTP triggers and request steps.
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={handleAdd} className="gap-2">
              <Plus className="size-3.5" />
              Add
            </Button>
          </div>

          {httpConnections.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/60 bg-background/50 px-3 py-4 text-center text-xs text-muted-foreground">
              No connections configured. Click <span className="font-medium">Add</span> to create
              one.
            </p>
          ) : (
            <div className="space-y-3">
              {httpConnections.map((conn) => (
                <ConnectionEditor
                  key={conn.id}
                  value={conn}
                  onChange={(next) =>
                    onChange(httpConnections.map((c) => (c.id === conn.id ? next : c)))
                  }
                  onDelete={() => onChange(httpConnections.filter((c) => c.id !== conn.id))}
                />
              ))}
            </div>
          )}
        </div>
      </SearchableSetting>
    </section>
  )
}

type ConnectionEditorProps = {
  value: HttpConnection
  onChange: (next: HttpConnection) => void
  onDelete: () => void
}

function ConnectionEditor({ value, onChange, onDelete }: ConnectionEditorProps): React.JSX.Element {
  // Why: draft free-text edits locally and commit on blur so each keystroke
  // doesn't round-trip through updateSettings (IPC + secret re-seal on save).
  const [nameDraft, setNameDraft] = useState(value.displayName)
  const [urlDraft, setUrlDraft] = useState(value.baseUrl)

  useEffect(() => {
    setNameDraft(value.displayName)
  }, [value.id, value.displayName])
  useEffect(() => {
    setUrlDraft(value.baseUrl)
  }, [value.id, value.baseUrl])

  const commitName = useCallback(() => {
    if (nameDraft !== value.displayName) {
      onChange({ ...value, displayName: nameDraft })
    }
  }, [nameDraft, onChange, value])
  const commitUrl = useCallback(() => {
    if (urlDraft !== value.baseUrl) {
      onChange({ ...value, baseUrl: urlDraft })
    }
  }, [urlDraft, onChange, value])

  const addHeader = useCallback(() => {
    const header: HttpKeyValue = {
      id: globalThis.crypto.randomUUID(),
      key: '',
      value: '',
      secret: false
    }
    onChange({ ...value, headers: [...value.headers, header] })
  }, [onChange, value])

  return (
    <div className="space-y-3 rounded-xl border border-border/40 bg-background/60 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-1">
          <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Name
          </Label>
          <Input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            placeholder="Production API"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Base URL
          </Label>
          <Input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={commitUrl}
            placeholder="https://api.example.com"
            className="h-8 font-mono text-xs"
          />
        </div>
        <div className="flex items-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            aria-label={`Delete ${value.displayName || 'connection'}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        {/* Block label (not inline) so the Add button doesn't collapse onto the
            label's line when there are no header rows yet. */}
        <p className="text-[11px] font-medium text-muted-foreground">Headers</p>
        {value.headers.map((header) => (
          <HeaderRow
            key={header.id}
            pair={header}
            onChange={(next) =>
              onChange({ ...value, headers: value.headers.map((h) => (h === header ? next : h)) })
            }
            onRemove={() =>
              onChange({ ...value, headers: value.headers.filter((h) => h !== header) })
            }
          />
        ))}
        <Button type="button" variant="outline" size="xs" onClick={addHeader}>
          <Plus className="size-3.5" />
          Add header
        </Button>
      </div>
    </div>
  )
}

type HeaderRowProps = {
  pair: HttpKeyValue
  onChange: (next: HttpKeyValue) => void
  onRemove: () => void
}

function HeaderRow({ pair, onChange, onRemove }: HeaderRowProps): React.JSX.Element {
  // Why: key/value are free-text — draft and commit on blur. The discrete
  // actions (toggle secret, Replace, remove) commit immediately.
  const [keyDraft, setKeyDraft] = useState(pair.key)
  const [valueDraft, setValueDraft] = useState(pair.value)

  useEffect(() => {
    setKeyDraft(pair.key)
  }, [pair.id, pair.key])
  useEffect(() => {
    setValueDraft(pair.value)
  }, [pair.id, pair.value])

  const commitKey = useCallback(() => {
    if (keyDraft !== pair.key) {
      onChange({ ...pair, key: keyDraft })
    }
  }, [keyDraft, onChange, pair])
  const commitValue = useCallback(() => {
    if (valueDraft !== pair.value) {
      onChange({ ...pair, value: valueDraft })
    }
  }, [valueDraft, onChange, pair])

  // Why: a sealed secret arrives from main as the mask sentinel — show it as
  // "set" and disabled so the user can't silently overwrite it by tabbing
  // through; an explicit Replace clears it back to an editable field.
  const masked = pair.secret === true && pair.value === HTTP_SECRET_MASK

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Header key"
        value={keyDraft}
        placeholder="Key"
        onChange={(e) => setKeyDraft(e.target.value)}
        onBlur={commitKey}
        className="h-8 flex-1 text-xs"
      />
      {masked ? (
        <div className="flex h-8 flex-1 items-center gap-2 rounded-md border border-input bg-muted/30 px-3 text-xs text-muted-foreground">
          <Lock className="size-3" />
          <span className="flex-1">•••• (set)</span>
          <button
            type="button"
            className="cursor-pointer font-medium text-foreground hover:underline"
            onClick={() => onChange({ ...pair, value: '' })}
          >
            Replace
          </button>
        </div>
      ) : (
        <Input
          aria-label="Header value"
          value={valueDraft}
          placeholder={pair.secret ? 'Secret value' : 'Value'}
          onChange={(e) => setValueDraft(e.target.value)}
          onBlur={commitValue}
          className="h-8 flex-1 text-xs"
        />
      )}
      <Button
        type="button"
        variant={pair.secret ? 'secondary' : 'ghost'}
        size="icon-xs"
        aria-label="Toggle Header secret"
        aria-pressed={pair.secret ?? false}
        title={pair.secret ? 'Secret — encrypted at rest' : 'Mark as secret'}
        onClick={() => onChange({ ...pair, secret: !(pair.secret ?? false) })}
      >
        {pair.secret ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Remove Header"
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}
