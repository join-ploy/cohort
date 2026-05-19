import { ipcMain, shell, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { constants, copyFile, stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

export function registerShellHandlers(): void {
  ipcMain.handle('shell:openPath', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('shell:openVscode', async (_event, path: string) => {
    if (!isAbsolute(path)) {
      return
    }
    // Why: the vscode://file URL scheme is unreliable — VS Code's installer
    // may not register the handler (especially Homebrew-cask installs and
    // Insiders), and openExternal silently no-ops when the scheme is
    // unrouted. `open -a "Visual Studio Code" <path>` on macOS is the
    // canonical way users open a folder in VS Code from the shell and
    // works whenever VS Code.app is in /Applications. On other platforms
    // we fall back to the URL scheme since `open` is macOS-only.
    if (process.platform === 'darwin') {
      try {
        const child = spawn('open', ['-a', 'Visual Studio Code', path], {
          stdio: 'ignore',
          detached: true
        })
        // Why: detach so the OS owns the spawned process — otherwise it
        // dies when Orca's main process exits.
        child.unref()
        // Why: if `open` itself errors synchronously (rare; usually means
        // Visual Studio Code.app isn't installed), fall through to the URL
        // scheme fallback below instead of leaving the user with no signal.
        await new Promise<void>((resolve) => {
          child.once('error', () => resolve())
          // Resolve on spawn since we detached — no exit code to wait for.
          child.once('spawn', () => resolve())
        })
        return
      } catch {
        // fall through to the URL scheme fallback
      }
    }
    // Cross-platform fallback: vscode://file/<path>. The double-slash form
    // (after `file/`) is the canonical absolute-path encoding VS Code
    // documents. Pass the raw path so VS Code's URL parser handles spaces
    // and other characters the same way it does for terminal `code` args.
    await shell.openExternal(`vscode://file${path}`)
  })

  ipcMain.handle('shell:openDatabase', async (_event, url: string) => {
    // Why: only allow DB-client URL schemes that TablePlus + Sequel Pro +
    // DBeaver register. Rejects arbitrary protocols so this can't be turned
    // into an `openExternal` proxy.
    const ALLOWED_SCHEMES = new Set([
      'postgresql:',
      'postgres:',
      'mysql:',
      'mariadb:',
      'redis:',
      'mongodb:',
      'sqlserver:',
      'tableplus:',
      'sequelace:',
      'dbeaver:'
    ])
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return
    }
    await shell.openExternal(url)
  })

  ipcMain.handle('shell:openUrl', (_event, rawUrl: string) => {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return
    }

    return shell.openExternal(parsed.toString())
  })

  ipcMain.handle('shell:openFilePath', async (_event, filePath: string) => {
    if (!isAbsolute(filePath)) {
      return
    }
    const normalizedPath = normalize(filePath)
    if (!(await pathExists(normalizedPath))) {
      return
    }
    await shell.openPath(normalizedPath)
  })

  ipcMain.handle('shell:openFileUri', async (_event, rawUri: string) => {
    let parsed: URL
    try {
      parsed = new URL(rawUri)
    } catch {
      return
    }

    if (parsed.protocol !== 'file:') {
      return
    }

    // Only local files are supported. Remote hosts are intentionally rejected.
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      return
    }

    let filePath: string
    try {
      filePath = fileURLToPath(parsed)
    } catch {
      return
    }

    const normalizedPath = normalize(filePath)
    if (!isAbsolute(normalizedPath)) {
      return
    }
    if (!(await pathExists(normalizedPath))) {
      return
    }

    await shell.openPath(normalizedPath)
  })

  ipcMain.handle('shell:pathExists', async (_event, filePath: string): Promise<boolean> => {
    return pathExists(filePath)
  })

  ipcMain.handle(
    'shell:pickDirectory',
    async (_event, args: { defaultPath?: string }): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        defaultPath: args.defaultPath,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      return result.filePaths[0]
    }
  )

  // Why: window.prompt() and <input type="file"> are unreliable in Electron,
  // so we use the native OS dialog to let the user pick any attachment file.
  ipcMain.handle('shell:pickAttachment', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Why: window.prompt() and <input type="file"> are unreliable in Electron,
  // so we use the native OS dialog to let the user pick an image file.
  ipcMain.handle('shell:pickImage', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('shell:pickAudio', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Why: copying a picked image next to the markdown file lets us insert a
  // relative path (e.g. `![](image.png)`) instead of embedding base64,
  // keeping markdown files small and portable.
  ipcMain.handle(
    'shell:copyFile',
    async (_event, args: { srcPath: string; destPath: string }): Promise<void> => {
      const src = normalize(args.srcPath)
      const dest = normalize(args.destPath)
      if (!isAbsolute(src) || !isAbsolute(dest)) {
        throw new Error('Both source and destination must be absolute paths')
      }
      // Why: COPYFILE_EXCL prevents silently overwriting an existing file.
      // The renderer-side deconfliction loop already picks a unique name, so
      // the dest should never exist — if it does, something is wrong and we
      // should fail loudly rather than clobber data.
      await copyFile(src, dest, constants.COPYFILE_EXCL)
    }
  )
}
