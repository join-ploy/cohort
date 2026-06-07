import type { SettingsSearchEntry } from './settings-search'

export const AUTOMATIONS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Linear Poll Interval',
    description: 'How often Orca polls Linear for auto-trigger sources. 15 – 600 seconds.',
    keywords: [
      'automation',
      'auto trigger',
      'autotrigger',
      'linear',
      'poll',
      'polling',
      'interval',
      'frequency',
      'seconds'
    ]
  },
  {
    title: 'Linear Connection',
    description: 'Status of the Linear connection that powers Linear auto-triggers.',
    keywords: [
      'automation',
      'auto trigger',
      'autotrigger',
      'linear',
      'connection',
      'connected',
      'paused',
      'banner'
    ]
  },
  {
    title: 'HTTP Connections',
    description:
      'Reusable HTTP base URL + headers (including secret auth) for HTTP triggers and request steps.',
    keywords: [
      'automation',
      'http',
      'connection',
      'base url',
      'header',
      'secret',
      'auth',
      'reusable'
    ]
  }
]
