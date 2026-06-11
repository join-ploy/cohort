import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrcaHooks, Repo, SetupRunPolicy } from '../../../../shared/types'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  envVarsEqual,
  envVarsToRows,
  isValidEnvVarName,
  rowsToEnvVars,
  type EnvVarRow
} from './repo-env-vars'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'

type RepositoryHooksSectionProps = {
  repo: Repo
  yamlHooks: OrcaHooks | null
  hasHooksFile: boolean
  mayNeedUpdate: boolean
  copiedTemplate: boolean
  onCopyTemplate: () => void
  onClearLegacyHooks: () => void
  onUpdateSetupRunPolicy: (policy: SetupRunPolicy) => void
  onUpdateDatabaseUrl: (databaseUrl: string) => void
  onUpdateReviewPreferences: (reviewPreferences: string) => void
  onUpdateCreatePrPreferences: (createPrPreferences: string) => void
  onUpdateEnvVars: (envVars: Record<string, string>) => void
}

type PolicyOption<P> = { policy: P; label: string; description: string }

const SETUP_RUN_POLICY_OPTIONS: PolicyOption<SetupRunPolicy>[] = [
  { policy: 'ask', label: 'Ask every time', description: 'Prompt before running setup.' },
  { policy: 'run-by-default', label: 'Run by default', description: 'Run setup automatically.' },
  {
    policy: 'skip-by-default',
    label: 'Skip by default',
    description: 'Only run setup when chosen.'
  }
]

const EXAMPLE_TEMPLATE = `scripts:
  setup: |
    pnpm worktree:setup
  archive: |
    echo "Cleaning up before archive"
issueCommand: |
  Complete {{artifact_url}}`

const YAML_STATE_STYLES: Record<
  string,
  { card: string; title: string; heading: string; description: string }
> = {
  loaded: {
    card: 'border-emerald-500/20 bg-emerald-500/5',
    title: 'text-emerald-700 dark:text-emerald-300',
    heading: 'Using `orca.yaml`',
    description:
      'Shared hook and issue-automation defaults are defined in the repo and available to everyone who uses it.'
  },
  'update-available': {
    card: 'border-amber-500/20 bg-amber-500/5',
    title: 'text-amber-700 dark:text-amber-300',
    heading: '`orca.yaml` could not be parsed',
    description:
      'The file contains configuration keys that this version of Orca does not recognize. You may need to update Orca, or check the file for typos.'
  },
  invalid: {
    card: 'border-amber-500/20 bg-amber-500/5',
    title: 'text-amber-700 dark:text-amber-300',
    heading: '`orca.yaml` could not be parsed',
    description:
      'The core configuration file exists in the repo root, but Orca could not parse the supported hook definitions yet.'
  },
  missing: {
    card: 'border-border/50 bg-muted/20',
    title: 'text-foreground',
    heading: 'No `orca.yaml` detected',
    description:
      'Add an `orca.yaml` file to enable shared setup, archive, or issue-automation defaults for this repo. Example template:'
  }
}

