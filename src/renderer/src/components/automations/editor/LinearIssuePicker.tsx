import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { LinearIssue, LinearConnectionStatus } from '../../../../../shared/types'
import type { LinearIssuePayload } from '../../../../../shared/automations-types'
import type { CacheEntry } from '@/store/slices/github'

const SEARCH_DEBOUNCE_MS = 250
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

  // Why: bring the connection state in sync once per mount. Mirrors the same
  // guard used by SmartWorkspaceNameField — without it, a freshly-opened modal
  // can flash the disconnected state while a token actually exists.
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
    const trimmed = debouncedQuery.trim()
    if (trimmed.length > 0) {
      void searchLinearIssues(trimmed, RESULT_LIMIT)
    } else {
      void listLinearIssues('assigned', RESULT_LIMIT)
    }
  }, [debouncedQuery, linearStatus.connected, searchLinearIssues, listLinearIssues])

  const results: LinearIssue[] = useMemo(() => {
    const trimmed = debouncedQuery.trim()
    const cacheKey =
      trimmed.length > 0 ? `${trimmed}::${RESULT_LIMIT}` : `list::assigned::${RESULT_LIMIT}`
    return linearSearchCache[cacheKey]?.data ?? []
  }, [debouncedQuery, linearSearchCache])

  const inputRef = useRef<HTMLInputElement | null>(null)

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

  return (
    <div className={cn('flex flex-col gap-2', props.className)}>
      <input
        ref={inputRef}
        type="text"
        aria-label="Search Linear issues"
        placeholder="Search Linear issues…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50"
      />
      <ul className="flex flex-col divide-y divide-border rounded-md border border-input">
        {results.length === 0 ? (
          <li className="px-2 py-2 text-xs text-muted-foreground">No issues.</li>
        ) : (
          results.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                data-linear-issue-id={issue.id}
                onClick={() => props.onSelect(toLinearIssuePayload(issue))}
                className="flex w-full flex-col gap-0.5 px-2 py-2 text-left text-xs hover:bg-accent"
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-muted-foreground">{issue.identifier}</span>
                  <span className="truncate font-medium text-foreground">{issue.title}</span>
                </span>
                <span className="text-muted-foreground">{issue.state?.name ?? ''}</span>
              </button>
            </li>
          ))
        )}
      </ul>
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
