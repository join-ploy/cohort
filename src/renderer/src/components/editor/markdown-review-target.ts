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
  const entryByTabId = new Map<string, ResolverAgentEntry>()
  for (const [paneKey, entry] of Object.entries(input.agentStatusByPaneKey)) {
    const tabId = paneKey.split(':')[0]
    if (!entryByTabId.has(tabId)) {
      entryByTabId.set(tabId, entry)
    }
  }

  // Why: iterate tabs (not the agent-status map) so the picker order follows the
  // stable tab order rather than the order agent heartbeats happened to fire in.
  const targets: ReviewTarget[] = []
  for (const tab of input.tabs) {
    const entry = entryByTabId.get(tab.id)
    if (!entry) {
      continue
    }
    const label =
      tab.customTitle?.trim() ||
      entry.terminalTitle?.trim() ||
      tab.title?.trim() ||
      tab.defaultTitle?.trim() ||
      'Agent'
    targets.push({ tabId: tab.id, label })
  }

  return targets
}
