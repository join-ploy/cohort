const { chmodSync, copyFileSync, existsSync, readdirSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join, resolve } = require('node:path')

const hasAssetsCar = existsSync(join(__dirname, '../resources/build/Assets.car'))

const isMacRelease = process.env.ORCA_MAC_RELEASE === '1'

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.stablyai.orca',
  productName: 'Cohort',
  directories: {
    buildResources: 'resources/build'
  },
  files: [
    '!**/.vscode/*',
    '!src/*',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!tsconfig.json',
    '!config/*'
  ],
  // Why: the CLI entry-point lives in out/cli/ but imports shared modules
  // from out/shared/ (e.g. runtime-bootstrap). Both directories must be
  // unpacked so that Node's require() can resolve the cross-directory imports
  // when the CLI runs outside the asar archive.
  // Why: daemon-entry.js is forked as a separate Node.js process and must be
  // accessible on disk (not inside the asar archive) for child_process.fork().
  // Why: the CLI is compiled by tsc (not bundled), so its runtime imports
  // resolve at runtime via Node's normal module lookup. The shim launches
  // the CLI with ELECTRON_RUN_AS_NODE, which bypasses Electron's asar
  // integration — dependencies inside the asar archive are invisible to
  // require(). Unpack CLI runtime deps so they resolve from
  // app.asar.unpacked/node_modules/.
  asarUnpack: [
    'out/cli/**',
    'out/shared/**',
    'out/main/daemon-entry.js',
    'out/main/computer-sidecar.js',
    'out/main/chunks/**',
    'resources/**',
    'node_modules/zod/**'
  ],
  afterPack: async (context) => {
    const resourcesDir =
      context.electronPlatformName === 'darwin'
        ? join(
            context.appOutDir,
            `${context.packager.appInfo.productFilename}.app`,
            'Contents',
            'Resources'
          )
        : join(context.appOutDir, 'resources')
    if (!existsSync(resourcesDir)) {
      return
    }
    for (const filename of readdirSync(resourcesDir)) {
      if (!filename.startsWith('agent-browser-')) {
        continue
      }
      // Why: the upstream package has inconsistent executable bits across
      // platform binaries (notably darwin-x64). child_process.execFile needs
      // the copied binary to be executable in packaged apps.
      chmodSync(join(resourcesDir, filename), 0o755)
    }
    if (context.electronPlatformName === 'darwin') {
      const assetsCar = resolve(__dirname, '../resources/build/Assets.car')
      if (existsSync(assetsCar)) {
        copyFileSync(assetsCar, join(resourcesDir, 'Assets.car'))
      }
      await signMacComputerUseHelper(join(resourcesDir, 'Orca Computer Use.app'), context.packager)
    }
  },
  win: {
    executableName: 'Cohort',
    extraResources: [
      {
        from: 'resources/win32/bin/orca.cmd',
        to: 'bin/orca.cmd'
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe',
        to: 'agent-browser-win32-x64.exe'
      },
      {
        from: 'native/computer-use-windows/runtime.ps1',
        to: 'computer-use-windows/runtime.ps1'
      }
    ]
  },
  nsis: {
    artifactName: 'orca-windows-setup.${ext}',
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    createDesktopShortcut: 'always'
  },
  mac: {
    icon: 'resources/build/icon.icns',
    entitlements: 'resources/build/entitlements.mac.plist',
    entitlementsInherit: 'resources/build/entitlements.mac.plist',
    extendInfo: {
      ...(hasAssetsCar ? { CFBundleIconName: 'icon' } : {}),
      NSAppleEventsUsageDescription:
        'Cohort allows terminal-launched developer tools to automate local apps when you request it.',
      NSBluetoothAlwaysUsageDescription:
        'Cohort allows terminal-launched developer tools to access Bluetooth devices when you request it.',
      NSBluetoothPeripheralUsageDescription:
        'Cohort allows terminal-launched developer tools to access Bluetooth devices when you request it.',
      NSCameraUsageDescription: "Application requests access to the device's camera.",
      NSLocationUsageDescription:
        'Cohort allows terminal-launched developer tools to access location when you request it.',
      NSLocalNetworkUsageDescription:
        'Cohort allows terminal-launched developer tools to discover and connect to local development servers when you request it.',
      NSMicrophoneUsageDescription: "Application requests access to the device's microphone.",
      NSAudioCaptureUsageDescription:
        'Cohort allows terminal-launched developer tools to capture desktop audio when you request it.',
      NSBonjourServices: ['_http._tcp', '_https._tcp'],
      NSDocumentsFolderUsageDescription:
        "Application requests access to the user's Documents folder.",
      NSDownloadsFolderUsageDescription:
        "Application requests access to the user's Downloads folder."
    },
    // Why: hardened runtime restricts child processes (agent shells, bash)
    // causing excessive TCC prompts. Keep it release-only where notarization
    // requires it. The stable dev certificate is sufficient for TCC grant
    // persistence across rebuilds.
    hardenedRuntime: isMacRelease,
    notarize: isMacRelease,
    extraResources: [
      {
        from: 'resources/darwin/bin/orca',
        to: 'bin/orca'
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-darwin-${arch}',
        to: 'agent-browser-darwin-${arch}'
      },
      {
        from: 'native/computer-use-macos/.build/release/Orca Computer Use.app',
        to: 'Orca Computer Use.app'
      }
    ],
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      },
      {
        target: 'zip',
        arch: ['x64', 'arm64']
      }
    ]
  },
  // Why: release builds should fail if signing is unavailable instead of
  // silently downgrading to ad-hoc artifacts that look shippable in CI logs.
  forceCodeSigning: isMacRelease,
  dmg: {
    artifactName: 'orca-macos-${arch}.${ext}'
  },
  deb: {
    depends: ['python3', 'python3-gi', 'gir1.2-atspi-2.0', 'at-spi2-core', 'xdotool', 'xclip']
  },
  linux: {
    extraResources: [
      {
        from: 'resources/linux/bin/orca',
        to: 'bin/orca'
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-linux-${arch}',
        to: 'agent-browser-linux-${arch}'
      },
      {
        from: 'native/computer-use-linux/runtime.py',
        to: 'computer-use-linux/runtime.py'
      }
    ],
    target: ['AppImage', 'deb'],
    maintainer: 'stablyai',
    category: 'Utility'
  },
  appImage: {
    artifactName: 'orca-linux.${ext}'
  },
  // Why: must be true so that electron-builder rebuilds native modules
  // (node-pty) for each target architecture when producing dual-arch macOS
  // builds (x64 + arm64). With npmRebuild disabled, CI on an arm64 runner
  // packages arm64 binaries into the x64 DMG, causing "posix_spawnp failed"
  // on Intel Macs.
  npmRebuild: true,
  // Why: fork disable — no publish provider so electron-builder writes an
  // empty/missing app-update.yml into the packaged binary. Combined with
  // the runtime short-circuit in src/main/updater.ts:setupAutoUpdater,
  // this means the packaged app never reaches upstream stablyai/orca's
  // release feed. Restore the original github provider block to ship
  // your own updates from a release server.
  publish: null
}

