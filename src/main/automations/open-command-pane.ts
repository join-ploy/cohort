import type { IpcMain, IpcMainEvent, WebContents } from 'electron'

export type OpenCommandPaneRequest = {
  worktreeId: string
  source: 'review' | 'create-pr' | 'custom'
  /** Stable id of the configured SidebarPromptCommand under
   *  `settings.reviewCommands` or `settings.createPrCommands`. Required when
   *  source is 'review' or 'create-pr'. */
  commandId?: string
  /** Raw shell command line. Required when source is 'custom'; ignored
   *  otherwise. */
  customCommand?: string
}

export type OpenCommandPaneResult = { ptyId: string; paneKey: string }

/**
 * Discriminated reply from the renderer. Success carries both the PTY id (for
 * lifecycle/exit tracking via PtyExitRegistry) and the paneKey (for surfacing
 * in the chain run output). Failure carries a human-readable reason that the
 * chain executor surfaces verbatim as the step's `error`.
 */
export type OpenCommandPaneReply =
  | { ok: true; ptyId: string; paneKey: string }
  | { ok: false; error: string }

/**
 * Renderer-side failure that's deterministic — bad worktreeId, missing
 * command id, no active prompt-write target, etc. The chain executor
 * fails-fast on these (same as `TemplateResolutionError`); retrying can't
 * recover. Distinct class so callers can branch on it without string-matching
 * the error message, and distinct from the plain `Error` used for transient/
 * infrastructure issues (destroyed webContents, timeout) which the executor
 * retries.
 */
export class OpenCommandPaneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenCommandPaneError'
  }
}

/**
 * Subset of {@link IpcMain} that the helper depends on. Narrowing the surface
 * here lets tests pass a tiny fake without faking the full Electron module.
 */
export type OpenCommandPaneIpc = Pick<IpcMain, 'once' | 'removeAllListeners'>

export type OpenCommandPaneDeps = {
  webContents: WebContents
  ipc: OpenCommandPaneIpc
  requestId: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Ask the renderer to open a background tab in a worktree, run the configured
 * sidebar prompt command (Review / Create PR) or a raw custom command, and
 * return the resulting paneKey + ptyId so the chain executor can track PTY
 * exit and surface the paneKey on success.
 *
 * Each call uses a requestId-scoped reply channel so concurrent calls cannot
 * race on a shared listener.
 */
export function openCommandPane(
  req: OpenCommandPaneRequest,
  deps: OpenCommandPaneDeps
): Promise<OpenCommandPaneResult> {
  if (!deps.webContents || deps.webContents.isDestroyed()) {
    return Promise.reject(new Error('No renderer available to open command pane.'))
  }
  const channel = `automations:openCommandPane:reply:${deps.requestId}`
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<OpenCommandPaneResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Why: drop the listener so a late renderer reply cannot resolve a
      // promise the caller has already given up on.
      deps.ipc.removeAllListeners(channel)
      reject(new Error(`Renderer did not respond to openCommandPane within ${timeoutMs}ms.`))
    }, timeoutMs)
    deps.ipc.once(channel, (_event: IpcMainEvent, payload: OpenCommandPaneReply) => {
      clearTimeout(timer)
      // Why: branch on the discriminant so deterministic renderer failures
      // surface as OpenCommandPaneError (fail-fast) and stay distinct from
      // transient infrastructure failures above (retry on next tick).
      if (payload.ok) {
        resolve({ ptyId: payload.ptyId, paneKey: payload.paneKey })
      } else {
        reject(new OpenCommandPaneError(payload.error))
      }
    })
    deps.webContents.send('automations:openCommandPane', { requestId: deps.requestId, ...req })
  })
}
