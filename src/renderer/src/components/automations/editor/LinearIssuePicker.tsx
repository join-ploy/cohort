import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Search } from 'lucide-react'
import { useAppStore } from '@/store'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { cn } from '@/lib/utils'
import type { LinearIssue, LinearConnectionStatus } from '../../../../../shared/types'
import type { LinearIssuePayload } from '../../../../../shared/automations-types'
import type { CacheEntry } from '@/store/slices/github'

const SEARCH_DEBOUNCE_MS = 200
const RESULT_LIMIT = 20

export type LinearIssuePickerProps = {
  onSelect: (payload: LinearIssuePayload) => void
  onCancel?: () => void
  className?: string
}

/**
 * Map a Linear issue (rich shape from the IPC layer) to the trimmed payload
 * shape we materialize into `run.context.trigger.linear.issue`. The Linear
 * issue type does not currently carry the assignee email — we leave it blank
 * here and let downstream consumers fall back to `{{trigger.linear.issue.assigneeEmail}}`
 * yielding the empty string. If the IPC layer starts returning the email,
 * extend the source type and surface it here.
 */
export function toLinearIssuePayload(issue: LinearIssue): LinearIssuePayload {
  return {
    id: issue.id,
    identifier: issue.identifier ?? '',
    title: issue.title ?? '',
    description: issue.description ?? '',
    url: issue.url ?? '',
    assigneeEmail: '',
    stateName: issue.state?.name ?? '',
    priority: issue.priority ?? 0
  }
}

export function LinearIssuePicker(props: LinearIssuePickerProps): React.JSX.Element {
  const linearStatus = useAppStore((s) => s.linearStatus) as LinearConnectionStatus
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked) as boolean
  const linearSearchCache = useAppStore((s) => s.linearSearchCache) as Record<
    string,
    CacheEntry<LinearIssue[]>
  >
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection) as () => Promise<void>
  const searchLinearIssues = useAppStore((s) => s.searchLinearIssues) as (
    query: string,
    limit?: number
  ) => Promise<LinearIssue[]>
  const listLinearIssues = useAppStore((s) => s.listLinearIssues) as (
    filter?: 'assigned' | 'created' | 'all' | 'completed',
    limit?: number
  ) => Promise<LinearIssue[]>
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget) as (target: {
    pane: 'accounts'
    repoId: null
  }) => void

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [commandValue, setCommandValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Why: a freshly-opened modal can flash the disconnected state while a
  // Linear token actually exists — refresh status once per mount.
  useEffect(() => {
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
  }, [checkLinearConnection, linearStatusChecked])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!linearStatus.connected) {
      return
    }
    let stale = false
    setLoading(true)
    const trimmed = debouncedQuery.trim()
    const request =
      trimmed.length > 0
        ? searchLinearIssues(trimmed, RESULT_LIMIT)
        : listLinearIssues('assigned', RESULT_LIMIT)
    void request
      .catch(() => {
        // Results are read from the cache below; swallow rejections to avoid
        // an unhandled promise on transient failures.
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
    // Why: list/search actions are stable store methods; depending on them
    // would refetch on unrelated store writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, linearStatus.connected])

  const results: LinearIssue[] = useMemo(() => {
    const trimmed = debouncedQuery.trim()
    const cacheKey =
      trimmed.length > 0 ? `${trimmed}::${RESULT_LIMIT}` : `list::assigned::${RESULT_LIMIT}`
    return linearSearchCache[cacheKey]?.data ?? []
  }, [debouncedQuery, linearSearchCache])

  // Why: when the typed value is an unambiguous Linear identifier ("STA-123"),
  // the user is looking up that specific issue rather than browsing — snap the
  // highlight onto the matching row so Enter picks it.
  const linearIntent = useMemo(() => /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(query.trim()), [query])

  useEffect(() => {
    if (results.length === 0) {
      setCommandValue('')
      return
    }
    if (linearIntent) {
      const target = query.trim().toLowerCase()
      const exact = results.find((issue) => (issue.identifier ?? '').toLowerCase() === target)
      if (exact) {
        setCommandValue(`linear-${exact.id}`)
        return
      }
    }
    setCommandValue((current) =>
      results.some((issue) => `linear-${issue.id}` === current)
        ? current
        : `linear-${results[0].id}`
    )
  }, [linearIntent, query, results])

  if (!linearStatus.connected) {
    return (
      <div className={cn('flex flex-col gap-2 p-3 text-xs', props.className)}>
        <p className="text-muted-foreground">Linear is not connected.</p>
        <button
          type="button"
          onClick={() => openSettingsTarget({ pane: 'accounts', repoId: null })}
          className="self-start text-primary underline-offset-2 hover:underline"
        >
          Connect Linear in Settings
        </button>
      </div>
    )
  }

  const ActiveIcon = loading ? LoaderCircle : Search

  const handleSelect = (issue: LinearIssue): void => {
    props.onSelect(toLinearIssuePayload(issue))
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
            ref={inputRef}
            aria-label="Search Linear issues"
            placeholder="Search Linear issues…"
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
                const row = results.find((issue) => `linear-${issue.id}` === commandValue)
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
          {loading && results.length === 0 ? (
            <div className="space-y-1 p-1">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-8 animate-pulse rounded bg-muted/40" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {query.trim().length > 0
                ? 'No issues match.'
                : 'Start typing to search Linear issues.'}
            </div>
          ) : (
            <CommandGroup className="p-1">
              {results.map((issue) => (
                <CommandItem
                  key={issue.id}
                  value={`linear-${issue.id}`}
                  data-linear-issue-id={issue.id}
                  onSelect={() => handleSelect(issue)}
                  className="gap-2 px-2 py-1.5 text-xs"
                >
                  <LinearIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="font-mono text-muted-foreground">{issue.identifier}</span>
                      <span className="truncate font-medium text-foreground">{issue.title}</span>
                    </span>
                    <span className="text-muted-foreground">{issue.state?.name ?? ''}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
      {props.onCancel ? (
        <button
          type="button"
          onClick={props.onCancel}
          className="self-end text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      ) : null}
    </div>
  )
}
