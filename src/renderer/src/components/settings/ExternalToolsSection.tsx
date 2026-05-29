import React, { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'

type ExternalToolsSectionProps = {
  editorKind: 'vscode' | 'custom'
  editorCommand: string
  diffCommand: string
  databaseKind: 'url' | 'custom'
  databaseCommand: string
  onChange: (updates: Partial<GlobalSettings>) => void
}

const PLACEHOLDER_HELP =
  '${WORKTREE_PATH}, ${WORKSPACE_NAME}, ${REPO_PATH}, ${BASE_BRANCH}, ${MERGE_BASE}, ${HEAD}, ${DATABASE_URL}'

const EDITOR_EXAMPLE = 'emacsclient -n -e \'(magit-status "${WORKTREE_PATH}")\''
const DIFF_EXAMPLE = 'emacsclient -n -e \'(magit-diff-range "${MERGE_BASE}..HEAD")\''
const DATABASE_EXAMPLE = 'dbeaver ${DATABASE_URL}'

const KEYWORDS = [
  'external',
  'tool',
  'editor',
  'emacs',
  'emacsclient',
  'diff',
  'database',
  'command'
]

// Why: commit-on-blur (not per-keystroke) so editing a command does not
// round-trip through the persisted settings store on every character — mirrors
// SidebarPromptCommandsSection / the databaseUrl editor.
function CommandField({
  id,
  label,
  value,
  placeholder,
  onCommit
}: {
  id: string
  label: string
  value: string
  placeholder: string
  onCommit: (next: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <div className="space-y-1">
      <Label
        htmlFor={id}
        className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </Label>
      <Input
        id={id}
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) {
            onCommit(draft)
          }
        }}
        placeholder={placeholder}
        className="h-8 font-mono text-xs"
      />
    </div>
  )
}

export function ExternalToolsSection({
  editorKind,
  editorCommand,
  diffCommand,
  databaseKind,
  databaseCommand,
  onChange
}: ExternalToolsSectionProps): React.JSX.Element {
  return (
    <SearchableSetting
      title="External tools"
      description="Configure the Editor, Diff, and Database buttons in the worktree bar."
      keywords={KEYWORDS}
      className="space-y-6"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">External tools</h3>
        <p className="text-xs text-muted-foreground">
          Commands run for the worktree context-bar buttons. Custom commands run through your shell
          with these placeholders substituted:{' '}
          <code className="rounded bg-muted px-1 py-0.5">{PLACEHOLDER_HELP}</code>. Quote
          placeholders as you would in any shell command — e.g.{' '}
          <code className="rounded bg-muted px-1 py-0.5">{EDITOR_EXAMPLE}</code>.
        </p>
      </div>

      <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
        {/* Editor */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>Editor</Label>
            <p className="text-xs text-muted-foreground">Opens the worktree folder.</p>
          </div>
          <Select
            value={editorKind}
            onValueChange={(v) => onChange({ externalEditorKind: v as 'vscode' | 'custom' })}
          >
            <SelectTrigger size="sm" className="h-7 w-[160px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vscode">VS Code</SelectItem>
              <SelectItem value="custom">Custom command</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {editorKind === 'custom' ? (
          <CommandField
            id="external-editor-command"
            label="Editor command"
            value={editorCommand}
            placeholder={EDITOR_EXAMPLE}
            onCommit={(next) => onChange({ externalEditorCommand: next })}
          />
        ) : null}

        {/* Diff */}
        <CommandField
          id="external-diff-command"
          label="Diff command"
          value={diffCommand}
          placeholder={DIFF_EXAMPLE}
          onCommit={(next) => onChange({ externalDiffCommand: next })}
        />

        {/* Database */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>Database</Label>
            <p className="text-xs text-muted-foreground">
              Open URL uses the repo&apos;s configured database URL.
            </p>
          </div>
          <Select
            value={databaseKind}
            onValueChange={(v) => onChange({ externalDatabaseKind: v as 'url' | 'custom' })}
          >
            <SelectTrigger size="sm" className="h-7 w-[160px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="url">Open URL</SelectItem>
              <SelectItem value="custom">Custom command</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {databaseKind === 'custom' ? (
          <CommandField
            id="external-database-command"
            label="Database command"
            value={databaseCommand}
            placeholder={DATABASE_EXAMPLE}
            onCommit={(next) => onChange({ externalDatabaseCommand: next })}
          />
        ) : null}
      </div>
    </SearchableSetting>
  )
}
