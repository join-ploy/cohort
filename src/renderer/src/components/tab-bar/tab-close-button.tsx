import React from 'react'
import { X } from 'lucide-react'

/** Close affordance overlaid at a tab's right edge. Positioned absolutely so it
 *  takes no layout width — the shortcut hint sits in its place. Revealed only on
 *  tab hover, sitting above the hint (which goes invisible on hover) with the
 *  tab's own background so it also masks the label tail on tabs without a hint.
 *  Requires the parent tab element to be `relative`. */
export function TabCloseButton({
  onClose,
  ariaLabel
}: {
  onClose: () => void
  ariaLabel: string
}): React.JSX.Element {
  return (
    <button
      aria-label={ariaLabel}
      className="absolute right-1.5 top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm bg-card text-muted-foreground group-hover:flex hover:bg-muted hover:text-foreground"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <X className="h-3 w-3" />
    </button>
  )
}
