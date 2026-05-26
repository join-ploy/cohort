import * as React from 'react'
import type {
  CreateWorkspaceGroupConfig,
  Step,
  StepConfig
} from '../../../../../shared/automations-types'
import type { Repo } from '../../../../../shared/types'
import type { AvailableVariables } from '../../../lib/template-dry-run'
import { TemplateInput } from './TemplateInput'
import { StepCardChrome } from './StepCardChrome'
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { Input } from '@/components/ui/input'

export type CreateWorkspaceGroupStepCardProps = {
  step: Step
  stepIndex: number
  available: AvailableVariables
  repos: Repo[]
  disableDrag?: boolean
  onIdChange: (newId: string) => void
  onConfigChange: (config: CreateWorkspaceGroupConfig) => void
  onOnFailureChange: (val: 'halt' | 'continue') => void
  onTimeoutChange: (val: number | null) => void
  onDelete: () => void
}

/**
 * Body for a `create-workspace-group` step. Mirrors CreateWorktreeStepCard but
 * configures N repos as members instead of one. Member selection reuses the
 * RepoMultiCombobox from the grouped composer so behavior stays consistent
 * between manual creates and automated ones; per-repo baseBranch is a plain
 * Input (templates allowed via the leading `{{` lookahead the engine applies
 * per-string, so we don't need TemplateInput's picker UX inline for each row).
 * branchName/displayName are TemplateInputs so users can chain off earlier
 * steps just like the single-worktree card.
 */
export function CreateWorkspaceGroupStepCard(
  props: CreateWorkspaceGroupStepCardProps
): React.JSX.Element {
  const config = props.step.config as CreateWorkspaceGroupConfig
  const update = (patch: Partial<CreateWorkspaceGroupConfig>): void => {
    props.onConfigChange({ ...config, ...patch })
  }

  const selectedIds = React.useMemo(
    () => new Set(config.members.map((m) => m.repoId)),
    [config.members]
  )
  const selectedRepos = React.useMemo(
    () => props.repos.filter((r) => selectedIds.has(r.id)),
    [props.repos, selectedIds]
  )

  const handleSelectionChange = (next: ReadonlySet<string>): void => {
    // Why: preserve per-repo baseBranch when the user toggles a repo back on,
    // and default newly added repos to 'main' to match GroupedComposerForm.
    const byId = new Map(config.members.map((m) => [m.repoId, m]))
    const nextMembers = Array.from(next).map((repoId) => {
      const existing = byId.get(repoId)
      return existing ?? { repoId, baseBranch: 'main' }
    })
    update({ members: nextMembers })
  }

  const handleSelectAll = (): void => {
    handleSelectionChange(new Set(props.repos.map((r) => r.id)))
  }

  const handleBaseBranchChange = (repoId: string, value: string): void => {
    update({
      members: config.members.map((m) => (m.repoId === repoId ? { ...m, baseBranch: value } : m))
    })
  }

  return (
    <StepCardChrome
      step={props.step}
      stepIndex={props.stepIndex}
      available={props.available}
      disableDrag={props.disableDrag}
      onIdChange={props.onIdChange}
      onConfigChange={props.onConfigChange as (config: StepConfig) => void}
      onOnFailureChange={props.onOnFailureChange}
      onTimeoutChange={props.onTimeoutChange}
      onDelete={props.onDelete}
    >
      <div className="space-y-1">
        <label className="text-[11px] font-medium text-muted-foreground">Members</label>
        <RepoMultiCombobox
          repos={props.repos}
          selected={selectedIds}
          onChange={handleSelectionChange}
          onSelectAll={handleSelectAll}
          triggerClassName="h-8 text-xs"
        />
      </div>

      {selectedRepos.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground">Per-repo base branch</div>
          <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/30 p-2">
            {selectedRepos.map((repo) => {
              const member = config.members.find((m) => m.repoId === repo.id)
              const baseBranchValue = member?.baseBranch ?? 'main'
              return (
                <div key={repo.id} className="grid grid-cols-[1fr_2fr] items-center gap-2">
                  {/* Why: match the sibling Input's text-xs so the repo name
                      sits in scale with the rest of the per-repo row. The
                      default inherited size was visibly larger and dominated
                      the form. */}
                  <RepoDotLabel
                    name={repo.displayName}
                    color={repo.badgeColor}
                    className="text-xs"
                  />
                  <Input
                    value={baseBranchValue}
                    onChange={(e) => handleBaseBranchChange(repo.id, e.target.value)}
                    placeholder="Base branch (e.g., main)"
                    aria-label={`Base branch for ${repo.displayName}`}
                    className="h-7 font-mono text-xs"
                  />
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {/* Why: blank branchName at run time → main auto-generates an
          adjective_noun slug against the live taken-names set (same generator
          the manual composer uses). Authors who want a deterministic /
          templated name still get full control. */}
      <TemplateInput
        value={config.branchName}
        onChange={(v) => update({ branchName: v })}
        placeholder="Branch / group slug (auto-generated when blank)"
        available={props.available}
        ariaLabel="Branch name"
      />
      <TemplateInput
        value={config.displayName ?? ''}
        onChange={(v) => update({ displayName: v })}
        placeholder="Display name (optional)"
        available={props.available}
        ariaLabel="Display name"
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          aria-label="Link Linear issue"
          checked={config.linkLinearIssue === true}
          onChange={(e) => update({ linkLinearIssue: e.target.checked })}
        />
        Link Linear issue
      </label>
    </StepCardChrome>
  )
}
