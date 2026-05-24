import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { CreateWorkspaceGroupConfig } from '../../../shared/automations-types'
import type { SetupDecision, WorkspaceGroup } from '../../../shared/types'
import {
  buildGroupTemplateContext,
  type GroupTemplateContext,
  type RepoDescriptionLookup
} from '../../workspace-group-runtime'
import { resolveTemplate, TemplateResolutionError } from '../template'

export type CreateWorkspaceGroupDeps = {
  /** Bridge from the chain executor's `create-workspace-group` step to the
   *  workspace-groups:create flow. The runner pre-resolves templates and hands
   *  over a normalized input shape; this dep wires straight onto the IPC
   *  handler's create logic in src/main/ipc/workspace-groups.ts. */
  createWorkspaceGroup: (input: {
    /** Doubles as the group's workspaceName, parent folder, and per-member
     *  branch name (the IPC enforces the triple-purpose use). */
    branchName: string
    displayName: string
    members: {
      repoId: string
      baseBranch: string
      setupDecision: SetupDecision
    }[]
    linkedIssue?: { provider: 'linear'; id: string } | null
    /** Attribution for the sidebar's automation indicator. Forwards ctx.runId
     *  so the persisted WorkspaceGroup carries a back-pointer to the
     *  AutomationRun that produced it. */
    createdByAutomationRunId?: string
  }) => Promise<{ groupId: string; memberWorktreeIds: string[]; parentPath: string }>
  /** Optional resolver used to populate `group.members.<repo>.description`
   *  in the templating context. Wired from Store.getRepo in service.ts so the
   *  runner doesn't import Store. When omitted (most tests), every member's
   *  description leaf is the empty string — `resolveTemplate` accepts that
   *  cleanly. */
  getRepoDescription?: RepoDescriptionLookup
  now: () => number
}

type Tracker = {
  groupId: string
  memberWorktreeIds: string[]
  parentPath: string
  /** Cached templating-shape view of the new group, dumped at the top level
   *  of context as `group.*` so downstream steps can reference
   *  `{{group.members.<repoFolderName>.worktreeId}}` /
   *  `{{group.members.<repoFolderName>.scoped}}` etc. without having to
   *  reach through `steps.<this-step-id>`. */
  groupContext: GroupTemplateContext
}

export class CreateWorkspaceGroupRunner implements StepRunner {
  // Why: nested map by (runId, stepId) mirrors CreateWorktreeRunner so a
  // future run-level release hook can drop trackers for either step kind with
  // the same shape, and a step.id containing the delimiter character can't
  // collide across runs.
  private readonly trackers = new Map<string, Map<string, Tracker>>()

