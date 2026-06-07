import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Check, FolderOpen, LoaderCircle, Timer, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { ARCHIVE_TTL_MS } from '../../../../shared/archive-constants'
import {
  msToDurationParts,
  durationPartsToMs,
  type DurationUnit
} from '../../../../shared/archive-duration'
import { useAppStore } from '../../store'
import { CliSection } from './CliSection'
import {
  DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
  MAX_EDITOR_AUTO_SAVE_DELAY_MS,
  MIN_EDITOR_AUTO_SAVE_DELAY_MS
} from '../../../../shared/constants'
import { clampNumber } from '@/lib/terminal-theme'
import {
  GENERAL_ARCHIVE_SEARCH_ENTRIES,
  GENERAL_CACHE_TIMER_SEARCH_ENTRIES,
  GENERAL_CLI_SEARCH_ENTRIES,
  GENERAL_EDITOR_SEARCH_ENTRIES,
  GENERAL_EXTERNAL_TOOLS_SEARCH_ENTRIES,
  GENERAL_PANE_SEARCH_ENTRIES,
  GENERAL_SIDEBAR_PROMPT_SEARCH_ENTRIES,
  GENERAL_WORKSPACE_SEARCH_ENTRIES
} from './general-search'
import { SidebarPromptCommandsSection } from './SidebarPromptCommandsSection'
import { ExternalToolsSection } from './ExternalToolsSection'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

export { GENERAL_PANE_SEARCH_ENTRIES }

type GeneralPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function ArchiveDurationRow({
  id,
  title,
  description,
  keywords,
  valueMs,
  onChangeMs
}: {
  id: string
  title: string
  description: string
  keywords: string[]
  valueMs: number
  onChangeMs: (ms: number) => void
}): React.JSX.Element {
  const parts = msToDurationParts(valueMs)
  const [draft, setDraft] = useState(String(parts.value))
  // Why: re-sync the visible number when the persisted value changes externally,
  // without clobbering a mid-edit draft on every keystroke.
  useEffect(() => {
    setDraft(String(msToDurationParts(valueMs).value))
  }, [valueMs])

  const commit = (rawValue: string, unit: DurationUnit): void => {
    const n = Number(rawValue)
    if (!Number.isFinite(n) || n <= 0) {
      setDraft(String(msToDurationParts(valueMs).value))
      return
    }
    onChangeMs(durationPartsToMs(n, unit))
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={keywords}
      className="flex items-center justify-between gap-4 px-1 py-2"
    >
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft, parts.unit)}
          className="h-7 w-16 text-xs"
        />
        <Select value={parts.unit} onValueChange={(u) => commit(draft, u as DurationUnit)}>
          <SelectTrigger size="sm" className="h-7 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hours">Hours</SelectItem>
            <SelectItem value="days">Days</SelectItem>
            <SelectItem value="weeks">Weeks</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </SearchableSetting>
  )
}

