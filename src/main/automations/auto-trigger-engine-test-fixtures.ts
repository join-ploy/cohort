import { AutoTriggerEngine } from './auto-trigger-engine'
import type { AutoTriggerEngineDeps } from './auto-trigger-engine'
import { TriggerSourceRegistry } from './trigger-sources/registry'
import type { Automation, AutoTrigger, Rule, Step } from '../../shared/automations-types'
import type { CandidateEvent, PollCtx, TriggerSource } from './trigger-sources/types'

export type DispatchedRecord = { automationId: string; ruleId: string; entityId: string }

// Why: auto-trigger engine now skips non-chain-shape automations, so the
// default fixture must carry a `trigger` + `steps` pair or every existing
// test would silently filter out its automation. Tests that exercise the
// legacy-shape branch explicitly override these to `undefined`.
const defaultChainStep: Step = {
  id: 's1',
  kind: 'wait-for-setup',
  config: { worktreeRef: 'wt-stub', requireSuccess: false },
  onFailure: 'halt',
  timeoutSeconds: null
}

export function makeAutomation(
  overrides: Partial<Automation> & { autoTriggers?: AutoTrigger[] } = {}
): Automation {
  return {
    id: overrides.id ?? 'a1',
    name: 'x',
    prompt: '',
    agentId: 'claude',
    projectId: 'p1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: 'main',
    timezone: 'UTC',
    rrule: '',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 5,
    createdAt: 0,
    updatedAt: 0,
    trigger: { kind: 'manual' },
    steps: [defaultChainStep],
    ...overrides
  }
}

export function makeRule(opts: {
  id: string
  projectId: string
  field?: string
  op?: Rule['conditions'][number]['op']
  value?: Rule['conditions'][number]['value']
}): Rule {
  return {
    id: opts.id,
    projectId: opts.projectId,
    conditions:
      opts.field == null ? [] : [{ field: opts.field, op: opts.op ?? 'is', value: opts.value ?? 1 }]
  }
}

export function makeFakeSource(events: CandidateEvent[]): TriggerSource {
  return {
    id: 'linear-issue',
    displayName: 'L',
    fieldCatalog: [],
    async *poll() {
      for (const e of events) {
        yield e
      }
    }
  }
}

// Like makeFakeSource but records the ctx each poll() call received, so tests
// can assert what the engine passed in (e.g. the repoIds union).
export function makeRecordingSource(events: CandidateEvent[]): TriggerSource & {
  polls: PollCtx[]
} {
  const polls: PollCtx[] = []
  return {
    id: 'linear-issue',
    displayName: 'L',
    fieldCatalog: [],
    polls,
    async *poll(ctx: PollCtx) {
      polls.push(ctx)
      for (const e of events) {
        yield e
      }
    }
  }
}

export type EngineHarness = {
  engine: AutoTriggerEngine
  dispatched: DispatchedRecord[]
  dedup: Set<string>
  lastPollMap: Map<string, number>
}

export function makeEngine(opts: {
  source: TriggerSource
  automations: Automation[]
  now?: number
  dedup?: Set<string>
  dispatched?: DispatchedRecord[]
  lastPollMap?: Map<string, number>
  onError?: AutoTriggerEngineDeps['onError']
}): EngineHarness {
  const registry = new TriggerSourceRegistry()
  registry.register(opts.source)
  const dedup = opts.dedup ?? new Set<string>()
  const dispatched = opts.dispatched ?? []
  const lastPollMap = opts.lastPollMap ?? new Map<string, number>()
  const engine = new AutoTriggerEngine({
    registry,
    listAutomations: () => opts.automations,
    dispatchAutoRun: ({ automation, rule, event }) => {
      dispatched.push({ automationId: automation.id, ruleId: rule.id, entityId: event.entityId })
    },
    dedupHas: (a, t, e) => dedup.has(`${a}|${t}|${e}`),
    dedupInsert: (a, t, _s, e) => {
      dedup.add(`${a}|${t}|${e}`)
    },
    lastPoll: (s, h) => lastPollMap.get(`${s}|${h}`) ?? 0,
    lastPollSet: (s, h, v) => {
      lastPollMap.set(`${s}|${h}`, v)
    },
    hostId: 'h1',
    now: () => opts.now ?? 2000,
    onError: opts.onError
  })
  return { engine, dispatched, dedup, lastPollMap }
}
