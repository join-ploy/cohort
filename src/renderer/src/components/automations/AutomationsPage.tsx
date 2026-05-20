/* eslint-disable max-lines -- Why: this page owns the automations list/detail
 * orchestration alongside the delete-confirmation dialog while the chain
 * editor + detail presentation live in sibling files. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarClock, Check, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { useRepoMap, useWorktreeMap } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'
import { AutomationDetail } from './AutomationDetail'
import { ChainEditorModal } from './editor/ChainEditorModal'

const AUTOMATIONS_CHANGED_EVENT = 'orca:automations-changed'

export default function AutomationsPage(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  const settings = useAppStore((s) => s.settings)
  // Why: derive from the already-subscribed `settings` so we keep a single
  // store subscription and avoid creating a new empty-array reference each
  // render via a fallback inside the selector.
  const reviewCommands = settings?.reviewCommands ?? []
  const createPrCommands = settings?.createPrCommands ?? []
  const selectedId = useAppStore((s) => s.selectedAutomationId)
  const setSelectedId = useAppStore((s) => s.setSelectedAutomationId)
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()

  const [automations, setAutomations] = useState<Automation[]>([])
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingAutomation, setEditingAutomation] = useState<Automation | null>(null)
  const [relativeNow, setRelativeNow] = useState(Date.now())
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null)
  const [dontAskDeleteAgain, setDontAskDeleteAgain] = useState(false)
  const editRequestRef = useRef(0)
  const deleteConfirmButtonRef = useRef<HTMLButtonElement>(null)

  const selected =
    automations.find((automation) => automation.id === selectedId) ?? automations[0] ?? null
  const selectedRuns = runs.filter((run) => run.automationId === selected?.id)
  const selectedRepo = selected ? (repoMap.get(selected.projectId) ?? null) : null
  const selectedWorktree =
    selected && selected.workspaceId ? (worktreeMap.get(selected.workspaceId) ?? null) : null

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const [nextAutomations, nextRuns] = await Promise.all([
        window.api.automations.list(),
        window.api.automations.listRuns()
      ])
      setAutomations(nextAutomations)
      setRuns(nextRuns)
      const currentSelectedId = useAppStore.getState().selectedAutomationId
      const hasCurrentSelection = nextAutomations.some(
        (automation) => automation.id === currentSelectedId
      )
      if (!hasCurrentSelection) {
        setSelectedId(nextAutomations[0]?.id ?? null)
      }
    } finally {
      setIsLoading(false)
    }
  }, [setSelectedId])

  useEffect(() => {
    void fetchAllWorktrees()
    void refresh()
  }, [fetchAllWorktrees, refresh])

  useEffect(() => {
    const timer = window.setInterval(() => setRelativeNow(Date.now()), 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onAutomationsChanged = (): void => {
      void refresh()
    }
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
    return () => window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
  }, [refresh])

  useEffect(() => {
    const completedRuns = runs.filter((run) => {
      if (run.status !== 'dispatched' || !run.terminalSessionId) {
        return false
      }
      const paneKeyPrefix = `${run.terminalSessionId}:`
      const liveDone = Object.entries(agentStatusByPaneKey).some(
        ([paneKey, entry]) => paneKey.startsWith(paneKeyPrefix) && entry.state === 'done'
      )
      if (liveDone) {
        return true
      }
      return Object.entries(retainedAgentsByPaneKey).some(
        ([paneKey, retained]) =>
          paneKey.startsWith(paneKeyPrefix) && retained.entry.state === 'done'
      )
    })
    if (completedRuns.length === 0) {
      return
    }
    void Promise.all(
      completedRuns.map((run) =>
        window.api.automations.markDispatchResult({
          runId: run.id,
          status: 'completed',
          workspaceId: run.workspaceId,
          terminalSessionId: run.terminalSessionId,
          error: null
        })
      )
    ).then(() => refresh())
  }, [agentStatusByPaneKey, retainedAgentsByPaneKey, refresh, runs])

  const openCreateDialog = (): void => {
    editRequestRef.current += 1
    setEditingAutomation(null)
    setEditorOpen(true)
  }

  const openEditDialog = async (automation: Automation): Promise<void> => {
    const requestId = (editRequestRef.current += 1)
    let latest = automation
    try {
      latest =
        (await window.api.automations.list()).find((entry) => entry.id === automation.id) ??
        automation
    } catch {
      latest = automation
    }
    if (requestId !== editRequestRef.current) {
      return
    }
    setEditingAutomation(latest)
    setEditorOpen(true)
  }

  const handleSaveAutomation = useCallback(
    async (automation: Automation): Promise<void> => {
      try {
        // Why: ChainEditorModal hands us a complete Automation including any
        // round-tripped legacy fields. Decide create vs. update based on
        // whether the row already exists in the current list — a brand-new
        // row arrives with an empty id from createBlankAutomation.
        const existing = automation.id
          ? (automations.find((entry) => entry.id === automation.id) ?? null)
          : null
        const payload = {
          name: automation.name,
          prompt: automation.prompt,
          agentId: automation.agentId,
          projectId: automation.projectId,
          workspaceMode: automation.workspaceMode,
          workspaceId: automation.workspaceId,
          baseBranch: automation.baseBranch,
          timezone: automation.timezone,
          rrule: automation.rrule,
          dtstart: automation.dtstart,
          enabled: automation.enabled,
          missedRunGraceMinutes: automation.missedRunGraceMinutes
        }
        await (existing
          ? window.api.automations.update({ id: existing.id, updates: payload })
          : window.api.automations.create(payload))
        await refresh()
        toast.success(existing ? 'Automation updated.' : 'Automation saved.')
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to save automation.')
        throw error
      }
    },
    [automations, refresh]
  )

  const toggleAutomation = async (automation: Automation): Promise<void> => {
    await window.api.automations.update({
      id: automation.id,
      updates: { enabled: !automation.enabled }
    })
    await refresh()
  }

  const deleteAutomation = async (automation: Automation): Promise<void> => {
    await window.api.automations.delete({ id: automation.id })
    if (useAppStore.getState().selectedAutomationId === automation.id) {
      setSelectedId(null)
    }
    await refresh()
  }

  const persistDeleteAutomationPreference = (): void => {
    void updateSettings({ skipDeleteAutomationConfirm: true })
    toast.success("We'll skip this confirmation next time.", {
      description: 'You can change this in Settings.',
      duration: 8000,
      action: {
        label: 'Open Settings',
        onClick: () => {
          openSettingsPage()
          openSettingsTarget({
            pane: 'general',
            repoId: null,
            sectionId: 'general-skip-delete-automation-confirm'
          })
        }
      }
    })
  }

  const requestDeleteAutomation = (automation: Automation): void => {
    if (settings?.skipDeleteAutomationConfirm) {
      void deleteAutomation(automation)
      return
    }
    setDontAskDeleteAgain(false)
    setDeleteTarget(automation)
  }

  const confirmDeleteAutomation = async (): Promise<void> => {
    if (!deleteTarget) {
      return
    }
    if (dontAskDeleteAgain) {
      persistDeleteAutomationPreference()
    }
    const target = deleteTarget
    setDeleteTarget(null)
    setDontAskDeleteAgain(false)
    await deleteAutomation(target)
  }

  const runNow = async (automation: Automation): Promise<void> => {
    await window.api.automations.runNow({ id: automation.id })
    await refresh()
    toast.message('Automation run queued.')
  }

  const openRunWorkspace = (run: AutomationRun): void => {
    if (!run.workspaceId || !activateAndRevealWorktree(run.workspaceId)) {
      toast.error('Workspace is not available.')
      return
    }
    if (run.terminalSessionId) {
      const store = useAppStore.getState()
      if (store.getTab(run.terminalSessionId)) {
        store.setActiveTab(run.terminalSessionId)
        store.setActiveTabType('terminal')
      }
    }
  }

  return (
    <main className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between px-5 pb-3 pt-1.5 md:px-8">
        <div className="flex items-center gap-2">
          <CalendarClock className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Automations</h1>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh automations"
                onClick={refresh}
                disabled={isLoading}
                className="border border-border/50 bg-transparent hover:bg-muted/50"
              >
                <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Refresh automations
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Add automation"
                onClick={openCreateDialog}
                className="border border-border/50 bg-transparent hover:bg-muted/50"
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Add automation
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      <ChainEditorModal
        open={editorOpen}
        automation={editingAutomation}
        repos={repos}
        reviewCommands={reviewCommands}
        createPrCommands={createPrCommands}
        onClose={() => setEditorOpen(false)}
        onSave={handleSaveAutomation}
        onRunNow={(id) => {
          const target = automations.find((entry) => entry.id === id)
          if (target) {
            void runNow(target)
          }
        }}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (open) {
            return
          }
          setDeleteTarget(null)
          setDontAskDeleteAgain(false)
        }}
      >
        <DialogContent
          className="max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            deleteConfirmButtonRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Delete Automation</DialogTitle>
            <DialogDescription className="text-xs">
              Delete{' '}
              <span className="break-all font-medium text-foreground">{deleteTarget?.name}</span>{' '}
              and its run history. Workspaces created by previous runs are not deleted.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all font-medium text-foreground">{deleteTarget.name}</div>
              <div className="mt-1 text-muted-foreground">
                {deleteTarget.workspaceMode === 'new_per_run'
                  ? 'New workspace each run'
                  : 'Selected workspace'}
              </div>
            </div>
          ) : null}
          <button
            type="button"
            role="checkbox"
            aria-checked={dontAskDeleteAgain}
            onClick={() => setDontAskDeleteAgain((prev) => !prev)}
            className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={`flex size-4 items-center justify-center rounded-sm border transition-colors ${
                dontAskDeleteAgain
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-muted-foreground bg-transparent'
              }`}
            >
              {dontAskDeleteAgain ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>
            Don&apos;t ask again
          </button>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteTarget(null)
                setDontAskDeleteAgain(false)
              }}
            >
              Cancel
            </Button>
            <Button
              ref={deleteConfirmButtonRef}
              variant="destructive"
              onClick={() => void confirmDeleteAutomation()}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,360px)_1fr] overflow-hidden border-t border-border/50">
        <section className="flex min-h-0 flex-col border-r border-border/50 bg-muted/20">
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {automations.map((automation) => {
              const automationRepo = repoMap.get(automation.projectId)
              const automationWorktree = automation.workspaceId
                ? worktreeMap.get(automation.workspaceId)
                : null
              const workspaceLabel =
                automation.workspaceMode === 'new_per_run'
                  ? 'New workspace each run'
                  : (automationWorktree?.displayName ?? 'Missing workspace')
              return (
                <ContextMenu key={automation.id}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setSelectedId(automation.id)}
                      className={cn(
                        'mb-1 flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                        selected?.id === automation.id
                          ? 'border-foreground/30 bg-muted/70 text-foreground shadow-sm'
                          : 'border-transparent hover:bg-muted/50'
                      )}
                    >
                      <span className="font-medium">{automation.name}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        {automationRepo ? (
                          <RepoDotLabel
                            name={automationRepo.displayName}
                            color={automationRepo.badgeColor}
                            dotClassName="size-1.5"
                          />
                        ) : (
                          <span>Unknown project</span>
                        )}
                        <span className="shrink-0">/</span>
                        <span className="truncate">{workspaceLabel}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {automation.enabled
                          ? `Next run ${formatAutomationDateTimeWithRelative(
                              automation.nextRunAt,
                              relativeNow
                            )}`
                          : 'Paused'}
                      </span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => void runNow(automation)}>
                      <Play className="size-3.5" />
                      Run Now
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void openEditDialog(automation)}>
                      <Pencil className="size-3.5" />
                      Edit
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void toggleAutomation(automation)}>
                      {automation.enabled ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {automation.enabled ? 'Pause' : 'Resume'}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => requestDeleteAutomation(automation)}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
            {automations.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No automations yet.</div>
            ) : null}
          </div>
        </section>

        <section className="min-h-0 overflow-auto p-5">
          <AutomationDetail
            automation={selected}
            runs={selectedRuns}
            projectName={selectedRepo?.displayName ?? 'Unknown project'}
            projectDefaultBaseRef={selectedRepo?.worktreeBaseRef ?? null}
            workspaceName={
              selected?.workspaceMode === 'new_per_run'
                ? 'New workspace each run'
                : (selectedWorktree?.displayName ?? 'Missing workspace')
            }
            worktreeMap={worktreeMap}
            now={relativeNow}
            onRunNow={(automation) => void runNow(automation)}
            onOpenRunWorkspace={openRunWorkspace}
            onEdit={(automation) => void openEditDialog(automation)}
            onToggle={(automation) => void toggleAutomation(automation)}
            onDelete={requestDeleteAutomation}
          />
        </section>
      </div>
    </main>
  )
}
