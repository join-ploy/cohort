import type { IpcMain, IpcMainEvent, WebContents } from 'electron'

export type OpenPromptPaneRequest = {
  worktreeId: string
  agentId: string
  prompt: string
}

export type OpenPromptPaneResult = { paneKey: string }

/**
 * Discriminated reply from the renderer. Success carries the paneKey;
 * failure carries a human-readable reason that the chain executor surfaces
 * verbatim as the step's `error`.
 */
export type OpenPromptPaneReply = { ok: true; paneKey: string } | { ok: false; error: string }

/**
 * Renderer-side failure that's deterministic — bad worktreeId, bad agentId,
 * no startup plan, etc. The chain executor fails-fast on these (same as
 * `TemplateResolutionError`); retrying can't recover. Distinct class so
 * callers can branch on it without string-matching the error message, and
 * distinct from the plain `Error` used for transient/infrastructure issues
 * (destroyed webContents, timeout) which the executor retries.
 */
export class OpenPromptPaneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenPromptPaneError'
  }
}

/**
 * Subset of {@link IpcMain} that the helper depends on. Narrowing the surface
 * here lets tests pass a tiny fake without faking the full Electron module.
 */
export type OpenPromptPaneIpc = Pick<IpcMain, 'once' | 'removeAllListeners'>

export type OpenPromptPaneDeps = {
  webContents: WebContents
  ipc: OpenPromptPaneIpc
  requestId: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Ask the renderer to open a background tab in a worktree, launch the chosen
 * agent with the given prompt, and return the resulting paneKey so the
 * chain executor can track agent status.
 *
 * Each call uses a requestId-scoped reply channel so concurrent calls cannot
 * race on a shared listener.
 */
export function openPromptPane(
  req: OpenPromptPaneRequest,
  deps: OpenPromptPaneDeps
): Promise<OpenPromptPaneResult> {
  if (!deps.webContents || deps.webContents.isDestroyed()) {
    return Promise.reject(new Error('No renderer available to open prompt pane.'))
  }
  const channel = `automations:openPromptPane:reply:${deps.requestId}`
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<OpenPromptPaneResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Why: drop the listener so a late renderer reply cannot resolve a
      // promise the caller has already given up on.
      deps.ipc.removeAllListeners(channel)
      reject(new Error(`Renderer did not respond to openPromptPane within ${timeoutMs}ms.`))
    }, timeoutMs)
    deps.ipc.once(channel, (_event: IpcMainEvent, payload: OpenPromptPaneReply) => {
      clearTimeout(timer)
      // Why: branch on the discriminant so deterministic renderer failures
      // surface as OpenPromptPaneError (fail-fast) and stay distinct from
      // transient infrastructure failures above (retry on next tick).
      if (payload.ok) {
        resolve({ paneKey: payload.paneKey })
      } else {
        reject(new OpenPromptPaneError(payload.error))
      }
    })
    deps.webContents.send('automations:openPromptPane', { requestId: deps.requestId, ...req })
  })
}
