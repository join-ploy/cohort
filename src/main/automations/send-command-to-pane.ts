import type { IpcMain, IpcMainEvent, WebContents } from 'electron'

export type SendCommandToPaneRequest = {
  paneKey: string
  source: 'review' | 'create-pr' | 'custom'
  /** Stable id of the configured SidebarPromptCommand under
   *  `settings.reviewCommands` or `settings.createPrCommands`. Required when
   *  source is 'review' or 'create-pr'. */
  commandId?: string
  /** Raw shell command line. Required when source is 'custom'; ignored
   *  otherwise. */
  customCommand?: string
  /** Worktree the command is contextually associated with — used by the
   *  renderer to look up repo-scoped preferences (review/create-pr) when
   *  resolving the final command body. */
  worktreeId: string
}

export type SendCommandToPaneReply = { ok: true } | { ok: false; error: string }

/**
 * Renderer-side failure that's deterministic — pane gone, command id
 * unknown, write rejected. The chain executor fails-fast on these (same as
 * `OpenCommandPaneError`); transient infra failures re-throw as plain Errors
 * so the executor retries on the next tick.
 */
export class SendCommandToPaneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SendCommandToPaneError'
  }
}

export type SendCommandToPaneIpc = Pick<IpcMain, 'once' | 'removeAllListeners'>

export type SendCommandToPaneDeps = {
  webContents: WebContents
  ipc: SendCommandToPaneIpc
  requestId: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Ask the renderer to resolve a Review / Create PR / custom command and
 * write it (with a trailing newline so Enter is pressed) into an existing
 * pane's PTY, instead of spawning a new pane. The renderer reuses the same
 * command resolution as `openCommandPane` (settings lookup, hooks
 * preferences, prompt-body write) so a `paneRef` step behaves identically
 * to its open-new-pane counterpart.
 */
export function sendCommandToPane(
  req: SendCommandToPaneRequest,
  deps: SendCommandToPaneDeps
): Promise<void> {
  if (!deps.webContents || deps.webContents.isDestroyed()) {
    return Promise.reject(new Error('No renderer available to send command to pane.'))
  }
  const channel = `automations:sendCommandToPane:reply:${deps.requestId}`
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      deps.ipc.removeAllListeners(channel)
      reject(new Error(`Renderer did not respond to sendCommandToPane within ${timeoutMs}ms.`))
    }, timeoutMs)
    deps.ipc.once(channel, (_event: IpcMainEvent, payload: SendCommandToPaneReply) => {
      clearTimeout(timer)
      if (payload.ok) {
        resolve()
      } else {
        reject(new SendCommandToPaneError(payload.error))
      }
    })
    deps.webContents.send('automations:sendCommandToPane', { requestId: deps.requestId, ...req })
  })
}
