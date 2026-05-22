/* eslint-disable max-lines -- Why: the grouped composer keeps form layout,
   validation, and post-create launch wiring in one place so the agent
   picker, per-repo controls, and group-create transaction can share the
   same state without splitting into incidentally-coupled fragments. */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { LoaderCircle, RefreshCw, Server } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useRepos, useWorkspaceGroups } from '@/store/selectors'
import { basename } from '@/lib/path'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { generateUniqueWorkspaceName } from '../../../shared/workspace-name-generator'
import { validateGroupName } from '../../../shared/workspace-group-namespace'
import type {
  CreateGroupMemberSpec,
  CreateWorkspaceGroupArgs,
  CreateWorkspaceGroupResult,
  Repo,
  SetupDecision,
  TuiAgent
} from '../../../shared/types'

const SETUP_DECISIONS: { value: SetupDecision; label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'run', label: 'Run' },
  { value: 'skip', label: 'Skip' }
]

/** Why: group folder names must not collide with any existing repo folder
 *  basename. The shared validator only checks repo-folder + group-name lists,
 *  so we strip the trailing `.git` here to match what the main process writes
 *  to disk. */
function repoFolderName(repo: Repo): string {
  return basename(repo.path).replace(/\.git$/i, '')
}

function describeGroupNameError(
  reason: 'empty' | 'invalid-chars' | 'collides-with-repo' | 'collides-with-group'
): string {
  switch (reason) {
    case 'empty':
      return 'Group name is required.'
    case 'invalid-chars':
      return 'Use letters, digits, underscores, and dashes (must start with a letter or digit).'
    case 'collides-with-repo':
      return 'A repo already uses this folder name.'
    case 'collides-with-group':
      return 'A group already uses this name.'
  }
}

type GroupedComposerFormProps = {
  onCancel: () => void
  onCreated: (result: CreateWorkspaceGroupResult) => void
}

