import React, { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { SidebarPromptCommand } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

type SidebarPromptCommandsSectionProps = {
  reviewCommands: SidebarPromptCommand[]
  createPrCommands: SidebarPromptCommand[]
  onChangeReviewCommands: (next: SidebarPromptCommand[]) => void
  onChangeCreatePrCommands: (next: SidebarPromptCommand[]) => void
}

// Why: a single section that owns both lists keeps the General pane wiring
// simple — there is only one settings transaction per save and the user
// sees both dropdown surfaces side-by-side in one place rather than
// hunting for two parallel sections.
export function SidebarPromptCommandsSection({
  reviewCommands,
  createPrCommands,
  onChangeReviewCommands,
  onChangeCreatePrCommands
}: SidebarPromptCommandsSectionProps): React.JSX.Element {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Right-Sidebar Prompt Commands</h3>
        <p className="text-xs text-muted-foreground">
          Configure the entries shown in the right-sidebar Review and Create PR dropdowns. Each
          entry writes its prompt to{' '}
          <code className="rounded bg-muted px-1 py-0.5">~/.orca/prompts/&lt;label&gt;.md</code> and
          opens a new terminal tab running{' '}
          <code className="rounded bg-muted px-1 py-0.5">
            &lt;command&gt; &quot;$(cat &lt;prompt-path&gt;)&quot;
          </code>
          .
        </p>
      </div>

      <PromptCommandsList
        kind="review"
        title="Review Commands"
        description="Shown in the right-sidebar Review dropdown."
        keywords={['review', 'right-sidebar', 'prompt', 'command']}
        commands={reviewCommands}
        onChange={onChangeReviewCommands}
      />

      <PromptCommandsList
        kind="createPr"
        title="Create PR Commands"
        description="Shown in the right-sidebar Create PR dropdown. The button is hidden when the active worktree's branch already has an open PR."
        keywords={['pr', 'pull request', 'right-sidebar', 'prompt', 'command']}
        commands={createPrCommands}
        onChange={onChangeCreatePrCommands}
      />
    </section>
  )
}

type PromptCommandsListProps = {
  kind: 'review' | 'createPr'
  title: string
  description: string
  keywords: string[]
  commands: SidebarPromptCommand[]
  onChange: (next: SidebarPromptCommand[]) => void
}

function PromptCommandsList({
  kind,
  title,
  description,
  keywords,
  commands,
  onChange
}: PromptCommandsListProps): React.JSX.Element {
  const handleAdd = useCallback(() => {
    const defaults: SidebarPromptCommand = {
      // Why: crypto.randomUUID() guarantees a stable, collision-free key
      // for list reorders and edit forms without depending on the user's
      // chosen label (which can be edited and even left blank temporarily).
      id: globalThis.crypto.randomUUID(),
      label: kind === 'review' ? 'New review' : 'New create-PR',
      command: 'claude',
      prompt: ''
    }
    onChange([...commands, defaults])
  }, [commands, kind, onChange])

  return (
    <SearchableSetting title={title} description={description} keywords={keywords}>
      <div className="space-y-3 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <h5 className="text-sm font-semibold">{title}</h5>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleAdd} className="gap-2">
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>

        {commands.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 bg-background/50 px-3 py-4 text-center text-xs text-muted-foreground">
            No entries configured. Click <span className="font-medium">Add</span> to create one —
            the dropdown is hidden until at least one entry exists.
          </p>
        ) : (
          <div className="space-y-3">
            {commands.map((cmd) => (
              <PromptCommandEditor
                key={cmd.id}
                value={cmd}
                onChange={(next) =>
                  onChange(commands.map((entry) => (entry.id === cmd.id ? next : entry)))
                }
                onDelete={() => onChange(commands.filter((entry) => entry.id !== cmd.id))}
              />
            ))}
          </div>
        )}
      </div>
    </SearchableSetting>
  )
}

type PromptCommandEditorProps = {
  value: SidebarPromptCommand
  onChange: (next: SidebarPromptCommand) => void
  onDelete: () => void
}

function PromptCommandEditor({
  value,
  onChange,
  onDelete
}: PromptCommandEditorProps): React.JSX.Element {
  // Why: keep local-state drafts so edits do not round-trip through the
  // persisted settings store on every keystroke. Commit on blur, mirroring
  // the databaseUrl / issue-command editors.
  const [labelDraft, setLabelDraft] = useState(value.label)
  const [commandDraft, setCommandDraft] = useState(value.command)
  const [promptDraft, setPromptDraft] = useState(value.prompt)

  useEffect(() => {
    setLabelDraft(value.label)
  }, [value.id, value.label])
  useEffect(() => {
    setCommandDraft(value.command)
  }, [value.id, value.command])
  useEffect(() => {
    setPromptDraft(value.prompt)
  }, [value.id, value.prompt])

  const commitLabel = useCallback(() => {
    const next = labelDraft
    if (next !== value.label) {
      onChange({ ...value, label: next })
    }
  }, [labelDraft, onChange, value])
  const commitCommand = useCallback(() => {
    const next = commandDraft
    if (next !== value.command) {
      onChange({ ...value, command: next })
    }
  }, [commandDraft, onChange, value])
  const commitPrompt = useCallback(() => {
    if (promptDraft !== value.prompt) {
      onChange({ ...value, prompt: promptDraft })
    }
  }, [promptDraft, onChange, value])

  return (
    <div className="space-y-3 rounded-xl border border-border/40 bg-background/60 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-1">
          <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Label
          </Label>
          <Input
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            placeholder="Review"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Command
          </Label>
          <Input
            value={commandDraft}
            onChange={(e) => setCommandDraft(e.target.value)}
            onBlur={commitCommand}
            placeholder="claude"
            className="h-8 font-mono text-xs"
          />
        </div>
        <div className="flex items-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            aria-label={`Delete ${value.label || 'entry'}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Prompt (markdown)
        </Label>
        <textarea
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          onBlur={commitPrompt}
          placeholder="Markdown body written to ~/.orca/prompts/<label>.md before invocation."
          rows={6}
          className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
    </div>
  )
}
