/** Activator for the focused tab strip's visible order, published by the
 *  focused TabBar. The Cmd/Ctrl+1-9 handler runs outside React (via IPC), so
 *  it can't read the strip's rendered order or its per-item activation
 *  callbacks directly — those resolve aggregated sibling-member tabs in a
 *  grouped workspace. Publishing them here keeps the shortcut on the exact
 *  order the user sees. Mirrors the module-cache pattern the sidebar uses for
 *  its visible-worktree order. */
type ActivateByIndex = (index: number) => boolean

let activator: ActivateByIndex | null = null

export function setFocusedTabStripActivator(fn: ActivateByIndex | null): void {
  activator = fn
}

export function hasFocusedTabStrip(): boolean {
  return activator !== null
}

/** Activate the Nth (0-based) tab in the focused strip's visible order. Returns
 *  false when no strip is registered or no tab sits at that index. */
export function activateFocusedTabAtIndex(index: number): boolean {
  return activator?.(index) ?? false
}
