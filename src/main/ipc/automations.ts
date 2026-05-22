import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { AutomationService } from '../automations/service'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationRun,
  AutomationUpdateInput,
  AutoDedupEntry,
  RunNowPayload
} from '../../shared/automations-types'

export function registerAutomationHandlers(store: Store, service: AutomationService): void {
  ipcMain.handle('automations:list', (): Automation[] => store.listAutomations())
  ipcMain.handle(
    'automations:listRuns',
    (_event, args?: { automationId?: string }): AutomationRun[] =>
      store.listAutomationRuns(args?.automationId)
  )
  ipcMain.handle(
    'automations:create',
    (_event, input: AutomationCreateInput): Automation => store.createAutomation(input)
  )
  ipcMain.handle(
    'automations:update',
    (_event, args: { id: string; updates: AutomationUpdateInput }): Automation =>
      store.updateAutomation(args.id, args.updates)
  )
  ipcMain.handle('automations:delete', (_event, args: { id: string }): void => {
    store.deleteAutomation(args.id)
  })
  ipcMain.handle(
    'automations:runNow',
    (_event, args: { id: string; payload?: RunNowPayload }): Promise<AutomationRun> =>
      service.runNow(args.id, args.payload)
  )
  ipcMain.handle(
    'automations:cancelRun',
    (_event, args: { runId: string }): AutomationRun | null => service.cancelRun(args.runId) ?? null
  )
  ipcMain.handle(
    'automations:retryRunFromStep',
    (_event, args: { runId: string; stepIndex: number }): AutomationRun | null =>
      service.retryRunFromStep(args.runId, args.stepIndex) ?? null
  )
  ipcMain.handle(
    'automations:restartRun',
    (_event, args: { runId: string }): Promise<AutomationRun> => service.restartRun(args.runId)
  )
  ipcMain.handle(
    'automations:markDispatchResult',
    (_event, result: AutomationDispatchResult): AutomationRun => service.markDispatchResult(result)
  )
  ipcMain.handle(
    'automations:listAutoDedup',
    (_event, args?: { automationId?: string; autoTriggerId?: string }): AutoDedupEntry[] =>
      store.listAutomationAutoDedup(args?.automationId, args?.autoTriggerId)
  )
  ipcMain.handle(
    'automations:clearAutoDedup',
    (_event, args: { automationId: string; autoTriggerId: string; entityId?: string }): void => {
      store.clearAutomationAutoDedup(args.automationId, args.autoTriggerId, args.entityId)
    }
  )
  ipcMain.handle('automations:rendererReady', (): void => {
    service.setRendererReady()
  })
}
