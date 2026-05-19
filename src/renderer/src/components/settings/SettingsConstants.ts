import type { OrcaHooks } from '../../../../shared/types'
import { getDefaultRepoHookSettings } from '../../../../shared/constants'

export type HookName = keyof OrcaHooks['scripts']
export const DEFAULT_REPO_HOOK_SETTINGS = getDefaultRepoHookSettings()
export const MAX_THEME_RESULTS = 80
export const SCROLLBACK_PRESETS_MB = [10, 25, 50, 100, 250] as const
export const ZOOM_STEP = 0.5
export const ZOOM_MIN = -3
export const ZOOM_MAX = 5

export function zoomLevelToPercent(level: number): number {
  return Math.round(100 * Math.pow(1.2, level))
}

export function getFallbackTerminalFonts(): string[] {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { userAgentData?: { platform?: string } })
      : null
  const platform = nav ? (nav.userAgentData?.platform ?? nav.platform ?? '') : ''
  const normalizedPlatform = platform.toLowerCase()

  // Why: Geist Mono ships with the app as a web font, so it must appear in the
  // picker regardless of platform when system font enumeration is empty —
  // otherwise users on minimal Linux installs see only generics.
  if (normalizedPlatform.includes('mac')) {
    return ['Geist Mono', 'SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code']
  }

  if (normalizedPlatform.includes('win')) {
    return [
      'Geist Mono',
      'Cascadia Mono',
      'Consolas',
      'Lucida Console',
      'JetBrains Mono',
      'Fira Code'
    ]
  }

  return [
    'Geist Mono',
    'JetBrains Mono',
    'Fira Code',
    'DejaVu Sans Mono',
    'Liberation Mono',
    'Ubuntu Mono',
    'Noto Sans Mono'
  ]
}
