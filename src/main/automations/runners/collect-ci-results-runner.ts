import type { StepRunner, StepRunnerCtx, StepRunnerResult } from '../step-runner'
import type { CollectCiResultsConfig } from '../../../shared/automations-types'
import type { PRCheckDetail, PRComment, WorkspaceGroup } from '../../../shared/types'
import { parseMemberScopedRef } from '../../../shared/automation-member-scoped-ref'
import { findGroupById } from '../../workspace-group-runtime'
import { resolveTemplate, TemplateResolutionError } from '../template'

export type CollectCiResultsDeps = {
  getWorktreeMeta: (
    worktreeId: string
  ) => { linkedPR: number | null; path: string; repoPath: string } | undefined
  getWorkspaceGroups: () => readonly WorkspaceGroup[]
  hasChangesFromMain: (
    worktreeId: string,
    path: string,
    connectionId: string | null
  ) => Promise<boolean>
  getPRChecks: (repoPath: string, prNumber: number) => Promise<PRCheckDetail[]>
  getPRComments: (repoPath: string, prNumber: number) => Promise<PRComment[]>
  getRepoPath: (repoId: string) => string | undefined
  getConnectionId: (repoId: string) => string | null
  /** Fallback PR lookup when meta.linkedPR is null — checks the GitHub cache
   *  and/or queries the gh CLI by worktree branch. */
  resolveLinkedPR: (worktreePath: string, repoPath: string) => Promise<number | null>
  now: () => number
}

type PRTarget = {
  worktreeId: string
  repoPath: string
  prNumber: number
}

type CiTracker = {
  phase: 'resolving-targets' | 'waiting-for-prs' | 'waiting-for-ci' | 'collecting'
  eligibleWorktreeIds: string[]
  resolvedTargets: PRTarget[]
  lastPollAt: number
  startedAt: number
}

export class CollectCiResultsRunner implements StepRunner {
  private readonly trackers = new Map<string, Map<string, CiTracker>>()

  constructor(private readonly deps: CollectCiResultsDeps) {}

