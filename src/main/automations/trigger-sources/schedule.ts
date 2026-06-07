import type { CandidateEvent, PollCtx, TriggerSource } from './types'

// Time-driven source: it has no external entity, so the engine decides WHEN to
// poll (the fire instant arrives as ctx.since) and this just shapes the event.
// entityId is the occurrence's ISO instant so dedup makes each instant idempotent.
export function makeScheduleSource(): TriggerSource {
  async function* poll(ctx: PollCtx): AsyncIterable<CandidateEvent> {
    if (!ctx.schedule) {
      return
    }
    const scheduledFor = ctx.since
    const firedAt = ctx.now ?? scheduledFor
    yield {
      entityId: new Date(scheduledFor).toISOString(),
      updatedAt: scheduledFor,
      payload: {
        schedule: {
          firedAt,
          scheduledFor,
          cron: ctx.schedule.cron,
          timezone: ctx.schedule.timezone
        }
      },
      fields: {}
    }
  }
  return { id: 'schedule', displayName: 'Schedule', fieldCatalog: [], poll }
}