export function GeneralPane({ settings, updateSettings }: GeneralPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  // Why: fork disable — the upstream Updates section + its supporting state
  // (updateStatus, updateVersionRef, appVersion, handleRestartToUpdate) were
  // removed. See src/main/updater.ts for the matching runtime short-circuit.
  const [autoSaveDelayDraft, setAutoSaveDelayDraft] = useState(
    String(settings.editorAutoSaveDelayMs)
  )
  useEffect(() => {
    setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs))
  }, [settings.editorAutoSaveDelayMs])

  const [pruneAllOpen, setPruneAllOpen] = useState(false)
  const [pruneForce, setPruneForce] = useState(false)
  const [pruneBusy, setPruneBusy] = useState(false)

  // Why: the force option is a one-shot intent — reset it whenever the dialog
  // closes so the next open starts unchecked.
  useEffect(() => {
    if (!pruneAllOpen) {
      setPruneForce(false)
    }
  }, [pruneAllOpen])

  const handleCleanupNow = async (): Promise<void> => {
    try {
      await window.api.worktrees.cleanupArchivedNow()
      toast.success('Cleaned up expired archived workspaces.')
    } catch (err) {
      toast.error('Cleanup failed', {
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const handlePruneAll = async (): Promise<void> => {
    setPruneBusy(true)
    try {
      await window.api.worktrees.pruneAllArchivedNow(pruneForce)
      toast.success('Pruned all archived workspaces.')
      setPruneAllOpen(false)
    } catch (err) {
      toast.error('Prune failed', {
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setPruneBusy(false)
    }
  }

  const handleBrowseWorkspace = async () => {
    const path = await window.api.repos.pickFolder()
    if (path) {
      updateSettings({ workspaceDir: path })
    }
  }

  const commitAutoSaveDelay = (): void => {
    const trimmed = autoSaveDelayDraft.trim()
    if (trimmed === '') {
      setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs))
      return
    }

    const value = Number(trimmed)
    if (!Number.isFinite(value)) {
      setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs))
      return
    }

    const next = clampNumber(
      Math.round(value),
      MIN_EDITOR_AUTO_SAVE_DELAY_MS,
      MAX_EDITOR_AUTO_SAVE_DELAY_MS
    )
    updateSettings({ editorAutoSaveDelayMs: next })
    setAutoSaveDelayDraft(String(next))
  }

  const visibleSections = [
    matchesSettingsSearch(searchQuery, GENERAL_WORKSPACE_SEARCH_ENTRIES) ? (
      <section key="workspace" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Workspace</h3>
          <p className="text-xs text-muted-foreground">
            Configure where new worktrees are created.
          </p>
        </div>

        <SearchableSetting
          title="Workspace Directory"
          description="Root directory where worktree folders are created."
          keywords={['workspace', 'folder', 'path', 'worktree']}
          className="space-y-2"
        >
          <Label>Workspace Directory</Label>
          <div className="flex gap-2">
            <Input
              value={settings.workspaceDir}
              onChange={(e) => updateSettings({ workspaceDir: e.target.value })}
              className="flex-1 text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleBrowseWorkspace}
              className="shrink-0 gap-1.5"
            >
              <FolderOpen className="size-3.5" />
              Browse
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Root directory where worktree folders are created.
          </p>
        </SearchableSetting>

        <SearchableSetting
          title="Nest Workspaces"
          description="Create worktrees inside a repo-named subfolder."
          keywords={['nested', 'subfolder', 'directory']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Nest Workspaces</Label>
            <p className="text-xs text-muted-foreground">
              Create worktrees inside a repo-named subfolder.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.nestWorkspaces}
            onClick={() =>
              updateSettings({
                nestWorkspaces: !settings.nestWorkspaces
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.nestWorkspaces ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.nestWorkspaces ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

        {/* Why: the "Don't ask again" toast in the delete-worktree dialog
            deep-links here, so the wrapper id must stay stable. Renaming it
            breaks that toast action even though this pane still renders fine. */}
        <div id="general-skip-delete-worktree-confirm" className="scroll-mt-6">
          <SearchableSetting
            title="Skip Delete Worktree Confirmation"
            description="Delete worktrees from the context menu without a confirmation dialog."
            keywords={['delete', 'worktree', 'confirm', 'dialog', 'skip', 'prompt']}
            className="flex items-center justify-between gap-4 px-1 py-2"
          >
            <div className="space-y-0.5">
              <Label>Skip Delete Worktree Confirmation</Label>
              <p className="text-xs text-muted-foreground">
                Delete worktrees from the context menu without a confirmation dialog. Errors still
                surface as a toast with a Force Delete fallback.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={settings.skipDeleteWorktreeConfirm}
              onClick={() =>
                updateSettings({
                  skipDeleteWorktreeConfirm: !settings.skipDeleteWorktreeConfirm
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.skipDeleteWorktreeConfirm ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                  settings.skipDeleteWorktreeConfirm ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </SearchableSetting>
        </div>

        <div id="general-skip-delete-automation-confirm" className="scroll-mt-6">
          <SearchableSetting
            title="Skip Delete Automation Confirmation"
            description="Delete automations without a confirmation dialog."
            keywords={['delete', 'automation', 'confirm', 'dialog', 'skip', 'prompt']}
            className="flex items-center justify-between gap-4 px-1 py-2"
          >
            <div className="space-y-0.5">
              <Label>Skip Delete Automation Confirmation</Label>
              <p className="text-xs text-muted-foreground">
                Delete automations and their run history without a confirmation dialog.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={settings.skipDeleteAutomationConfirm}
              onClick={() =>
                updateSettings({
                  skipDeleteAutomationConfirm: !settings.skipDeleteAutomationConfirm
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.skipDeleteAutomationConfirm ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                  settings.skipDeleteAutomationConfirm ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_ARCHIVE_SEARCH_ENTRIES) ? (
      <section key="workspace-archiving" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Workspace Archiving</h3>
          <p className="text-xs text-muted-foreground">
            How long archived workspaces are kept before they&apos;re permanently deleted.
          </p>
        </div>

        <ArchiveDurationRow
          id="general-archive-worktree-ttl"
          title="Keep Archived Workspaces"
          description="Archived worktrees are permanently deleted after this long."
          keywords={[
            'archive',
            'prune',
            'cleanup',
            'retention',
            'duration',
            'worktree',
            'delete',
            'ttl'
          ]}
          valueMs={settings.archiveWorktreeTtlMs ?? ARCHIVE_TTL_MS}
          onChangeMs={(ms) => updateSettings({ archiveWorktreeTtlMs: ms })}
        />

        <ArchiveDurationRow
          id="general-archive-group-ttl"
          title="Keep Archived Groups"
          description="Archived workspace groups are permanently deleted after this long."
          keywords={[
            'archive',
            'prune',
            'cleanup',
            'retention',
            'duration',
            'group',
            'delete',
            'ttl'
          ]}
          valueMs={settings.archiveGroupTtlMs ?? ARCHIVE_TTL_MS}
          onChangeMs={(ms) => updateSettings({ archiveGroupTtlMs: ms })}
        />

        <SearchableSetting
          title="Prune Archived Workspaces Now"
          description="Run cleanup on demand or delete all archived workspaces immediately."
          keywords={['prune', 'cleanup', 'archive', 'now', 'force', 'delete', 'all']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Prune Now</Label>
            <p className="text-xs text-muted-foreground">
              Run cleanup now (respects the durations above), or prune every archived workspace
              immediately.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCleanupNow}>
              Run cleanup now
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setPruneAllOpen(true)}>
              Prune all archived now
            </Button>
          </div>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_EDITOR_SEARCH_ENTRIES) ? (
      <section key="editor" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Editor</h3>
          <p className="text-xs text-muted-foreground">Configure how Orca persists file edits.</p>
        </div>

        <SearchableSetting
          title="Auto Save Files"
          description="Save editor and editable diff changes automatically after a short pause."
          keywords={['autosave', 'save']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Auto Save Files</Label>
            <p className="text-xs text-muted-foreground">
              Save editor and editable diff changes automatically after a short pause.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.editorAutoSave}
            onClick={() =>
              updateSettings({
                editorAutoSave: !settings.editorAutoSave
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.editorAutoSave ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.editorAutoSave ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

        <SearchableSetting
          title="Auto Save Delay"
          description="How long Orca waits after your last edit before saving automatically."
          keywords={['autosave', 'delay', 'milliseconds']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Auto Save Delay</Label>
            <p className="text-xs text-muted-foreground">
              How long Orca waits after your last edit before saving automatically. First launch
              defaults to {DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS} ms.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              type="number"
              min={MIN_EDITOR_AUTO_SAVE_DELAY_MS}
              max={MAX_EDITOR_AUTO_SAVE_DELAY_MS}
              step={250}
              value={autoSaveDelayDraft}
              onChange={(e) => setAutoSaveDelayDraft(e.target.value)}
              onBlur={commitAutoSaveDelay}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitAutoSaveDelay()
                }
              }}
              className="number-input-clean w-28 text-right tabular-nums"
            />
            <span className="text-xs text-muted-foreground">ms</span>
          </div>
        </SearchableSetting>

        <SearchableSetting
          title="Default Diff View"
          description="Preferred presentation format for showing git diffs by default."
          keywords={['diff', 'view', 'inline', 'side-by-side', 'split']}
          className="flex flex-col items-start gap-3 px-1 py-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="space-y-0.5">
            <Label>Default Diff View</Label>
            <p className="text-xs text-muted-foreground">
              Preferred presentation format for showing git diffs by default.
            </p>
          </div>
          <div className="flex shrink-0 items-center rounded-md border border-border/60 bg-background/50 p-0.5">
            {(['inline', 'side-by-side'] as const).map((option) => (
              <button
                key={option}
                onClick={() => updateSettings({ diffDefaultView: option })}
                className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                  settings.diffDefaultView === option
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {option === 'inline' ? 'Inline' : 'Side-by-side'}
              </button>
            ))}
          </div>
        </SearchableSetting>

        <SearchableSetting
          title="Minimap"
          description="Show the minimap overview when editing a file."
          keywords={['minimap', 'overview', 'code', 'scroll']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Minimap</Label>
            <p className="text-xs text-muted-foreground">
              Show the minimap overview when editing a file.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.editorMinimapEnabled}
            onClick={() =>
              updateSettings({
                editorMinimapEnabled: !settings.editorMinimapEnabled
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.editorMinimapEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.editorMinimapEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_CLI_SEARCH_ENTRIES) ? (
      <CliSection
        key="cli"
        currentPlatform={navigator.userAgent.includes('Mac') ? 'darwin' : 'other'}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_CACHE_TIMER_SEARCH_ENTRIES) ? (
      <section key="cache-timer" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Prompt Cache Timer</h3>
          <p className="text-xs text-muted-foreground">
            Claude caches your conversation to reduce costs. When idle too long the cache expires
            and the next message resends full context at higher cost. This shows a countdown so you
            know when to resume.
          </p>
        </div>

        <SearchableSetting
          title="Cache Timer"
          description="Show a countdown after a Claude agent becomes idle."
          // Why: this is the primary control for the section gated by
          // GENERAL_CACHE_TIMER_SEARCH_ENTRIES (title "Prompt Cache Timer").
          // Mirroring those keywords keeps a search for "Prompt Cache Timer"
          // from rendering the section header with no body underneath.
          keywords={GENERAL_CACHE_TIMER_SEARCH_ENTRIES.flatMap((entry) => [
            entry.title,
            entry.description ?? '',
            ...(entry.keywords ?? [])
          ])}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Timer className="size-4" />
              <Label>Cache Timer</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Show a countdown in the sidebar after a Claude agent becomes idle.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.promptCacheTimerEnabled}
            aria-label="Cache Timer"
            onClick={() => {
              const enabling = !settings.promptCacheTimerEnabled
              updateSettings({ promptCacheTimerEnabled: enabling })
              // Why: if enabling mid-session, seed timers for any Claude tabs that
              // are already idle — their working→idle transition already happened
              // and won't re-fire.
              if (enabling) {
                useAppStore.getState().seedCacheTimersForIdleTabs()
              }
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.promptCacheTimerEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.promptCacheTimerEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

        {settings.promptCacheTimerEnabled && (
          <SearchableSetting
            title="Timer Duration"
            description="Match this to your provider's cache TTL."
            keywords={['cache', 'timer', 'duration', 'ttl']}
            className="flex items-center justify-between gap-4 px-1 py-2 pl-7"
          >
            <div className="space-y-0.5">
              <Label>Timer Duration</Label>
              <p className="text-xs text-muted-foreground">
                Match this to your provider&apos;s cache TTL. The default is 5 minutes.
              </p>
            </div>
            <Select
              value={String(settings.promptCacheTtlMs)}
              onValueChange={(v) => updateSettings({ promptCacheTtlMs: Number(v) })}
            >
              <SelectTrigger size="sm" className="h-7 text-xs w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="300000">5 minutes</SelectItem>
                <SelectItem value="3600000">1 hour</SelectItem>
              </SelectContent>
            </Select>
          </SearchableSetting>
        )}
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_SIDEBAR_PROMPT_SEARCH_ENTRIES) ? (
      <SidebarPromptCommandsSection
        key="sidebar-prompt-commands"
        reviewCommands={settings.reviewCommands ?? []}
        createPrCommands={settings.createPrCommands ?? []}
        onChangeReviewCommands={(next) => updateSettings({ reviewCommands: next })}
        onChangeCreatePrCommands={(next) => updateSettings({ createPrCommands: next })}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_EXTERNAL_TOOLS_SEARCH_ENTRIES) ? (
      <ExternalToolsSection
        key="external-tools"
        editorKind={settings.externalEditorKind}
        editorCommand={settings.externalEditorCommand}
        diffCommand={settings.externalDiffCommand}
        databaseKind={settings.externalDatabaseKind}
        databaseCommand={settings.externalDatabaseCommand}
        onChange={updateSettings}
      />
    ) : null
    // Note: the Support section is rendered outside this array so it can own
    // its own loading placeholder and its own collapsing Separator. Without
    // that separation, a dangling divider would remain above the collapsed
    // section.
  ].filter(Boolean)

  return (
    <div className="space-y-8">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}

      <Dialog
        open={pruneAllOpen}
        onOpenChange={(open) => {
          if (!pruneBusy) {
            setPruneAllOpen(open)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Prune all archived workspaces?</DialogTitle>
            <DialogDescription className="text-xs">
              Permanently delete every archived workspace and group right now, ignoring the
              configured durations. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <button
            type="button"
            role="checkbox"
            aria-checked={pruneForce}
            onClick={() => setPruneForce((prev) => !prev)}
            className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={`flex size-4 items-center justify-center rounded-sm border transition-colors ${
                pruneForce
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-muted-foreground bg-transparent'
              }`}
            >
              {pruneForce ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>
            Also delete workspaces with uncommitted changes
          </button>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPruneAllOpen(false)} disabled={pruneBusy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handlePruneAll} disabled={pruneBusy}>
              {pruneBusy ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 />}
              {pruneBusy ? 'Pruning…' : 'Prune all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
