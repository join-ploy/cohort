#!/usr/bin/env node
// Copy the packaged app's userData ("cohort") over the dev profile ("cohort-dev")
// so `pnpm dev` starts from the same persisted state (worktrees, accounts,
// usage, terminal history, etc.) as your production install. The existing
// dev profile is moved aside to a timestamped backup before the copy.
//
// Usage:
//   pnpm sync:dev-from-prod              # back up existing dev, then copy
//   pnpm sync:dev-from-prod --no-backup  # skip the backup (dev profile is deleted first)
//   pnpm sync:dev-from-prod --dry-run    # print what would happen, do nothing

import { existsSync, renameSync, rmSync, cpSync, readdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const skipBackup = args.has('--no-backup')

function resolveAppDataDir() {
  // Mirrors Electron's app.getPath('appData') across platforms.
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support')
    case 'win32': {
      const appData = process.env.APPDATA
      if (!appData) {
        throw new Error('APPDATA environment variable is not set')
      }
      return appData
    }
    default:
      return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  }
}

function looksLikeOrcaRunning(dir) {
  // Best-effort: Chromium drops a SingletonLock (mac/linux) or LOCK file while
  // the app is open. We can't be authoritative, but this catches the common
  // case where the user forgot to quit packaged Orca before running this.
  if (!existsSync(dir)) {
    return false
  }
  try {
    return readdirSync(dir).some((name) => name === 'SingletonLock' || name === 'LOCK')
  } catch {
    return false
  }
}

const appData = resolveAppDataDir()
const prod = join(appData, 'cohort')
const dev = join(appData, 'cohort-dev')

console.log(`[sync:dev-from-prod] source: ${prod}`)
console.log(`[sync:dev-from-prod] dest:   ${dev}`)

if (!existsSync(prod)) {
  console.error(
    `[sync:dev-from-prod] source not found — is the packaged Cohort installed and run at least once?`
  )
  process.exit(1)
}

if (looksLikeOrcaRunning(prod)) {
  console.error(
    `[sync:dev-from-prod] packaged Cohort appears to be running (lock file present). Quit it first, then re-run.`
  )
  process.exit(1)
}
if (looksLikeOrcaRunning(dev)) {
  console.error(
    `[sync:dev-from-prod] dev Cohort appears to be running (lock file present). Quit it first, then re-run.`
  )
  process.exit(1)
}

if (existsSync(dev)) {
  if (skipBackup) {
    console.log(`[sync:dev-from-prod] removing existing dev profile (--no-backup)`)
    if (!dryRun) {
      rmSync(dev, { recursive: true, force: true })
    }
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${dev}.backup-${stamp}`
    console.log(`[sync:dev-from-prod] backing up existing dev → ${backup}`)
    if (!dryRun) {
      renameSync(dev, backup)
    }
  }
} else {
  console.log(`[sync:dev-from-prod] no existing dev profile — nothing to back up`)
}

console.log(`[sync:dev-from-prod] copying ${prod} → ${dev}${dryRun ? ' (dry run)' : ''}`)
if (!dryRun) {
  cpSync(prod, dev, { recursive: true, errorOnExist: false, force: true })
}
console.log(`[sync:dev-from-prod] done`)
