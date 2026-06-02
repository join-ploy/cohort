export type ReviewTarget = { tabId: string; label: string }

type ResolverTab = {
  id: string
  title?: string
  customTitle?: string | null
  defaultTitle?: string
}

type ResolverAgentEntry = { terminalTitle?: string }

export function resolveReviewTargets(input: {
  tabs: ResolverTab[]
  agentStatusByPaneKey: Record<string, ResolverAgentEntry>
}): ReviewTarget[] {
  const tabsById = new Map(input.tabs.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const targets: ReviewTarget[] = []

  for (const [paneKey, entry] of Object.entries(input.agentStatusByPaneKey)) {
    const tabId = paneKey.split(':')[0]
    const tab = tabsById.get(tabId)
    if (!tab || seen.has(tabId)) {
      continue
    }
    seen.add(tabId)
    const label =
      tab.customTitle?.trim() ||
      entry.terminalTitle?.trim() ||
      tab.title?.trim() ||
      tab.defaultTitle?.trim() ||
      'Agent'
    targets.push({ tabId, label })
  }

  return targets
}
