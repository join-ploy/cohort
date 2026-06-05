import type { Repo } from '../../../shared/types'
import { listOpenPrsViaGh, listRepoLabelsViaGh, listRepoAuthorsViaGh } from './github-pr-gh'
import type { CandidateEvent, FieldDescriptor, PollCtx, TriggerSource } from './types'

export type GithubPr = {
  number: number
  title: string
  url: string
  author: string
  baseRefName: string
  headRefName: string
  labels: string[]
  isCrossRepository: boolean
  createdAt: string
  updatedAt: string
}

export type GithubPrSourceDeps = {
  getRepos: () => Repo[]
  // Injectable for tests; defaults call the real gh-backed fetchers (C2).
  listOpenPrs?: (repo: Repo) => Promise<GithubPr[]>
  listLabelOptions?: (repos: Repo[]) => Promise<{ value: string; label: string }[]>
  listAuthorOptions?: (repos: Repo[]) => Promise<{ value: string; label: string }[]>
}

export function makeGithubPrSource(deps: GithubPrSourceDeps): TriggerSource {
  const listOpenPrs = deps.listOpenPrs ?? listOpenPrsViaGh

  const fieldCatalog: FieldDescriptor[] = [
    {
      field: 'github.baseRef',
      label: 'Base branch',
      valueKind: 'string',
      ops: ['is', 'is-any-of', 'is-none-of']
    },
    {
      field: 'github.author',
      label: 'Author',
      valueKind: 'user',
      ops: ['is', 'is-not', 'is-any-of', 'is-none-of'],
      fetchOptions: () => (deps.listAuthorOptions ?? listRepoAuthorsViaGh)(deps.getRepos())
    },
    {
      field: 'github.labels',
      label: 'Has label',
      valueKind: 'label',
      ops: ['contains-any', 'contains-all', 'contains-none'],
      fetchOptions: () => (deps.listLabelOptions ?? listRepoLabelsViaGh)(deps.getRepos())
    }
  ]

  return {
    id: 'github-pr',
    displayName: 'GitHub PR',
    fieldCatalog,
    poll: (ctx) => pollGithubPrs(deps.getRepos(), listOpenPrs, ctx)
  }
}

async function* pollGithubPrs(
  repos: Repo[],
  listOpenPrs: (repo: Repo) => Promise<GithubPr[]>,
  ctx: PollCtx
): AsyncIterable<CandidateEvent> {
  const watched = new Set(ctx.repoIds ?? [])
  for (const repo of repos) {
    if (!watched.has(repo.id)) {
      continue
    }
    // v1: local git repos only — skip SSH-remote and folder repos.
    if (repo.connectionId || repo.kind === 'folder') {
      continue
    }
    let prs: GithubPr[]
    try {
      prs = await listOpenPrs(repo)
    } catch (err) {
      console.warn(`[github-pr source] poll failed for ${repo.id}:`, err)
      continue
    }
    for (const pr of prs) {
      yield mapPrToEvent(repo, pr)
    }
  }
}

function mapPrToEvent(repo: Repo, pr: GithubPr): CandidateEvent {
  return {
    entityId: `${repo.id}#${pr.number}`,
    entityIdentifier: `${repo.displayName}#${pr.number}`,
    // OPENED semantics: use createdAt so only newly-opened PRs cross the
    // watermark — an edit to an existing PR must not re-fire the trigger.
    updatedAt: new Date(pr.createdAt).getTime(),
    repoId: repo.id,
    payload: {
      pr: {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        headRef: pr.headRefName,
        baseRef: pr.baseRefName,
        author: pr.author,
        isCrossRepository: pr.isCrossRepository,
        repoId: repo.id
      }
    },
    fields: {
      'github.baseRef': pr.baseRefName,
      'github.author': pr.author,
      'github.labels': pr.labels
    }
  }
}
