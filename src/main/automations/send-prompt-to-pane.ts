import type { IpcMain, IpcMainEvent, WebContents } from 'electron'

export type SendPromptToPaneRequest = {
  paneKey: string
  prompt: string
}

/**
 * Discriminated reply from the renderer. Success is a bare ack; failure
 * carries a human-readable reason that the chain executor surfaces verbatim
 * as the step's `error`.
 */
export type SendPromptToPaneReply = { ok: true } | { ok: false; error: string }

/**
 * Renderer-side failure that's deterministic — pane gone, worktree gone,
 * write rejected, etc. The chain executor fails-fast on these (same as
 * `OpenPromptPaneError`); retrying can't recover. Distinct class so callers
 * can branch on it without string-matching the error message, and distinct
 * from the plain `Error` used for transient/infrastructure issues
 * (destroyed webContents, timeout) which the executor retries.
 */
export class SendPromptToPaneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SendPromptToPaneError'
  }
}

/**
 * Subset of {@link IpcMain} that the helper depends on. Narrowing the surface
 * here lets tests pass a tiny fake without faking the full Electron module.
 */
export type SendPromptToPaneIpc = Pick<IpcMain, 'once' | 'removeAllListeners'>

export type SendPromptToPaneDeps = {
  webContents: WebContents
  ipc: SendPromptToPaneIpc
  requestId: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Ask the renderer to write a prompt into an already-open prompt pane (one
 * previously returned by {@link openPromptPane}), so a chain step can reuse a
 * live agent session instead of spawning a new tab. The renderer resolves the
 * paneKey to a live ptyId and writes `prompt + '\n'` so the agent receives
 * the submission.
 *
 * Each call uses a requestId-scoped reply channel so concurrent calls cannot
 * race on a shared listener.
 */
export function sendPromptToPane(
  req: SendPromptToPaneRequest,
  deps: SendPromptToPaneDeps
): Promise<void> {
  if (!deps.webContents || deps.webContents.isDestroyed()) {
    return Promise.reject(new Error('No renderer available to send prompt to pane.'))
  }
  const channel = `automations:sendPromptToPane:reply:${deps.requestId}`
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Why: drop the listener so a late renderer reply cannot resolve a
      // promise the caller has already given up on.
      deps.ipc.removeAllListeners(channel)
      reject(new Error(`Renderer did not respond to sendPromptToPane within ${timeoutMs}ms.`))
    }, timeoutMs)
    deps.ipc.once(channel, (_event: IpcMainEvent, payload: SendPromptToPaneReply) => {
      clearTimeout(timer)
      // Why: branch on the discriminant so deterministic renderer failures
      // surface as SendPromptToPaneError (fail-fast) and stay distinct from
      // transient infrastructure failures above (retry on next tick).
      if (payload.ok) {
        resolve()
      } else {
        reject(new SendPromptToPaneError(payload.error))
      }
    })
    deps.webContents.send('automations:sendPromptToPane', { requestId: deps.requestId, ...req })
  })
}
