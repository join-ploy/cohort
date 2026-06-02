import React from 'react'

/** Cmd/Ctrl + number hint shown on the right of a tab to advertise the
 *  Cmd/Ctrl+1-9 "jump to tab" shortcut. TabBar only renders it for the focused
 *  group's first nine tabs, where the index matches the shortcut target.
 *
 *  Hidden (but space reserved) on tab hover so the absolutely-positioned close
 *  button can take its place without shifting the layout — see TabCloseButton. */
export function TabShortcutHint({ label }: { label: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="shrink-0 select-none text-[10px] leading-none font-medium tabular-nums text-muted-foreground/60 group-hover:invisible"
    >
      {label}
    </span>
  )
}