async function signMacComputerUseHelper(helperAppPath, packager) {
  if (!existsSync(helperAppPath)) {
    if (isMacRelease) {
      throw new Error(`Missing Orca Computer Use helper app at ${helperAppPath}`)
    }
    return
  }
  const codeSigningInfo =
    isMacRelease && process.env.CSC_LINK && packager?.codeSigningInfo?.value
      ? await packager.codeSigningInfo.value
      : null
  const identity =
    process.env.ORCA_COMPUTER_MACOS_SIGN_IDENTITY ??
    process.env.CSC_NAME ??
    findInstalledMacSigningIdentity(codeSigningInfo?.keychainFile) ??
    (isMacRelease ? null : '-')
  if (!identity) {
    throw new Error('Missing signing identity for Orca Computer Use helper app')
  }
  // Why: TCC grants attach to this nested app's code identity. Sign it before
  // the outer Cohort.app is sealed so production builds preserve that identity.
  execFileSync('codesign', codesignArgs(identity, helperAppPath), { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', helperAppPath], {
    stdio: 'inherit'
  })
}

function codesignArgs(identity, targetPath) {
  const args = ['--force', '--deep', '--sign', identity]
  if (isMacRelease) {
    args.push(
      '--options',
      'runtime',
      '--timestamp',
      '--entitlements',
      resolve(__dirname, '../resources/build/entitlements.computer-use.mac.plist')
    )
  }
  args.push(targetPath)
  return args
}

function findInstalledMacSigningIdentity(keychainFile) {
  try {
    const output = execFileSync(
      'security',
      ['find-identity', '-v', '-p', 'codesigning', ...(keychainFile ? [keychainFile] : [])],
      {
        encoding: 'utf8'
      }
    )
    const releaseMatch =
      output.match(/"([^"]*Developer ID Application:[^"]+)"/) ??
      output.match(/"([^"]*Apple Distribution:[^"]+)"/)
    if (releaseMatch?.[1]) {
      return releaseMatch[1]
    }
    if (!isMacRelease) {
      return output.match(/"([^"]*Apple Development:[^"]+)"/)?.[1] ?? null
    }
  } catch {}
  return null
}
