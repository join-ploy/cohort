import type { TriggerSourceId } from '../../../shared/automations-types'
import type { TriggerSource } from './types'

export class TriggerSourceRegistry {
  // Map preserves insertion order, which list() relies on so callers see
  // sources in the order they were registered.
  private readonly byId = new Map<TriggerSourceId, TriggerSource>()

  register(source: TriggerSource): void {
    if (this.byId.has(source.id)) {
      throw new Error(`Trigger source ${source.id} already registered`)
    }
    this.byId.set(source.id, source)
  }

  get(id: TriggerSourceId): TriggerSource | undefined {
    return this.byId.get(id)
  }

  list(): TriggerSource[] {
    return Array.from(this.byId.values())
  }
}
