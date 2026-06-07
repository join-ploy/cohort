import type { Automation, AutoTrigger, Rule, TriggerSourceId } from '../../shared/automations-types'
import { firstMatch } from './rule-evaluator'
import type { CandidateEvent, TriggerSource } from './trigger-sources/types'
import type { TriggerSourceRegistry } from './trigger-sources/registry'
import { nextOccurrenceAfter } from '../../shared/schedule-cron'

// Fire an instant only if it came due within this window — longer than a tick so
// jitter still fires, short enough that a closed/asleep/disabled gap is skipped.
const SCHEDULE_MAX_LATENESS_MS = 5 * 60_000

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
  // Per-http-trigger interval gate clock (in-memory, keyed by trigger id).
  httpLastPoll: (triggerId: string) => number
  httpLastPollSet: (triggerId: string, value: number) => void
  // Per-schedule-trigger next-fire instant (in-memory; re-anchored each process
  // start, which is how skip-missed drops instants from while the app was closed).
  scheduleNextRun: (triggerId: string) => number
  scheduleNextRunSet: (triggerId: string, value: number) => void
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
        // Why: honor the automation-level pause (enabled=false) — like the rrule
        // scheduler does — so a paused automation's auto-triggers stop firing.
        // Also require chain-shape automations (dispatchRun only supports those)
        // so we don't write dedup rows for runs we can't actually dispatch.
        if (!a.enabled || !a.trigger || !a.steps || a.steps.length === 0) {
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

      // Why: http-endpoint triggers each carry their own endpoint + interval, so
      // they poll per-trigger; every other source keeps the shared grouped poll.
      const httpEntries = active.filter(
        (e) => e.trigger.source === 'http-endpoint' && (e.trigger.pollingEnabled ?? true)
      )
      // Why: schedule triggers are time-driven (the engine owns the fire instant),
      // so they poll per-trigger like http and stay out of the shared grouped poll.
      const scheduleEntries = active.filter((e) => e.trigger.source === 'schedule')
      const sharedEntries = active.filter(
        (e) => e.trigger.source !== 'http-endpoint' && e.trigger.source !== 'schedule'
      )

      // Why: group active triggers by source so we poll each source once per
      // tick even when multiple automations share it.
      const bySource = new Map<TriggerSourceId, ActiveEntry[]>()
      for (const entry of sharedEntries) {
        const list = bySource.get(entry.trigger.source) ?? []
        list.push(entry)
        bySource.set(entry.trigger.source, list)
      }

      for (const entry of httpEntries) {
        try {
          await this.pollHttpTrigger(entry)
        } catch (err) {
          this.reportError(`tick:http(${entry.trigger.id})`, err)
        }
      }

      for (const entry of scheduleEntries) {
        try {
          await this.pollScheduleTrigger(entry)
        } catch (err) {
          this.reportError(`tick:schedule(${entry.trigger.id})`, err)
        }
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

  // Poll a single http-endpoint trigger against its own endpoint + interval.
  private async pollHttpTrigger(entry: ActiveEntry): Promise<void> {
    const { automation, trigger } = entry
    if (!trigger.http) {
      return
    }
    const nowMs = this.deps.now()
    const intervalMs = trigger.http.intervalMs ?? this.intervalMs
    if (nowMs - this.deps.httpLastPoll(trigger.id) < intervalMs) {
      return
    }
    // Why: stamp the clock BEFORE polling so a FAILING endpoint still honors its
    // interval — the clock advances even when poll() throws, so a broken endpoint
    // isn't re-hit every tick. (Duplicate dispatch is guarded by dedup, not this.)
    this.deps.httpLastPollSet(trigger.id, nowMs)

    const source = this.deps.registry.get('http-endpoint')
    if (!source) {
      return
    }
    for await (const event of source.poll({
      since: trigger.enabledAt,
      hostId: this.deps.hostId,
      http: trigger.http
    })) {
      try {
        if (this.deps.dedupHas(automation.id, trigger.id, event.entityId)) {
          continue
        }
        // Why: an http trigger with no conditions runs on every item, so treat an
        // empty rules array as one implicit match targeting the automation project.
        const rule =
          trigger.rules.length === 0
            ? { id: 'implicit', conditions: [], projectId: automation.projectId }
            : firstMatch(trigger.rules, event)
        if (!rule) {
          continue
        }
        // Why: insert dedup BEFORE dispatch so a crash mid-dispatch can't re-fire
        // the same (automation, trigger, entity) tuple on retry.
        this.deps.dedupInsert(
          automation.id,
          trigger.id,
          trigger.source,
          event.entityId,
          event.entityIdentifier,
          this.deps.now()
        )
        await this.deps.dispatchAutoRun({ automation, trigger, rule, event })
      } catch (err) {
        this.reportError(`tick:http-event(${trigger.id}:${event.entityId})`, err)
      }
    }
  }

  // Fire a single schedule trigger when its next instant elapses live. State is
  // in-memory: a fresh process re-anchors to the next FUTURE occurrence, and the
  // lateness guard drops instants missed while asleep/disabled — both "skip-missed".
  private async pollScheduleTrigger(entry: ActiveEntry): Promise<void> {
    const { automation, trigger } = entry
    if (!trigger.schedule) {
      return
    }
    const { cron, timezone } = trigger.schedule
    const nowMs = this.deps.now()
    const nextRunAt = this.deps.scheduleNextRun(trigger.id)

    if (nextRunAt === 0) {
      // First observation this process: anchor strictly in the future.
      // Anchoring strictly in the future means a trigger created in the ~1 tick before
      // its first occurrence will skip that occurrence — an accepted skip-missed cost.
      const anchor = nextOccurrenceAfter(cron, timezone, Math.max(nowMs, trigger.enabledAt))
      if (anchor !== null) {
        this.deps.scheduleNextRunSet(trigger.id, anchor)
      }
      return
    }
    if (nowMs < nextRunAt) {
      return
    }
    if (nowMs - nextRunAt > SCHEDULE_MAX_LATENESS_MS) {
      // Missed (sleep/disable/long tick gap): re-anchor without firing.
      const next = nextOccurrenceAfter(cron, timezone, nowMs)
      if (next !== null) {
        this.deps.scheduleNextRunSet(trigger.id, next)
      }
      return
    }

    // Due and fresh: advance the clock BEFORE dispatch so a slow/failed dispatch
    // can't re-fire this instant.
    const next = nextOccurrenceAfter(cron, timezone, nowMs)
    if (next !== null) {
      this.deps.scheduleNextRunSet(trigger.id, next)
    }

    const source = this.deps.registry.get('schedule')
    if (!source) {
      return
    }
    for await (const event of source.poll({
      since: nextRunAt,
      now: nowMs,
      hostId: this.deps.hostId,
      schedule: trigger.schedule
    })) {
      try {
        if (this.deps.dedupHas(automation.id, trigger.id, event.entityId)) {
          continue
        }
        // No conditions: one implicit match targeting the automation's project.
        const rule = { id: 'implicit', conditions: [], projectId: automation.projectId }
        // Why: insert dedup BEFORE dispatch so a crash mid-dispatch can't re-fire.
        this.deps.dedupInsert(
          automation.id,
          trigger.id,
          trigger.source,
          event.entityId,
          event.entityIdentifier,
          this.deps.now()
        )
        await this.deps.dispatchAutoRun({ automation, trigger, rule, event })
      } catch (err) {
        this.reportError(`tick:schedule-event(${trigger.id}:${event.entityId})`, err)
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
        if (!t.enabled || result.has(t.source)) {
          continue
        }
        if (t.source === 'http-endpoint') {
          // Why: http triggers keep their own per-trigger clock + interval; the
          // source-keyed status reports the first such trigger (per-trigger
          // status is a follow-up). Reading lastPoll() here would always be 0.
          result.set(t.source, {
            lastPollAt: this.deps.httpLastPoll(t.id),
            intervalMs: t.http?.intervalMs ?? this.intervalMs
          })
        } else {
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
