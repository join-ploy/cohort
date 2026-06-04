import type { Automation, AutoTrigger, Rule, TriggerSourceId } from '../../shared/automations-types'
import { firstMatch } from './rule-evaluator'
import type { CandidateEvent, TriggerSource } from './trigger-sources/types'
import type { TriggerSourceRegistry } from './trigger-sources/registry'

export type AutoTriggerEngineDeps = {
  registry: TriggerSourceRegistry
  listAutomations: () => Automation[]
  dispatchAutoRun: (args: {
    automation: Automation
    trigger: AutoTrigger
    rule: Rule
    event: CandidateEvent
  }) => Promise<void> | void
  dedupHas: (automationId: string, autoTriggerId: string, entityId: string) => boolean
  dedupInsert: (
    automationId: string,
    autoTriggerId: string,
    sourceId: TriggerSourceId,
    entityId: string,
    entityIdentifier: string | undefined,
    firedAt: number
  ) => void
  lastPoll: (sourceId: TriggerSourceId, hostId: string) => number
  lastPollSet: (sourceId: TriggerSourceId, hostId: string, value: number) => void
  hostId: string
  now: () => number
  /** Optional logger; defaults to console.warn for errors. */
  onError?: (where: string, err: unknown) => void
}

type ActiveEntry = { automation: Automation; trigger: AutoTrigger }

// Union of all watching triggers' repoIds; undefined when none scope by repo
// (so a global source like linear-issue receives no repo filter).
function unionRepoIds(group: ActiveEntry[]): string[] | undefined {
  const set = new Set<string>()
  for (const { trigger } of group) {
    for (const id of trigger.repoIds ?? []) {
      set.add(id)
    }
  }
  return set.size > 0 ? Array.from(set) : undefined
}

export class AutoTriggerEngine {
  private readonly deps: AutoTriggerEngineDeps
  private timer: ReturnType<typeof setInterval> | null = null
  // Why: mutex flag so a slow tick can't overlap with the next setInterval
  // fire; concurrent ticks return immediately (skip, not queue).
  private ticking = false

  constructor(deps: AutoTriggerEngineDeps) {
    this.deps = deps
  }

  private intervalMs = 0

  start(intervalMs: number): void {
    if (this.timer) {
      return
    }
    this.intervalMs = intervalMs
    this.timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return
    }
    this.ticking = true
    try {
      const automations = this.deps.listAutomations()
      const active: ActiveEntry[] = []
      for (const a of automations) {
        // Why: auto-triggers require chain-shape automations (dispatchRun only
        // supports those). Skip legacy automations entirely so we don't write
        // dedup rows for runs we can't actually dispatch.
        if (!a.trigger || !a.steps || a.steps.length === 0) {
          continue
        }
        for (const t of a.autoTriggers ?? []) {
          if (t.enabled) {
            active.push({ automation: a, trigger: t })
          }
        }
      }
      if (active.length === 0) {
        return
      }

      // Why: group active triggers by source so we poll each source once per
      // tick even when multiple automations share it.
      const bySource = new Map<TriggerSourceId, ActiveEntry[]>()
      for (const entry of active) {
        const list = bySource.get(entry.trigger.source) ?? []
        list.push(entry)
        bySource.set(entry.trigger.source, list)
      }

      for (const [sourceId, group] of bySource) {
        try {
          const source = this.deps.registry.get(sourceId)
          if (!source) {
            continue
          }
          // Why: pick the oldest per-trigger watermark in the group as the
          // source-level `since`; the per-trigger enabledAt filter inside the
          // loop catches any newer-enabledAt triggers in the same group.
          const watermarks = group.map(({ trigger }) =>
            Math.max(trigger.enabledAt, this.deps.lastPoll(sourceId, this.deps.hostId))
          )
          const since = Math.min(...watermarks)
          await this.pollSource(source, sourceId, group, since, unionRepoIds(group))
          this.deps.lastPollSet(sourceId, this.deps.hostId, this.deps.now())
        } catch (err) {
          this.reportError(`tick:source(${sourceId})`, err)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private async pollSource(
    source: TriggerSource,
    sourceId: TriggerSourceId,
    group: ActiveEntry[],
    since: number,
    repoIds: string[] | undefined
  ): Promise<void> {
    for await (const event of source.poll({ since, hostId: this.deps.hostId, repoIds })) {
      try {
        // Belt-and-suspenders: skip events at or before the source-level
        // watermark in case the source's filter is sloppy.
        if (event.updatedAt <= since) {
          continue
        }
        for (const { automation, trigger } of group) {
          if (event.updatedAt < trigger.enabledAt) {
            continue
          }
          // Watch-list guard: a repo-bound event only fires triggers watching it.
          if (trigger.repoIds?.length && event.repoId && !trigger.repoIds.includes(event.repoId)) {
            continue
          }
          if (this.deps.dedupHas(automation.id, trigger.id, event.entityId)) {
            continue
          }
          const rule = firstMatch(trigger.rules, event)
          if (!rule) {
            continue
          }
          // Why: insert dedup BEFORE dispatch so a crash mid-dispatch can't
          // re-fire the same (automation, trigger, entity) tuple on retry.
          this.deps.dedupInsert(
            automation.id,
            trigger.id,
            trigger.source,
            event.entityId,
            event.entityIdentifier,
            this.deps.now()
          )
          await this.deps.dispatchAutoRun({ automation, trigger, rule, event })
        }
      } catch (err) {
        this.reportError(`tick:event(${sourceId}:${event.entityId})`, err)
      }
    }
  }

  /** Snapshot of current poll timing for each active source. */
  getPollStatus(): Map<TriggerSourceId, { lastPollAt: number; intervalMs: number }> {
    const result = new Map<TriggerSourceId, { lastPollAt: number; intervalMs: number }>()
    const automations = this.deps.listAutomations()
    for (const a of automations) {
      if (!a.trigger || !a.steps || a.steps.length === 0) {
        continue
      }
      for (const t of a.autoTriggers ?? []) {
        if (t.enabled && !result.has(t.source)) {
          result.set(t.source, {
            lastPollAt: this.deps.lastPoll(t.source, this.deps.hostId),
            intervalMs: this.intervalMs
          })
        }
      }
    }
    return result
  }

  private reportError(where: string, err: unknown): void {
    if (this.deps.onError) {
      this.deps.onError(where, err)
    } else {
      console.warn(`[auto-trigger-engine] ${where}:`, err)
    }
  }
}