/** Shared button grid for setup run-policy selectors. */
function PolicyOptionGrid<P extends string>({
  options,
  selected,
  onSelect,
  columns
}: {
  options: PolicyOption<P>[]
  selected: P
  onSelect: (p: P) => void
  columns: string
}): React.JSX.Element {
  return (
    <div className={`grid gap-2 ${columns}`}>
      {options.map(({ policy, label, description }) => {
        const active = selected === policy
        return (
          <button
            key={policy}
            onClick={() => onSelect(policy)}
            className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${
              active
                ? 'border-foreground/15 bg-accent text-accent-foreground'
                : 'border-border/60 bg-background text-foreground hover:border-border hover:bg-muted/40'
            }`}
          >
            <span className={`block text-sm ${active ? 'font-semibold' : 'font-medium'}`}>
              {label}
            </span>
            <p
              className={`mt-1 text-[11px] leading-4 ${active ? 'text-accent-foreground/80' : 'text-muted-foreground'}`}
            >
              {description}
            </p>
          </button>
        )
      })}
    </div>
  )
}

function ExampleTemplateCard({
  copiedTemplate,
  onCopyTemplate
}: {
  copiedTemplate: boolean
  onCopyTemplate: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <p className="text-[10px] tracking-[0.18em] text-muted-foreground">
        Example <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code> template
      </p>
      <div className="relative rounded-lg border border-border/50 bg-background/70">
        <Button
          type="button"
          variant={copiedTemplate ? 'secondary' : 'ghost'}
          size="sm"
          className={`absolute right-2 top-2 z-10 h-6 px-2 text-[11px] ${
            copiedTemplate ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={onCopyTemplate}
        >
          {copiedTemplate ? 'Copied' : 'Copy'}
        </Button>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 pr-16 font-mono text-[11px] leading-5 text-muted-foreground">
          {EXAMPLE_TEMPLATE}
        </pre>
      </div>
    </div>
  )
}

export function RepositoryHooksSection({
  repo,
  yamlHooks,
  hasHooksFile,
  mayNeedUpdate,
  copiedTemplate,
  onCopyTemplate,
  onClearLegacyHooks,
  onUpdateSetupRunPolicy,
  onUpdateDatabaseUrl,
  onUpdateReviewPreferences,
  onUpdateCreatePrPreferences,
  onUpdateEnvVars
}: RepositoryHooksSectionProps): React.JSX.Element {
  // Why: distinguish "file has unrecognised top-level keys" from "file is
  // genuinely malformed" so users see a helpful update prompt instead of a
  // confusing parse-error when a newer Orca version adds keys to `orca.yaml`.
  const yamlState = yamlHooks
    ? 'loaded'
    : hasHooksFile
      ? mayNeedUpdate
        ? 'update-available'
        : 'invalid'
      : 'missing'
  const hs = repo.hookSettings
  const legacyHookEntries = (['setup', 'archive'] as const)
    .map((hookName) => [hookName, hs?.scripts[hookName]?.trim() ?? ''] as const)
    .filter(([, script]) => Boolean(script))
  // Why: the type allows `undefined` in persisted settings for backward compatibility,
  // but the UI always needs a concrete value so the policy grid has an active selection.
  const selectedSetupRunPolicy: SetupRunPolicy = hs?.setupRunPolicy ?? 'run-by-default'
  const [issueCommandDraft, setIssueCommandDraft] = useState('')
  const [hasSharedIssueCommand, setHasSharedIssueCommand] = useState(false)
  const [issueCommandSaveError, setIssueCommandSaveError] = useState<string | null>(null)
  // Why: track the latest draft across blur/unmount so repo switches still
  // persist the user's local override without racing the next repo's state load.
  const issueCommandDraftRef = useRef(issueCommandDraft)
  issueCommandDraftRef.current = issueCommandDraft
  const lastCommittedIssueCommandRef = useRef('')

  // Keep the local override editor in sync with the selected repo and flush unsaved edits on exit.
  useEffect(() => {
    let cancelled = false
    const repoId = repo.id

    setIssueCommandDraft('')
    setHasSharedIssueCommand(false)
    setIssueCommandSaveError(null)

    // Why: settings only edit the local override, but we still need to know
    // whether `orca.yaml` defines a shared default so the helper copy can
    // explain what happens when the override is blank.
    void window.api.hooks
      .readIssueCommand({ repoId })
      .then((result) => {
        if (cancelled) {
          return
        }
        const localContent = result.localContent ?? ''
        setIssueCommandDraft(localContent)
        setHasSharedIssueCommand(Boolean(result.sharedContent))
        lastCommittedIssueCommandRef.current = localContent
      })
      .catch(() => {
        if (!cancelled) {
          setIssueCommandDraft('')
          setHasSharedIssueCommand(false)
          lastCommittedIssueCommandRef.current = ''
        }
      })

    return () => {
      cancelled = true
      const draft = issueCommandDraftRef.current.trim()
      if (draft !== lastCommittedIssueCommandRef.current) {
        void window.api.hooks.writeIssueCommand({ repoId, content: draft }).catch((err) => {
          console.error('[RepositoryHooksSection] Failed to save issue command on unmount:', err)
        })
      }
    }
  }, [repo.id])

  const commitIssueCommand = useCallback(async (): Promise<void> => {
    const trimmed = issueCommandDraft.trim()
    setIssueCommandDraft(trimmed)
    try {
      await window.api.hooks.writeIssueCommand({ repoId: repo.id, content: trimmed })
      lastCommittedIssueCommandRef.current = trimmed
      setIssueCommandSaveError(null)
    } catch (err) {
      console.error('[RepositoryHooksSection] Failed to write issue command:', err)
      const message = err instanceof Error ? err.message : 'Failed to save GitHub issue command.'
      setIssueCommandSaveError(message)
      toast.error(message)
    }
  }, [issueCommandDraft, repo.id])

  // Why: the database URL override is a single-line scalar persisted on
  // RepoHookSettings (not a file like issue-command), so the editor lives on
  // local state and flushes through `onUpdateDatabaseUrl` on blur. Track the
  // baseline as the persisted override only — the yaml value is shown as the
  // placeholder so users can see the shared default without it leaking into
  // the textbox.
  const persistedDatabaseUrl = hs?.databaseUrl ?? ''
  const yamlDatabaseUrl = yamlHooks?.databaseUrl?.trim() ?? ''
  const [databaseUrlDraft, setDatabaseUrlDraft] = useState(persistedDatabaseUrl)
  useEffect(() => {
    setDatabaseUrlDraft(persistedDatabaseUrl)
  }, [persistedDatabaseUrl, repo.id])
  const commitDatabaseUrl = useCallback((): void => {
    const trimmed = databaseUrlDraft.trim()
    if (trimmed === persistedDatabaseUrl.trim()) {
      return
    }
    setDatabaseUrlDraft(trimmed)
    onUpdateDatabaseUrl(trimmed)
  }, [databaseUrlDraft, persistedDatabaseUrl, onUpdateDatabaseUrl])

  // Why: reviewPreferences / createPrPreferences mirror the databaseUrl
  // editor — multiline textareas backed by a persisted override that wins
  // over the yaml value (shown as placeholder when blank). The persisted
  // override is `undefined` when the user hasn't authored one yet, so the
  // textarea opens empty and the orca.yaml value (if any) appears as the
  // placeholder. Saving on blur keeps the flow identical to databaseUrl.
  const persistedReviewPrefs = hs?.reviewPreferences ?? ''
  const yamlReviewPrefs = yamlHooks?.reviewPreferences?.trim() ?? ''
  const [reviewPrefsDraft, setReviewPrefsDraft] = useState(persistedReviewPrefs)
  useEffect(() => {
    setReviewPrefsDraft(persistedReviewPrefs)
  }, [persistedReviewPrefs, repo.id])
  const commitReviewPrefs = useCallback((): void => {
    const trimmed = reviewPrefsDraft.trim()
    if (trimmed === persistedReviewPrefs.trim()) {
      return
    }
    setReviewPrefsDraft(trimmed)
    onUpdateReviewPreferences(trimmed)
  }, [reviewPrefsDraft, persistedReviewPrefs, onUpdateReviewPreferences])

  const persistedCreatePrPrefs = hs?.createPrPreferences ?? ''
  const yamlCreatePrPrefs = yamlHooks?.createPrPreferences?.trim() ?? ''
  const [createPrPrefsDraft, setCreatePrPrefsDraft] = useState(persistedCreatePrPrefs)
  useEffect(() => {
    setCreatePrPrefsDraft(persistedCreatePrPrefs)
  }, [persistedCreatePrPrefs, repo.id])
  const commitCreatePrPrefs = useCallback((): void => {
    const trimmed = createPrPrefsDraft.trim()
    if (trimmed === persistedCreatePrPrefs.trim()) {
      return
    }
    setCreatePrPrefsDraft(trimmed)
    onUpdateCreatePrPreferences(trimmed)
  }, [createPrPrefsDraft, persistedCreatePrPrefs, onUpdateCreatePrPreferences])

  // Why: resync rows only on repo switch (not on every persisted-object
  // identity change) so in-flight edits are not clobbered mid-typing. Local
  // rows are the source of truth while the section is mounted for one repo.
  const [envVarRows, setEnvVarRows] = useState<EnvVarRow[]>(() => envVarsToRows(hs?.envVars ?? {}))
  useEffect(() => {
    setEnvVarRows(envVarsToRows(repo.hookSettings?.envVars ?? {}))
  }, [repo.id])

  const commitEnvVars = useCallback(
    (rows: EnvVarRow[]): void => {
      const next = rowsToEnvVars(rows)
      if (envVarsEqual(next, repo.hookSettings?.envVars ?? {})) {
        return
      }
      onUpdateEnvVars(next)
    },
    [repo.hookSettings?.envVars, onUpdateEnvVars]
  )

  const updateEnvVarRow = useCallback((id: string, patch: Partial<EnvVarRow>): void => {
    setEnvVarRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }, [])

  const removeEnvVarRow = useCallback(
    (id: string): void => {
      setEnvVarRows((rows) => {
        const next = rows.filter((r) => r.id !== id)
        commitEnvVars(next)
        return next
      })
    },
    [commitEnvVars]
  )

  const addEnvVarRow = useCallback((): void => {
    setEnvVarRows((rows) => [...rows, { id: crypto.randomUUID(), key: '', value: '' }])
  }, [])

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Worktree Hooks</h2>
        <p className="text-xs text-muted-foreground">
          Orca prefers shared hooks from `orca.yaml` and still honors older repo-local hook scripts
          until you clear them.
        </p>
      </div>

      <SearchableSetting
        title="orca.yaml hooks"
        description="Shared setup, archive, and issue automation commands for this repository."
        keywords={['hooks', 'setup', 'archive', 'yaml']}
      >
        <div className={`space-y-3 rounded-xl border p-4 ${YAML_STATE_STYLES[yamlState].card}`}>
          <div className="space-y-1">
            <p className={`text-sm font-medium ${YAML_STATE_STYLES[yamlState].title}`}>
              {YAML_STATE_STYLES[yamlState].heading}
            </p>
            <p className="text-xs text-muted-foreground">
              {YAML_STATE_STYLES[yamlState].description}
            </p>
          </div>

          {yamlState === 'loaded' ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-border/50 bg-background/70">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-foreground">
                  {renderYamlScriptPreview(yamlHooks)}
                </pre>
              </div>
              <p className="text-xs text-muted-foreground">
                Edit `orca.yaml` in the repository if you need to change these shared commands.
              </p>
            </div>
          ) : yamlState === 'update-available' ? (
            <ExampleTemplateCard copiedTemplate={copiedTemplate} onCopyTemplate={onCopyTemplate} />
          ) : yamlState === 'invalid' ? (
            <div className="space-y-5">
              <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-background/60 p-4">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-300">
                  <AlertTriangle className="size-5" />
                </div>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-base font-semibold text-amber-900 dark:text-amber-100">
                      `orca.yaml` could not be parsed
                    </p>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {/* Why: once a repo has an `orca.yaml`, the failure mode is usually bad shape
                      rather than a missing concept. Showing a repair-oriented explanation and
                      template here lets maintainers fix the committed file without needing the doc. */}
                      The file is present, but Orca could not find valid `scripts` or `issueCommand`
                      definitions in the expected format.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      Recommended fixes
                    </p>
                    <ol className="space-y-2.5 text-sm text-muted-foreground">
                      {PARSE_ERROR_FIXES.map((fix, index) => (
                        <li key={fix} className="flex items-start gap-3">
                          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground">
                            {index + 1}
                          </span>
                          <span className="leading-6">{fix}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              </div>

              <ExampleTemplateCard
                copiedTemplate={copiedTemplate}
                onCopyTemplate={onCopyTemplate}
              />
            </div>
          ) : (
            <ExampleTemplateCard copiedTemplate={copiedTemplate} onCopyTemplate={onCopyTemplate} />
          )}
        </div>
      </SearchableSetting>

      {legacyHookEntries.length > 0 ? (
        <SearchableSetting
          title="Legacy Repo-Local Hooks"
          description="Older setup and archive hook scripts stored in local repo settings."
          keywords={['legacy', 'fallback', 'setup', 'archive']}
        >
          <div className="space-y-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <h5 className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                  Legacy Repo-Local Hooks
                </h5>
                <p className="text-xs text-muted-foreground">
                  These older commands still run as a fallback when `orca.yaml` does not provide a
                  hook. Clear them after you migrate the behavior into `orca.yaml`.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onClearLegacyHooks}>
                Clear Legacy Hooks
              </Button>
            </div>

            {legacyHookEntries.map(([hookName, script]) => (
              <div
                key={hookName}
                className="space-y-2 rounded-xl border border-amber-500/20 bg-background/70 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium capitalize text-foreground">{hookName}</p>
                  <span className="text-[10px] text-muted-foreground">Compatibility fallback</span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-[11px] leading-5 text-foreground">
                  {script}
                </pre>
              </div>
            ))}
          </div>
        </SearchableSetting>
      ) : null}

      <SearchableSetting
        title="When to Run Setup"
        description="Choose the default behavior when a setup command is available."
        keywords={['setup run policy', 'ask', 'run by default', 'skip by default']}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">When to Run Setup</h5>
            <p className="text-xs text-muted-foreground">
              Choose the default behavior when a setup command is available.
            </p>
          </div>

          <PolicyOptionGrid
            options={SETUP_RUN_POLICY_OPTIONS}
            selected={selectedSetupRunPolicy}
            onSelect={onUpdateSetupRunPolicy}
            columns="md:grid-cols-3"
          />
        </div>
      </SearchableSetting>

      <SearchableSetting
        title="Custom GitHub Issue Command"
        description="Optional per-user override for the linked-issue command."
        keywords={['github issue command', 'issue command', 'workflow', 'agent', 'github']}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">Custom GitHub Issue Command</h5>
          </div>
          <div className="space-y-2">
            <textarea
              value={issueCommandDraft}
              onChange={(e) => setIssueCommandDraft(e.target.value)}
              onBlur={commitIssueCommand}
              placeholder="Complete {{artifact_url}}"
              rows={5}
              className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <p className="text-xs text-muted-foreground">
              Use <code className="rounded bg-muted px-1 py-0.5">{'{{artifact_url}}'}</code> for the
              linked issue or PR URL. Leave empty to use the built-in{' '}
              <code className="rounded bg-muted px-1 py-0.5">Complete {'{{artifact_url}}'}</code>{' '}
              default.
            </p>
            <p className="text-xs text-muted-foreground">
              Leave blank to use the repo default from{' '}
              <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code>
              {hasSharedIssueCommand ? '.' : ' when one exists.'}
            </p>
            {issueCommandSaveError ? (
              <p className="text-xs text-destructive">{issueCommandSaveError}</p>
            ) : null}
          </div>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title="Database URL"
        description="Per-repo override for the orca.yaml databaseUrl used by the Open in Database action."
        keywords={[
          'database',
          'database url',
          'databaseUrl',
          'tableplus',
          'postgres',
          'mysql',
          'connection'
        ]}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">Database URL</h5>
            <p className="text-xs text-muted-foreground">
              Connection URL for the context bar&apos;s Open in Database action. This per-repo
              override is stored locally and takes precedence over the shared value in{' '}
              <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code>.
            </p>
          </div>
          <div className="space-y-2">
            <textarea
              value={databaseUrlDraft}
              onChange={(e) => setDatabaseUrlDraft(e.target.value)}
              onBlur={commitDatabaseUrl}
              placeholder={
                yamlDatabaseUrl || 'postgresql://postgres:postgres@127.0.0.1/${WORKSPACE_NAME}_dev'
              }
              rows={2}
              className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <p className="text-xs text-muted-foreground">
              Use <code className="rounded bg-muted px-1 py-0.5">{'${WORKSPACE_NAME}'}</code> as the
              placeholder for the active worktree&apos;s workspace name.
            </p>
            <p className="text-xs text-muted-foreground">
              {yamlDatabaseUrl
                ? 'Leave blank to fall back to the shared `orca.yaml` value shown above.'
                : 'Leave blank to disable the Open in Database action when no `orca.yaml` value is set.'}
            </p>
          </div>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title="Extra Environment Variables"
        description="Per-repo env vars injected into run, setup, and archive scripts."
        keywords={['env', 'environment', 'variables', 'env vars', 'run', 'export']}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">Extra Environment Variables</h5>
            <p className="text-xs text-muted-foreground">
              Injected into the run (⌘R), setup, and archive scripts for this repo. Stored locally
              and never written to <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code>.
            </p>
          </div>

          <div className="space-y-2">
            {envVarRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No variables set.</p>
            ) : (
              envVarRows.map((row) => {
                const invalidKey = row.key.trim() !== '' && !isValidEnvVarName(row.key.trim())
                return (
                  <div key={row.id} className="flex items-start gap-2">
                    <div className="flex-1 space-y-1">
                      <input
                        value={row.key}
                        onChange={(e) => updateEnvVarRow(row.id, { key: e.target.value })}
                        onBlur={() => commitEnvVars(envVarRows)}
                        placeholder="MY_API_KEY"
                        className={`w-full min-w-0 rounded-md border bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                          invalidKey
                            ? 'border-destructive focus-visible:border-destructive'
                            : 'border-input focus-visible:border-ring'
                        }`}
                      />
                      {invalidKey ? (
                        <p className="text-[11px] text-destructive">
                          Names must start with a letter or underscore and contain only letters,
                          digits, and underscores. This variable will not be saved.
                        </p>
                      ) : null}
                    </div>
                    <input
                      value={row.value}
                      onChange={(e) => updateEnvVarRow(row.id, { value: e.target.value })}
                      onBlur={() => commitEnvVars(envVarRows)}
                      placeholder="value"
                      className="flex-1 min-w-0 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-0.5 size-9 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeEnvVarRow(row.id)}
                      aria-label="Remove variable"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )
              })
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={addEnvVarRow}
            >
              <Plus className="size-4" />
              Add variable
            </Button>
          </div>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title="Review Prompt Preferences"
        description="Per-repo guidance appended to the global Review prompt before it runs."
        keywords={['review', 'review preferences', 'right-sidebar', 'prompt', 'code review']}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">Review Prompt Preferences</h5>
            <p className="text-xs text-muted-foreground">
              Appended to the user&apos;s global Review prompt when the right-sidebar Review button
              runs. This per-repo override is stored locally and takes precedence over the shared
              value in <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code>.
            </p>
          </div>
          <div className="space-y-2">
            <textarea
              value={reviewPrefsDraft}
              onChange={(e) => setReviewPrefsDraft(e.target.value)}
              onBlur={commitReviewPrefs}
              placeholder={
                yamlReviewPrefs ||
                'e.g. Be strict about Windows path handling and SSH-only failure modes.'
              }
              rows={4}
              className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <p className="text-xs text-muted-foreground">
              {yamlReviewPrefs
                ? 'Leave blank to fall back to the shared `orca.yaml` value shown above.'
                : 'Leave blank to use only the user-level Review prompt without per-repo additions.'}
            </p>
          </div>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title="Create PR Prompt Preferences"
        description="Per-repo guidance appended to the global Create PR prompt before it runs."
        keywords={['create pr', 'pull request', 'prompt', 'right-sidebar']}
      >
        <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">Create PR Prompt Preferences</h5>
            <p className="text-xs text-muted-foreground">
              Appended to the user&apos;s global Create PR prompt when the right-sidebar Create PR
              button runs. Persisted locally; overrides{' '}
              <code className="rounded bg-muted px-1 py-0.5">orca.yaml</code>.
            </p>
          </div>
          <div className="space-y-2">
            <textarea
              value={createPrPrefsDraft}
              onChange={(e) => setCreatePrPrefsDraft(e.target.value)}
              onBlur={commitCreatePrPrefs}
              placeholder={
                yamlCreatePrPrefs ||
                'e.g. Use Conventional Commits for the PR title and include a Test plan section.'
              }
              rows={4}
              className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <p className="text-xs text-muted-foreground">
              {yamlCreatePrPrefs
                ? 'Leave blank to fall back to the shared `orca.yaml` value shown above.'
                : 'Leave blank to use only the user-level Create PR prompt without per-repo additions.'}
            </p>
          </div>
        </div>
      </SearchableSetting>
    </section>
  )
}

const PARSE_ERROR_FIXES = [
  'Check the indentation under `scripts:`. Hook keys should use two spaces, and command lines should use four.',
  'Define only the supported keys: `scripts`, `setup`, `archive`, and `issueCommand`.',
  'Compare your file against the working template below and copy that shape if needed.'
]
function renderYamlScriptPreview(hooks: OrcaHooks | null): string {
  const fmt = (key: string, cmd?: string): string =>
    cmd ? `\n  ${key}: |\n${cmd.replace(/^/gm, '    ')}` : ''
  const issueCommand = hooks?.issueCommand
    ? `\nissueCommand: |\n${hooks.issueCommand.replace(/^/gm, '  ')}`
    : ''
  return `scripts:${fmt('setup', hooks?.scripts.setup)}${fmt('archive', hooks?.scripts.archive)}${issueCommand}`
}
