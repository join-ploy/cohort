import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Globe, LoaderCircle, Search } from 'lucide-react'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { HttpEndpointItem } from '../../../../../shared/automations-types'

export type HttpEndpointItemPickerProps = {
  automationId: string
  autoTriggerId: string
  onSelect: (vars: Record<string, unknown>) => void
  className?: string
}

/**
 * Run-time picker for a manual `http-endpoint` trigger: fetches the live items
 * from the endpoint once on mount and lets the operator pick one. The picked
 * item's mapped variables (`item.vars`) become `run.context.trigger.http.*`.
 *
 * Mirrors `LinearIssuePicker`'s structure, but the full list is already in
 * memory after the fetch, so filtering is a pure client-side substring match.
 */
export function HttpEndpointItemPicker(props: HttpEndpointItemPickerProps): React.JSX.Element {
  const { automationId, autoTriggerId } = props
  const [items, setItems] = useState<HttpEndpointItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')

  useEffect(() => {
    let stale = false
    setLoading(true)
    setError(null)
    window.api.httpEndpoint
      .fetchItems({ automationId, autoTriggerId })
      .then((fetched) => {
        if (!stale) {
          setItems(fetched)
        }
      })
      .catch((err: unknown) => {
        if (!stale) {
          setError(err instanceof Error ? err.message : 'Failed to load items.')
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [automationId, autoTriggerId])

  // Why: the full list is already in memory after the fetch, so a typed query
  // filters client-side — no per-keystroke round-trip to the endpoint.
  const results = useMemo(() => {
    const all = items ?? []
    const trimmed = query.trim().toLowerCase()
    if (trimmed.length === 0) {
      return all
    }
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(trimmed) || item.subtitle.toLowerCase().includes(trimmed)
    )
  }, [items, query])

  useEffect(() => {
    if (results.length === 0) {
      setCommandValue('')
      return
    }
    setCommandValue((current) =>
      results.some((item) => item.key === current) ? current : results[0].key
    )
  }, [results])

  const ActiveIcon = loading ? LoaderCircle : Search

  const handleSelect = (item: HttpEndpointItem): void => {
    props.onSelect(item.vars)
  }

  return (
    <div className={cn('flex flex-col gap-2', props.className)}>
      <Command
        value={commandValue}
        onValueChange={setCommandValue}
        shouldFilter={false}
        className="overflow-visible bg-transparent"
      >
        <div className="relative">
          <ActiveIcon
            className={cn(
              'pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground',
              loading && 'animate-spin'
            )}
          />
          <Input
            aria-label="Filter endpoint items"
            placeholder="Filter items…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                results.length > 0
              ) {
                const row = results.find((item) => item.key === commandValue)
                if (row) {
                  event.preventDefault()
                  handleSelect(row)
                }
              }
            }}
            className="h-9 pl-8 text-sm"
          />
        </div>
        <CommandList className="max-h-64 rounded-md border border-input scrollbar-sleek">
          {loading ? (
            <div role="status" aria-label="Loading endpoint items" className="space-y-1 p-1">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-8 animate-pulse rounded bg-muted/40" />
              ))}
            </div>
          ) : error !== null ? (
            <div className="px-3 py-6 text-center text-xs text-destructive">
              Failed to load items: {error}
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {query.trim().length > 0 ? 'No items match.' : 'No items returned.'}
            </div>
          ) : (
            <CommandGroup className="p-1">
              {results.map((item) => (
                <CommandItem
                  key={item.key}
                  value={item.key}
                  data-http-item-key={item.key}
                  onSelect={() => handleSelect(item)}
                  className="gap-2 px-2 py-1.5 text-xs"
                >
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium text-foreground">{item.label}</span>
                    <span className="truncate text-muted-foreground">{item.subtitle}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  )
}
