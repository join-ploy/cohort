import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { AutomationService } from '../automations/service'
import {
  maskAutoTriggers,
  sealAutoTriggers,
  sealHttpRequestSteps,
  maskHttpRequestSteps
} from '../automations/http-endpoint-secrets'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationRun,
  AutomationUpdateInput,
  AutoDedupEntry,
  RunNowPayload,
  TriggerPollStatus
} from '../../shared/automations-types'

export function registerAutomationHandlers(store: Store, service: AutomationService): void {
  // Why: http trigger AND http-request step request secrets are sealed (ciphertext)
  // at rest and must be masked before any automation crosses to the renderer; on
  // save we re-seal against the PRIOR stored trigger/step so an unchanged (masked)
  // secret keeps its ciphertext instead of being overwritten with the mask sentinel.
  const maskAutomation = (a: Automation): Automation => ({
    ...a,
    autoTriggers: maskAutoTriggers(a.autoTriggers),
    steps: maskHttpRequestSteps(a.steps)
  })
  const sealInput = (input: AutomationCreateInput): AutomationCreateInput => ({
    ...input,
    autoTriggers: sealAutoTriggers(input.autoTriggers, undefined),
    steps: sealHttpRequestSteps(input.steps, undefined)
  })
  const sealUpdates = (id: string, updates: AutomationUpdateInput): AutomationUpdateInput => {
    const touchesTriggers = 'autoTriggers' in updates
    const touchesSteps = 'steps' in updates
    if (!touchesTriggers && !touchesSteps) {
      return updates
    }
    const prior = store.listAutomations().find((a) => a.id === id)
    const sealed: AutomationUpdateInput = { ...updates }
    if (touchesTriggers) {
      sealed.autoTriggers = sealAutoTriggers(updates.autoTriggers, prior?.autoTriggers)
    }
    if (touchesSteps) {
      sealed.steps = sealHttpRequestSteps(updates.steps, prior?.steps)
    }
    return sealed
  }

  ipcMain.handle('automations:list', (): Automation[] =>
    store.listAutomations().map(maskAutomation)
  )
  ipcMain.handle(
    'automations:listRuns',
    (_event, args?: { automationId?: string }): AutomationRun[] =>
      store.listAutomationRuns(args?.automationId)
  )
  ipcMain.handle(
    'automations:create',
    (_event, input: AutomationCreateInput): Automation =>
      maskAutomation(store.createAutomation(sealInput(input)))
  )
  ipcMain.handle(
    'automations:update',
    (_event, args: { id: string; updates: AutomationUpdateInput }): Automation =>
      maskAutomation(store.updateAutomation(args.id, sealUpdates(args.id, args.updates)))
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
    'automations:retryParallelStep',
    (_event, args: { runId: string; stepId: string }): AutomationRun | null =>
      service.retryParallelStep(args.runId, args.stepId) ?? null
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
  ipcMain.handle('automations:triggerPollStatus', (): TriggerPollStatus[] =>
    service.getTriggerPollStatus()
  )
}
