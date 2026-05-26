import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { arch } from 'node:os'

const appDir = join(import.meta.dirname, '../../dist', `mac-${arch()}`)
const appPath = join(appDir, 'Cohort.app')

if (!existsSync(appPath)) {
  console.error(`No app bundle found at ${appPath}`)
  process.exit(1)
}

const identity = findDevIdentity() ?? '-'

console.log(
  identity === '-'
    ? 'No dev certificate found — using ad-hoc signing (TCC grants will not persist across rebuilds)'
    : `Signing with: ${identity}`
)

execFileSync('codesign', ['--force', '--deep', '--sign', identity, '--identifier', 'com.stablyai.orca', appPath], {
  stdio: 'inherit'
})

function findDevIdentity() {
  try {
    const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    })
    return (
      output.match(/"([^"]*Apple Development:[^"]+)"/)?.[1] ??
      output.match(/"([^"]*Developer ID Application:[^"]+)"/)?.[1] ??
      null
    )
  } catch {
    return null
  }
}
