import * as React from 'react'

// Shared section label used by the HTTP trigger card and the request editor.
export function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {children}
    </p>
  )
}