export default function GroupedComposerForm({
  onCancel,
  onCreated
}: GroupedComposerFormProps): React.JSX.Element {
  const repos = useRepos()
  const existingGroups = useWorkspaceGroups()
  const createGroup = useAppStore((s) => s.createGroup)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const detectedAgentList = useAppStore((s) => s.detectedAgentIds)
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  const closeModal = useAppStore((s) => s.closeModal)

  // Why: grouped composer is local-only in v1 (uniform-connection guard
  // refuses mixed local+SSH members), so detectedAgentIds always comes from
  // the local detector. Match the single-repo composer's set/null convention
  // so AgentCombobox can dim agents the user hasn't installed yet.
  useEffect(() => {
    void ensureDetectedAgents()
  }, [ensureDetectedAgents])
  const detectedAgentIds = useMemo<Set<TuiAgent> | null>(
    () => (detectedAgentList ? new Set(detectedAgentList) : null),
    [detectedAgentList]
  )
  const visibleQuickAgents = useMemo(
    () =>
      AGENT_CATALOG.filter((agent) => detectedAgentIds === null || detectedAgentIds.has(agent.id)),
    [detectedAgentIds]
  )

  // Why: default to the user's persisted last-used agent. 'blank' means
  // explicit "no agent" — surface it as null so the combobox renders the
  // "Blank terminal" sentinel, matching NewWorkspaceComposerCard's quick
  // path. When no preference is set, fall through to the first installed
  // agent in the catalog.
  const preferredAgent = useMemo<TuiAgent | null>(() => {
    const pref = settings?.defaultTuiAgent
    if (pref === 'blank') {
      return null
    }
    if (pref) {
      return pref
    }
    return (
      AGENT_CATALOG.find((agent) => detectedAgentIds === null || detectedAgentIds.has(agent.id))
        ?.id ?? null
    )
  }, [detectedAgentIds, settings?.defaultTuiAgent])
  const [agentOverride, setAgentOverride] = useState<TuiAgent | null | undefined>(undefined)
  const selectedAgent = agentOverride === undefined ? preferredAgent : agentOverride
  const handleAgentChange = useCallback((agent: TuiAgent | null) => {
    setAgentOverride(agent)
  }, [])
  const handleSetDefaultAgent = useCallback(
    (next: TuiAgent | 'blank' | null) => {
      updateSettings({ defaultTuiAgent: next })
    },
    [updateSettings]
  )
  const handleOpenAgentSettings = useCallback(() => {
    // Why: the inline AgentSettingsDialog used by the single-repo quick path
    // is nested in NewWorkspaceComposerModal; reaching it from here would
    // require lifting state. Close the composer so the user can open
    // Settings → Agents from the main app without focus trapping.
    closeModal()
  }, [closeModal])

  // Why: precompute the taken-name set so name generation + validation share
  // one source of truth. Includes repo folder basenames and live group names.
  const takenNames = useMemo(() => {
    const taken = new Set<string>()
    for (const repo of repos) {
      taken.add(repoFolderName(repo))
    }
    for (const group of existingGroups) {
      taken.add(group.workspaceName)
    }
    return taken
  }, [repos, existingGroups])

  const namespaceContext = useMemo(
    () => ({
      repoFolderNames: repos.map(repoFolderName),
      existingGroupNames: existingGroups.map((g) => g.workspaceName)
    }),
    [repos, existingGroups]
  )

  const [selectedRepoIds, setSelectedRepoIds] = useState<ReadonlySet<string>>(() => new Set())
  const [groupName, setGroupName] = useState<string>(() => generateUniqueWorkspaceName(takenNames))
  const [branchName, setBranchName] = useState<string>(groupName)
  // Why: once the user touches the branch field, stop overwriting it when the
  // group name changes. A boolean ref-via-state keeps that latch simple.
  const [branchEdited, setBranchEdited] = useState(false)
  const [baseRefs, setBaseRefs] = useState<Record<string, string>>({})
  const [setupDecisions, setSetupDecisions] = useState<Record<string, SetupDecision>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Why: auto-sync branch to group name until the user explicitly edits the
  // branch field — picks up the initial generated name and any reroll.
  useEffect(() => {
    if (!branchEdited) {
      setBranchName(groupName)
    }
  }, [branchEdited, groupName])

  const selectedRepos = useMemo(
    () => repos.filter((r) => selectedRepoIds.has(r.id)),
    [repos, selectedRepoIds]
  )

  // Why: all members must share a connection target so the create transaction
  // can run against a single git host. Detect mixed connections at validate
  // time so the picker stays a simple multi-select rather than reaching into
  // RepoMultiCombobox to filter mid-flight.
  const mixedConnections = useMemo(() => {
    if (selectedRepos.length < 2) {
      return false
    }
    const first = selectedRepos[0]?.connectionId ?? null
    return selectedRepos.some((r) => (r.connectionId ?? null) !== first)
  }, [selectedRepos])

  const groupNameValidation = validateGroupName(groupName, namespaceContext)
  const groupNameError = groupNameValidation.ok
    ? null
    : describeGroupNameError(groupNameValidation.reason)

  // Why: branch only has to be non-empty client-side — git ref legality and
  // per-repo collisions are surfaced by the main process during create. We
  // keep the input free-form because users branch from refs whose names don't
  // match the stricter workspaceName shape (e.g. `feat/foo`).
  const branchNameError = useMemo(() => {
    if (!branchName.trim()) {
      return 'Branch name is required.'
    }
    return null
  }, [branchName])

  const tooFewRepos = selectedRepoIds.size < 2
  const canSubmit =
    !submitting &&
    !tooFewRepos &&
    !mixedConnections &&
    groupNameError === null &&
    branchNameError === null

  const handleReplaceSelection = useCallback((next: ReadonlySet<string>) => {
    setSelectedRepoIds(next)
  }, [])

  const handleSelectAll = useCallback(() => {
    setSelectedRepoIds(new Set(repos.map((r) => r.id)))
  }, [repos])

  const handleRerollGroupName = useCallback(() => {
    setGroupName(generateUniqueWorkspaceName(takenNames))
  }, [takenNames])

  const handleBaseRefChange = useCallback((repoId: string, value: string) => {
    setBaseRefs((prev) => ({ ...prev, [repoId]: value }))
  }, [])

  const handleSetupDecisionChange = useCallback((repoId: string, value: SetupDecision) => {
    setSetupDecisions((prev) => ({ ...prev, [repoId]: value }))
  }, [])

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const members: CreateGroupMemberSpec[] = selectedRepos.map((repo) => {
        // Why: trim then collapse blank strings to null so the per-repo
        // worktreeBaseRef (or `main`) default is applied on the main side.
        const rawBase = (baseRefs[repo.id] ?? '').trim()
        return {
          repoId: repo.id,
          baseRef: rawBase ? rawBase : null,
          setupDecision: setupDecisions[repo.id] ?? 'inherit',
          // Why: stamp the selected agent on every member so each worktree's
          // reopen-path can resurrect the agent if the user later closes the
          // shared terminal and re-activates a member. Members share an agent
          // choice today; the single-repo composer applies the same rule.
          ...(selectedAgent ? { createdWithAgent: selectedAgent } : {})
        }
      })
      const args: CreateWorkspaceGroupArgs = {
        workspaceName: groupName,
        branchName,
        members,
        telemetrySource: 'composer'
      }
      const result = await createGroup(args)
      const firstMember = result.memberWorktrees[0]
      if (firstMember) {
        // Why: build the same startup plan the single-repo quick path uses, so
        // the initial terminal opens running the chosen agent. The Phase J1
        // PTY override redirects CWD to the group's parentPath automatically
        // when the member belongs to a group — see pty.ts.
        const startupPlan = selectedAgent
          ? buildAgentStartupPlan({
              agent: selectedAgent,
              prompt: '',
              cmdOverrides: settings?.agentCmdOverrides ?? {},
              platform: CLIENT_PLATFORM,
              allowEmptyPromptLaunch: true
            })
          : null
        activateAndRevealWorktree(
          firstMember.id,
          startupPlan
            ? {
                startup: {
                  command: startupPlan.launchCommand,
                  ...(startupPlan.env ? { env: startupPlan.env } : {}),
                  ...(selectedAgent
                    ? {
                        telemetry: {
                          agent_kind: tuiAgentToAgentKind(selectedAgent),
                          launch_source: 'new_workspace_composer',
                          request_kind: 'new'
                        }
                      }
                    : {})
                }
              }
            : undefined
        )
      }
      onCreated(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSubmitError(message)
      toast.error(`Failed to create group: ${message}`)
    } finally {
      setSubmitting(false)
    }
  }, [
    branchName,
    baseRefs,
    canSubmit,
    createGroup,
    groupName,
    onCreated,
    selectedAgent,
    selectedRepos,
    settings?.agentCmdOverrides,
    setupDecisions
  ])

  return (
    <div className="grid gap-4 pt-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Repositories</label>
        <RepoMultiCombobox
          repos={repos}
          selected={selectedRepoIds}
          onChange={handleReplaceSelection}
          onSelectAll={handleSelectAll}
          triggerClassName="h-9 text-sm"
        />
        <p
          className={cn(
            'text-[11px]',
            tooFewRepos || mixedConnections ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {mixedConnections
            ? 'All repos must share the same connection (all local or all on the same SSH target).'
            : tooFewRepos
              ? `Select at least 2 repos (${selectedRepoIds.size} selected).`
              : `${selectedRepoIds.size} repos selected.`}
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="group-name-input">
          Group name
        </label>
        <div className="flex min-w-0 items-center gap-2">
          <input
            id="group-name-input"
            type="text"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            aria-invalid={groupNameError !== null}
            aria-describedby={groupNameError ? 'group-name-error' : undefined}
            spellCheck={false}
            autoComplete="off"
            className={cn(
              'w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 font-mono text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
              groupNameError &&
                'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30'
            )}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={handleRerollGroupName}
                aria-label="Generate new group name"
                className="size-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              Generate a new suggestion
            </TooltipContent>
          </Tooltip>
        </div>
        {groupNameError && (
          <p id="group-name-error" className="text-xs text-destructive">
            {groupNameError}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="group-branch-input">
          Branch name
        </label>
        <input
          id="group-branch-input"
          type="text"
          value={branchName}
          onChange={(event) => {
            // Why: first manual edit latches branchEdited so future group-name
            // edits no longer overwrite the user's choice.
            setBranchEdited(true)
            setBranchName(event.target.value)
          }}
          aria-invalid={branchNameError !== null}
          aria-describedby={branchNameError ? 'group-branch-error' : undefined}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            'w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 font-mono text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            branchNameError &&
              'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30'
          )}
        />
        {branchNameError && (
          <p id="group-branch-error" className="text-xs text-destructive">
            {branchNameError}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Agent</label>
        <AgentCombobox
          agents={visibleQuickAgents}
          value={selectedAgent}
          onValueChange={handleAgentChange}
          onOpenManageAgents={handleOpenAgentSettings}
          defaultAgent={settings?.defaultTuiAgent ?? null}
          onSetDefault={handleSetDefaultAgent}
          triggerClassName="h-9 w-full border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50"
        />
        <p className="text-[11px] text-muted-foreground">
          Launches in the first member&apos;s terminal at the group&apos;s parent folder.
        </p>
      </div>

      {selectedRepos.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Per-repo options</div>
          <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
            {selectedRepos.map((repo) => {
              const baseRefValue = baseRefs[repo.id] ?? repo.worktreeBaseRef ?? 'main'
              const decision = setupDecisions[repo.id] ?? 'inherit'
              return (
                <div key={repo.id} className="space-y-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    <RepoDotLabel name={repo.displayName} color={repo.badgeColor} />
                    {repo.connectionId ? (
                      <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                        <Server className="size-2.5" />
                        SSH
                      </span>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                    <Input
                      value={baseRefValue}
                      onChange={(event) => handleBaseRefChange(repo.id, event.target.value)}
                      placeholder="Base ref (e.g. main, origin/main)"
                      className="h-8 font-mono text-xs"
                      aria-label={`Base ref for ${repo.displayName}`}
                    />
                    <div
                      className="flex gap-1"
                      role="group"
                      aria-label={`Setup decision for ${repo.displayName}`}
                    >
                      {SETUP_DECISIONS.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant={decision === option.value ? 'default' : 'outline'}
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => handleSetupDecisionChange(repo.id, option.value)}
                          aria-pressed={decision === option.value}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {submitError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {submitError}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          className="text-xs"
        >
          {submitting ? <LoaderCircle className="mr-1 size-4 animate-spin" /> : null}
          Create Group
        </Button>
      </div>
    </div>
  )
}
