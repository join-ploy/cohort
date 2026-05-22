import { ipcMain } from 'electron'
import type { TriggerSourceRegistry } from '../automations/trigger-sources/registry'
import type { SerializableTriggerSource, TriggerSourceId } from '../../shared/automations-types'

export function registerTriggerSourceHandlers(registry: TriggerSourceRegistry): void {
  // Why: strip the descriptor's non-serializable `fetchOptions` closure before
  // crossing the IPC boundary. The renderer learns whether options are
  // available via `hasFetchOptions` and calls the dedicated fetch handler
  // below when it actually needs them — avoids shipping a Linear client roundtrip
  // for every catalog listing.
  ipcMain.handle('triggerSources:list', (): SerializableTriggerSource[] =>
    registry.list().map((s) => ({
      id: s.id,
      displayName: s.displayName,
      fieldCatalog: s.fieldCatalog.map((d) => ({
        field: d.field,
        label: d.label,
        valueKind: d.valueKind,
        ops: d.ops,
        hasFetchOptions: typeof d.fetchOptions === 'function'
      }))
    }))
  )

  // Why: `since: 0` because the renderer doesn't have a watermark concept for
  // option lookups — option lists are point-in-time UI affordances, not poll
  // checkpoints. `hostId` defaults to 'local' to match AutoTriggerEngine's
  // current single-host wiring; SSH host targeting is a follow-up.
  ipcMain.handle(
    'triggerSources:fetchOptions',
    async (
      _event,
      args: { sourceId: TriggerSourceId; field: string; hostId?: string }
    ): Promise<{ value: string; label: string }[]> => {
      const source = registry.get(args.sourceId)
      if (!source) {
        return []
      }
      const descriptor = source.fieldCatalog.find((d) => d.field === args.field)
      if (!descriptor || !descriptor.fetchOptions) {
        return []
      }
      return descriptor.fetchOptions({ since: 0, hostId: args.hostId ?? 'local' })
    }
  )
}
