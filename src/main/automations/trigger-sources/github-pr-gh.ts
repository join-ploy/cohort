import type { Repo } from '../../../shared/types'
import { ghExecFileAsync } from '../../github/gh-utils'
import { listLabels, listAssignableUsers } from '../../github/issues'
import type { GithubPr } from './github-pr'

// gh `pr list` JSON shape for the fields we request.
type GhPrJson = {
  number: number
  title: string
  url: string
  author?: { login?: string } | null
  baseRefName?: string
  headRefName?: string
  labels?: { name?: string }[] | null
  isCrossRepository?: boolean
  createdAt?: string
  updatedAt?: string
}

export async function listOpenPrsViaGh(repo: Repo): Promise<GithubPr[]> {
  const { stdout } = await ghExecFileAsync(
    [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,url,author,baseRefName,headRefName,labels,isCrossRepository,createdAt,updatedAt'
    ],
    { cwd: repo.path }
  )
  const rows = JSON.parse(stdout) as GhPrJson[]
  return rows.map((pr) => ({
    number: pr.number,
    title: pr.title ?? '',
    url: pr.url ?? '',
    author: pr.author?.login ?? '',
    baseRefName: pr.baseRefName ?? '',
    headRefName: pr.headRefName ?? '',
    labels: (pr.labels ?? []).map((l) => l.name ?? '').filter((n) => n.length > 0),
    isCrossRepository: pr.isCrossRepository ?? false,
    createdAt: pr.createdAt ?? '',
    updatedAt: pr.updatedAt ?? ''
  }))
}

export async function listRepoLabelsViaGh(
  repos: Repo[]
): Promise<{ value: string; label: string }[]> {
  // Reuse issues.ts#listLabels (repoPath-keyed); dedupe names across repos.
  const lists = await Promise.all(repos.map((r) => listLabels(r.path)))
  const seen = new Set<string>()
  const options: { value: string; label: string }[] = []
  for (const list of lists) {
    for (const name of list) {
      if (seen.has(name)) {
        continue
      }
      seen.add(name)
      options.push({ value: name, label: name })
    }
  }
  return options
}

export async function listRepoAuthorsViaGh(
  repos: Repo[]
): Promise<{ value: string; label: string }[]> {
  // Reuse issues.ts#listAssignableUsers (repoPath-keyed); dedupe logins across repos.
  const lists = await Promise.all(repos.map((r) => listAssignableUsers(r.path)))
  const seen = new Set<string>()
  const options: { value: string; label: string }[] = []
  for (const list of lists) {
    for (const user of list) {
      if (seen.has(user.login)) {
        continue
      }
      seen.add(user.login)
      options.push({ value: user.login, label: user.name ?? user.login })
    }
  }
  return options
}