  async tick(ctx: StepRunnerCtx): Promise<StepRunnerResult> {
    const config = ctx.step.config as CollectCiResultsConfig

    let resolvedRef: string
    try {
      resolvedRef = resolveTemplate(config.worktreeRef, ctx.context)
    } catch (e) {
      if (e instanceof TemplateResolutionError) {
        return { outcome: 'failed', status: 'failed', error: e.message }
      }
      throw e
    }

    let runTrackers = this.trackers.get(ctx.runId)
    let tracker = runTrackers?.get(ctx.step.id)
    if (!tracker) {
      tracker = {
        phase: 'resolving-targets',
        eligibleWorktreeIds: [],
        resolvedTargets: [],
        lastPollAt: 0,
        startedAt: this.deps.now()
      }
      if (!runTrackers) {
        runTrackers = new Map()
        this.trackers.set(ctx.runId, runTrackers)
      }
      runTrackers.set(ctx.step.id, tracker)
    }

    const now = this.deps.now()

    if (ctx.step.timeoutSeconds != null) {
      const elapsedMs = now - tracker.startedAt
      if (elapsedMs >= ctx.step.timeoutSeconds * 1000) {
        return {
          outcome: 'failed',
          status: 'timed-out',
          error: `Step exceeded timeout of ${ctx.step.timeoutSeconds}s.`
        }
      }
    }

    const pollIntervalMs = (config.pollIntervalSeconds ?? 30) * 1000

    // ── Phase 1: resolving-targets ──────────────────────────────────────
    if (tracker.phase === 'resolving-targets') {
      const worktreeIds = this.expandRef(resolvedRef)
      if (!worktreeIds) {
        return {
          outcome: 'failed',
          status: 'failed',
          error: `Could not resolve worktreeRef "${resolvedRef}".`
        }
      }

      // Filter to worktrees that have changes from main (no changes = no PR expected)
      const eligible: string[] = []
      for (const id of worktreeIds) {
        const repoId = id.split('::')[0]
        const meta = this.deps.getWorktreeMeta(id)
        if (!meta) {
          continue
        }
        const connectionId = this.deps.getConnectionId(repoId)
        const hasChanges = await this.deps.hasChangesFromMain(id, meta.path, connectionId)
        if (hasChanges) {
          eligible.push(id)
        }
      }

      if (eligible.length === 0) {
        return {
          outcome: 'done',
          status: 'succeeded',
          output: {
            summary: 'No worktrees with changes from main — nothing to collect.',
            checksJson: '[]',
            commentsJson: '[]',
            failedChecks: '',
            hasFailures: false,
            prCount: 0
          },
          contextPatch: {
            steps: {
              [ctx.step.id]: {
                summary: 'No worktrees with changes from main — nothing to collect.',
                checksJson: '[]',
                commentsJson: '[]',
                failedChecks: '',
                hasFailures: false,
                prCount: 0
              }
            }
          }
        }
      }

      tracker.eligibleWorktreeIds = eligible
      tracker.phase = 'waiting-for-prs'
    }

    // ── Phase 2: waiting-for-prs ────────────────────────────────────────
    if (tracker.phase === 'waiting-for-prs') {
      const targets: PRTarget[] = []
      for (const id of tracker.eligibleWorktreeIds) {
        const meta = this.deps.getWorktreeMeta(id)
        if (!meta) {
          continue
        }
        const repoId = id.split('::')[0]
        const repoPath = this.deps.getRepoPath(repoId) ?? meta.repoPath
        let prNumber = meta.linkedPR
        if (prNumber == null) {
          prNumber = await this.deps.resolveLinkedPR(meta.path, repoPath)
        }
        if (prNumber == null) {
          return { outcome: 'needs-more-time', status: 'waiting' }
        }
        targets.push({ worktreeId: id, repoPath, prNumber })
      }

      tracker.resolvedTargets = targets
      tracker.phase = 'waiting-for-ci'
    }

    // ── Phase 3: waiting-for-ci ─────────────────────────────────────────
    if (tracker.phase === 'waiting-for-ci') {
      if (now - tracker.lastPollAt < pollIntervalMs) {
        return { outcome: 'needs-more-time', status: 'waiting' }
      }
      tracker.lastPollAt = now

      for (const target of tracker.resolvedTargets) {
        const checks = await this.deps.getPRChecks(target.repoPath, target.prNumber)
        if (checks.some((c) => c.status !== 'completed')) {
          return { outcome: 'needs-more-time', status: 'waiting' }
        }
      }

      tracker.phase = 'collecting'
    }

    // ── Phase 4: collecting ─────────────────────────────────────────────
    const allChecks: { prNumber: number; repoPath: string; checks: PRCheckDetail[] }[] = []
    const allComments: { prNumber: number; repoPath: string; comments: PRComment[] }[] = []

    for (const target of tracker.resolvedTargets) {
      const checks = await this.deps.getPRChecks(target.repoPath, target.prNumber)
      allChecks.push({ prNumber: target.prNumber, repoPath: target.repoPath, checks })

      if (config.includeComments) {
        const comments = await this.deps.getPRComments(target.repoPath, target.prNumber)
        allComments.push({ prNumber: target.prNumber, repoPath: target.repoPath, comments })
      }
    }

    const failedCheckNames = allChecks
      .flatMap((e) => e.checks)
      .filter(
        (c) =>
          c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled'
      )
      .map((c) => c.name)

    const output = {
      summary: buildSummary(allChecks, allComments),
      checksJson: JSON.stringify(allChecks),
      commentsJson: JSON.stringify(allComments),
      failedChecks: failedCheckNames.join(', '),
      hasFailures: failedCheckNames.length > 0,
      prCount: tracker.resolvedTargets.length
    }

    return {
      outcome: 'done',
      status: 'succeeded',
      output,
      contextPatch: { steps: { [ctx.step.id]: output } }
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

  /** Expand a resolved worktreeRef into one or more worktreeIds. */
  private expandRef(ref: string): string[] | null {
    const memberScoped = parseMemberScopedRef(ref)
    if (memberScoped) {
      return [memberScoped.worktreeId]
    }

    if (ref.startsWith('group:')) {
      const groups = this.deps.getWorkspaceGroups()
      const group = findGroupById(ref, groups)
      if (!group) {
        return null
      }
      return group.memberWorktreeIds
    }

    // Single worktreeId
    return [ref]
  }
}

function buildSummary(
  allChecks: { prNumber: number; repoPath: string; checks: PRCheckDetail[] }[],
  allComments: { prNumber: number; repoPath: string; comments: PRComment[] }[]
): string {
  const sections: string[] = []

  for (const entry of allChecks) {
    const repoName = entry.repoPath.split('/').pop() ?? entry.repoPath
    const failed = entry.checks.filter(
      (c) =>
        c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled'
    )
    const passed = entry.checks.filter(
      (c) => c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped'
    )

    sections.push(
      `## PR #${entry.prNumber} (${repoName}) — ${failed.length} failed, ${passed.length} passed`
    )

    if (entry.checks.length > 0) {
      sections.push('| Check | Status |')
      sections.push('| --- | --- |')
      for (const check of entry.checks) {
        sections.push(`| ${check.name} | ${check.conclusion ?? 'pending'} |`)
      }
    }

    const commentEntry = allComments.find(
      (c) => c.prNumber === entry.prNumber && c.repoPath === entry.repoPath
    )
    if (commentEntry && commentEntry.comments.length > 0) {
      sections.push('')
      sections.push(`### Comments (${commentEntry.comments.length})`)
      for (const comment of commentEntry.comments) {
        const location = comment.path
          ? `${comment.path}${comment.line != null ? `:${comment.line}` : ''}`
          : 'conversation'
        const firstLine = comment.body.split('\n')[0]
        sections.push(`- **${comment.author}** (${location})`)
        sections.push(`  > ${firstLine}`)
      }
    }

    sections.push('')
  }

  return sections.join('\n').trim()
}