  constructor(private readonly deps: CreateWorkspaceGroupDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as CreateWorkspaceGroupConfig
    let runTrackers = this.trackers.get(ctx.runId)
    const existing = runTrackers?.get(ctx.step.id)
    if (existing) {
      // Why: defensive no-op on re-tick after success — the chain executor
      // shouldn't drive a succeeded step, but if it does, return the same
      // output rather than double-create the group.
      const stepOutput = {
        groupId: existing.groupId,
        memberWorktreeIds: existing.memberWorktreeIds,
        parentPath: existing.parentPath
      }
      return {
        outcome: 'done',
        status: 'succeeded',
        output: stepOutput,
        contextPatch: {
          steps: { [ctx.step.id]: stepOutput },
          // Why: re-publish the top-level `group.*` shape so downstream
          // template-only refs keep resolving on the no-op retick (same as
          // the first-pass success branch below).
          group: existing.groupContext
        }
      }
    }

    // Why: validate up-front so a missing members array fails the step cleanly
    // rather than throwing inside the IPC layer with a less-targeted message.
    if (!Array.isArray(config.members) || config.members.length < 2) {
      return {
        outcome: 'failed',
        status: 'failed',
        error: 'CreateWorkspaceGroupRunner: at least 2 members are required.'
      }
    }

    let branchName: string
    let displayName: string
    let memberInputs: { repoId: string; baseBranch: string; setupDecision: SetupDecision }[]
    try {
      branchName = resolveTemplate(config.branchName, ctx.context)
      // Why: displayName falls back to branchName when omitted so the group
      // card has a sensible label without forcing every legacy upgrade path
      // to synthesize one. Templates still resolve when an explicit value is
      // provided.
      displayName = config.displayName
        ? resolveTemplate(config.displayName, ctx.context)
        : branchName
      memberInputs = config.members.map((member) => ({
        repoId: member.repoId,
        baseBranch: resolveTemplate(member.baseBranch, ctx.context),
        // Why: default to 'run' so chains can pair with a downstream
        // wait-for-setup step without each composer having to spell it out.
        setupDecision: member.setupDecision ?? 'run'
      }))
    } catch (e) {
      if (e instanceof TemplateResolutionError) {
        return { outcome: 'failed', status: 'failed', error: e.message }
      }
      throw e
    }

    const linkedIssue = config.linkLinearIssue ? extractLinearIssue(ctx.context) : null

    try {
      const result = await this.deps.createWorkspaceGroup({
        branchName,
        displayName,
        members: memberInputs,
        linkedIssue,
        createdByAutomationRunId: ctx.runId
      })
      // Why: synthesize the templating-shape view here rather than at every
      // template-resolve site so the per-member primitives (worktreeId, path,
      // scoped ref) are computed exactly once per chain run. Builds against a
      // minimal WorkspaceGroup shape since the IPC dep only hands us back the
      // three id-ish fields — buildGroupTemplateContext only reads those.
      const groupShape: Pick<WorkspaceGroup, 'id' | 'parentPath' | 'memberWorktreeIds'> = {
        id: result.groupId,
        parentPath: result.parentPath,
        memberWorktreeIds: result.memberWorktreeIds
      }
      const groupContext = buildGroupTemplateContext(
        groupShape as WorkspaceGroup,
        this.deps.getRepoDescription
      )
      const tracker: Tracker = {
        groupId: result.groupId,
        memberWorktreeIds: result.memberWorktreeIds,
        parentPath: result.parentPath,
        groupContext
      }
      if (!runTrackers) {
        runTrackers = new Map()
        this.trackers.set(ctx.runId, runTrackers)
      }
      runTrackers.set(ctx.step.id, tracker)
      // Why: split the step-output (kept narrow for the step's own consumers
      // and the run-summary) from the top-level `group` shape (used by any
      // downstream step's templates). The two namespaces live alongside each
      // other in context for the rest of the run.
      const stepOutput = {
        groupId: tracker.groupId,
        memberWorktreeIds: tracker.memberWorktreeIds,
        parentPath: tracker.parentPath
      }
      return {
        outcome: 'done',
        status: 'succeeded',
        output: stepOutput,
        contextPatch: {
          steps: { [ctx.step.id]: stepOutput },
          group: groupContext
        }
      }
    } catch (e) {
      // Why: createWorkspaceGroup errors are deterministic (namespace
      // collision, member rollback). Fail-fast rather than retry; the IPC
      // layer's own rollback path has already cleaned up any partial state.
      const message = e instanceof Error ? e.message : String(e)
      return { outcome: 'failed', status: 'failed', error: message }
    }
  }

  dropRun(runId: string): void {
    this.trackers.delete(runId)
  }

  dropStep(runId: string, stepId: string): void {
    const runTrackers = this.trackers.get(runId)
    if (!runTrackers) {
      return
    }
    runTrackers.delete(stepId)
    if (runTrackers.size === 0) {
      this.trackers.delete(runId)
    }
  }
}

function extractLinearIssue(
  context: Record<string, unknown>
): { provider: 'linear'; id: string } | null {
  const trigger = context.trigger
  if (!trigger || typeof trigger !== 'object') {
    return null
  }
  const linear = (trigger as Record<string, unknown>).linear
  if (!linear || typeof linear !== 'object') {
    return null
  }
  const issue = (linear as Record<string, unknown>).issue
  if (!issue || typeof issue !== 'object') {
    return null
  }
  const id = (issue as Record<string, unknown>).id
  if (typeof id !== 'string') {
    return null
  }
  return { provider: 'linear', id }
}
