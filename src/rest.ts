// The GitHub REST v3 surface: repositories, branches, commits, git refs, contents, labels, issues,
// comments, pull requests, files and merges. Every answer is JSON; errors are HttpError instances
// the app renders as {"message": ...} with the exact status.

import { VIEWER } from './scenario.ts';
import { Forge, HttpError, globalId, type Repo, type Issue, type Pull, type Label, type IssueComment } from './store.ts';
import { parseCommit, parseTree, ZERO_OID } from './git.ts';

export interface RestResult {
  status: number;
  json?: unknown;
  /** Pre-serialized JSON body (trailing newline included); wins over `json`. */
  body?: Buffer;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  /** Pathname after /api/v3, still percent-encoded. */
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** The request's Host header, for absolute Link URLs. */
  host: string;
}

let isoCacheMs = -1;
let isoCacheText = '';

function iso(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms === isoCacheMs) return isoCacheText;
  isoCacheMs = ms;
  isoCacheText = new Date(ms).toISOString();
  return isoCacheText;
}

let userJsonCache: Record<string, unknown> | undefined;

export function userJson(): Record<string, unknown> {
  return (userJsonCache ??= {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `http://localhost/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  });
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: userJson(),
    html_url: repo.htmlBase,
    description: repo.description,
    fork: false,
    url: repo.apiBase,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: iso(repo.updatedAt),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    url: `/api/v3/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    url: `${repo.apiBase}/issues/${issue.number}`,
    repository_url: repo.apiBase,
    html_url: `${repo.htmlBase}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    closed_at: iso(issue.closedAt),
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    author_association: 'OWNER',
  };
}

const issueBodyCache = new WeakMap<Issue, { rev: number; body: Buffer }>();

/** The exact bytes sendJson would produce for issueJson, cached until the issue mutates. */
export function issueBody(repo: Repo, issue: Issue): Buffer {
  const cached = issueBodyCache.get(issue);
  if (cached !== undefined && cached.rev === issue.rev) return cached.body;
  const body = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  issueBodyCache.set(issue, { rev: issue.rev, body });
  return body;
}

const REPOS_PREFIX = '/api/v3/repos/';

/**
 * Fast path for GET /api/v3/repos/{owner}/{repo}/issues/{number}. The caller guarantees the path
 * carries no query, percent-encoding, dot segment or backslash. Returns undefined when the path is
 * another route (or names no repository), so the generic router answers exactly as before.
 */
export function fastIssueBody(forge: Forge, path: string): Buffer | undefined {
  const ownerEnd = path.indexOf('/', REPOS_PREFIX.length);
  if (ownerEnd < 0) return undefined;
  const repoEnd = path.indexOf('/', ownerEnd + 1);
  if (repoEnd < 0) return undefined;
  if (!path.startsWith('issues/', repoEnd + 1)) return undefined;
  const numberText = path.slice(repoEnd + 8);
  if (numberText.indexOf('/') >= 0) return undefined;
  const repo = forge.getRepo(path.slice(REPOS_PREFIX.length, ownerEnd), path.slice(ownerEnd + 1, repoEnd));
  if (repo === undefined) return undefined;
  const number = Number.parseInt(numberText, 10);
  if (!Number.isFinite(number)) throw new HttpError(404, 'Not Found');
  return issueBody(repo, forge.requireIssue(repo, number));
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `http://localhost/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    body: comment.body,
    user: userJson(),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.updatedAt),
    author_association: 'OWNER',
  };
}

function commitJson(forge: Forge, repo: Repo, oid: string): Record<string, unknown> {
  const object = forge.objects.get(oid);
  const commit = object && object.type === 'commit' ? parseCommit(object.data) : null;
  const identity = (line: string): Record<string, unknown> => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    const date = match ? new Date(Number(match[3]) * 1000).toISOString() : iso(repo.createdAt);
    return { name: match ? match[1] : VIEWER.name, email: match ? match[2] : VIEWER.email, date };
  };
  const author = commit ? identity(commit.author) : identity('');
  const committer = commit ? identity(commit.committer) : author;
  return {
    sha: oid,
    node_id: globalId('Commit', repo.id, oid),
    url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}`,
    html_url: `http://localhost/${repo.fullName}/commit/${oid}`,
    comments_url: `/api/v3/repos/${repo.fullName}/commits/${oid}/comments`,
    commit: {
      url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}`,
      author,
      committer,
      message: commit ? commit.message.replace(/\n$/, '') : '',
      tree: { sha: commit ? commit.tree : ZERO_OID, url: '' },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: userJson(),
    committer: userJson(),
    parents: (commit ? commit.parents : []).map((parent) => ({
      sha: parent,
      url: `/api/v3/repos/${repo.fullName}/git/commits/${parent}`,
      html_url: `http://localhost/${repo.fullName}/commit/${parent}`,
    })),
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const side = (ref: string): Record<string, unknown> => {
    const sha = forge.branchTip(repo, ref) ?? pull.mergeCommitSha ?? ZERO_OID;
    return {
      label: `${repo.owner}:${ref}`,
      ref,
      sha,
      user: userJson(),
      repo: repoJson(forge, repo),
    };
  };
  const mergeable = forge.pullMergeable(repo, pull);
  const files = pull.state === 'open' || pull.merged ? forge.pullFiles(repo, pull) : [];
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `http://localhost/${repo.fullName}/pull/${pull.number}`,
    diff_url: `http://localhost/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `http://localhost/${repo.fullName}/pull/${pull.number}.patch`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
    closed_at: iso(pull.closedAt),
    merged_at: iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    head: side(pull.head),
    base: side(pull.base),
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.merged ? 'unknown' : mergeable === true ? 'clean' : mergeable === false ? 'dirty' : 'unknown',
    merged_by: pull.merged ? userJson() : null,
    comments: 0,
    review_comments: 0,
    commits: files.length > 0 ? 1 : 0,
    additions,
    deletions,
    changed_files: files.length,
    author_association: 'OWNER',
    draft: false,
  };
}

function branchJson(forge: Forge, repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: commitJson(forge, repo, sha),
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
  };
}

function refJson(repo: Repo, ref: string, sha: string, type: string): Record<string, unknown> {
  return {
    ref,
    node_id: globalId('Ref', repo.id, ref),
    url: `/api/v3/repos/${repo.fullName}/git/${ref}`,
    object: { type, sha, url: `/api/v3/repos/${repo.fullName}/git/${type}s/${sha}` },
  };
}

function b64wrap(data: Buffer): string {
  const text = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += 60) lines.push(text.slice(i, i + 60));
  return lines.join('\n') + (lines.length ? '\n' : '');
}

function fileJson(repo: Repo, entry: { sha: string; data: Buffer; name: string; path: string }): Record<string, unknown> {
  return {
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
    size: entry.data.length,
    url: `/api/v3/repos/${repo.fullName}/contents/${entry.path}`,
    html_url: `http://localhost/${repo.fullName}/blob/HEAD/${entry.path}`,
    git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.sha}`,
    download_url: null,
    type: 'file',
    content: b64wrap(entry.data),
    encoding: 'base64',
    _links: { self: '', git: '', html: '' },
  };
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Slice a list into a page and build the GitHub Link header for it. */
function paginate<T>(items: readonly T[], request: RestRequest, path: string): RestResult {
  const perPage = Math.min(100, intParam(request.query, 'per_page', 30));
  const page = intParam(request.query, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const link = (target: number, rel: string): string => {
    const params = new URLSearchParams(request.query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `<http://${request.host}${path}?${params.toString()}>; rel="${rel}"`;
  };
  if (page < totalPages) links.push(link(page + 1, 'next'));
  if (page > 1) links.push(link(page - 1, 'prev'));
  if (page > 1) links.push(link(1, 'first'));
  if (page < totalPages) links.push(link(totalPages, 'last'));
  const headers: Record<string, string> = {};
  if (links.length) headers.link = links.join(', ');
  return { status: 200, json: slice, headers };
}

function listOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function sortIssues(issues: Issue[], query: URLSearchParams): Issue[] {
  const direction = query.get('direction') === 'asc' ? 1 : -1;
  const sort = query.get('sort') ?? 'created';
  const key = (issue: Issue): number => {
    if (sort === 'updated') return issue.updatedAt;
    if (sort === 'comments') return issue.comments.length;
    return issue.createdAt * 1000 + issue.number;
  };
  return issues.sort((a, b) => (key(a) - key(b)) * direction || (a.number - b.number) * direction);
}

export function handleRest(forge: Forge, request: RestRequest): RestResult {
  const segments = request.path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new HttpError(400, 'Bad Request: malformed path encoding');
      }
    });
  const { method, query, body } = request;

  if (segments.length === 0) {
    return {
      status: 200,
      json: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}',
        commit_search_url: '/api/v3/search/commits?q={query}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': '' },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, json: { verifiable_password_authentication: false, ssh_key_fingerprints: {}, hooks: [], web: [], api: [], git: [], packages: [], pages: [], importer: [], actions: [], dependabot: [], installed_version: '1.0.0' } };
  }

  if (segments[0] === 'rate_limit' && method === 'GET') {
    const resources = { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 };
    return { status: 200, json: { resources: { core: resources, search: { ...resources, limit: 30 }, graphql: resources, integration_manifest: resources }, rate: resources } };
  }

  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') return { status: 200, json: userJson() };
    if (segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const items = forge.repoList.map((repo) => repoJson(forge, repo));
        return paginate(items, request, '/api/v3/user/repos');
      }
      if (method === 'POST') {
        const repo = forge.createRepo(body.name as string, (body.description as string) ?? '', body.private === true);
        return { status: 201, json: repoJson(forge, repo), headers: { location: `/api/v3/repos/${repo.fullName}` } };
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = forge.requireRepo(segments[1], segments[2]);
    const rest = segments.slice(3);
    return repoRoutes(forge, repo, rest, request);
  }

  throw new HttpError(404, 'Not Found');
}

function repoRoutes(forge: Forge, repo: Repo, rest: string[], request: RestRequest): RestResult {
  const { method, query, body } = request;
  const base = `/api/v3/repos/${repo.fullName}`;

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, json: repoJson(forge, repo) };
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && forge.branchTip(repo, body.default_branch)) repo.defaultBranch = body.default_branch;
      repo.updatedAt = Date.now();
      return { status: 200, json: repoJson(forge, repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204 };
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---------------------------------------------------------------- branches and refs

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) branches.push(branchJson(forge, repo, ref.slice(11), sha));
      }
      return { status: 200, json: branches };
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = forge.branchTip(repo, rest[1]);
      if (sha === undefined) throw new HttpError(404, 'Branch not found');
      return { status: 200, json: branchJson(forge, repo, rest[1], sha) };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'POST') {
        const ref = body.ref as string;
        const sha = body.sha as string;
        forge.createRef(repo, ref, sha);
        const object = forge.objects.get(sha);
        return { status: 201, json: refJson(repo, ref, sha, object?.type ?? 'commit'), headers: { location: `${base}/git/${ref}` } };
      }
      if (method === 'GET') {
        const refs: Array<Record<string, unknown>> = [];
        for (const [ref, sha] of repo.refs) refs.push(refJson(repo, ref, sha, forge.objects.get(sha)?.type ?? 'commit'));
        return { status: 200, json: refs };
      }
    }
    if (rest.length > 2 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      return { status: 200, json: refJson(repo, ref, sha, forge.objects.get(sha)?.type ?? 'commit') };
    }
    if (rest.length > 2 && method === 'DELETE') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (!repo.refs.has(ref)) throw new HttpError(404, 'Not Found');
      repo.refs.delete(ref);
      repo.bumpRefs();
      return { status: 204 };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (rest[0] === 'git' && rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
    const object = forge.objects.get(rest[2]);
    if (!object || object.type !== 'commit') throw new HttpError(404, 'Not Found');
    return { status: 200, json: commitJson(forge, repo, rest[2]) };
  }

  if (rest[0] === 'git' && rest[1] === 'trees' && rest.length >= 3 && method === 'GET') {
    const object = forge.objects.get(rest[2]);
    if (!object || object.type !== 'tree') throw new HttpError(404, 'Not Found');
    const entries = parseTree(object.data).map((entry) => ({
      path: entry.name,
      mode: entry.mode,
      type: entry.mode === '40000' ? 'tree' : 'blob',
      sha: entry.oid,
      size: forge.objects.get(entry.oid)?.data.length ?? 0,
      url: '',
    }));
    return { status: 200, json: { sha: rest[2], url: '', tree: entries, truncated: false } };
  }

  // ---------------------------------------------------------------- commits

  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const tip = forge.resolveCommit(repo, query.get('sha'));
      if (tip === null) throw new HttpError(409, 'Git Repository is empty.');
      const perPage = Math.min(100, intParam(query, 'per_page', 30));
      const page = intParam(query, 'page', 1);
      const oids = forge.history(tip, perPage * page + 1);
      const slice = oids.slice((page - 1) * perPage, page * perPage);
      return { status: 200, json: slice.map((oid) => commitJson(forge, repo, oid)) };
    }
    if (rest.length === 2 && method === 'GET') {
      const oid = forge.resolveCommit(repo, rest[1]);
      if (oid === null) throw new HttpError(404, 'Not Found');
      return { status: 200, json: commitJson(forge, repo, oid) };
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---------------------------------------------------------------- contents

  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const entry = forge.readPath(repo, query.get('ref'), path);
      if (entry === null) throw new HttpError(404, 'Not Found');
      if (entry.kind === 'file') return { status: 200, json: fileJson(repo, entry) };
      return {
        status: 200,
        json: entry.entries.map((item) => ({
          name: item.name,
          path: item.path,
          sha: item.sha,
          size: item.size,
          url: `${base}/contents/${item.path}`,
          html_url: `http://localhost/${repo.fullName}/tree/HEAD/${item.path}`,
          git_url: `${base}/git/${item.type === 'dir' ? 'trees' : 'blobs'}/${item.sha}`,
          download_url: null,
          type: item.type,
          _links: { self: '', git: '', html: '' },
        })),
      };
    }
    if (method === 'PUT') {
      if (typeof body.content !== 'string') throw new HttpError(422, "Validation Failed: 'content' wasn't supplied");
      const content = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64');
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
      const result = forge.writePath(repo, {
        path,
        content,
        message,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      const entry = forge.readPath(repo, typeof body.branch === 'string' ? body.branch : undefined, path);
      const contentJson = entry !== null && entry.kind === 'file'
        ? { ...fileJson(repo, entry), content: undefined, encoding: 'base64' }
        : { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' };
      return { status: result.created ? 201 : 200, json: { content: contentJson, commit: commitJson(forge, repo, result.commitSha) } };
    }
    if (method === 'DELETE') {
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
      const result = forge.writePath(repo, {
        path,
        content: null,
        message,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      return { status: 200, json: { content: null, commit: commitJson(forge, repo, result.commitSha) } };
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---------------------------------------------------------------- labels

  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') return { status: 200, json: [...repo.labels.values()].map(labelJson) };
      if (method === 'POST') {
        const label = forge.createLabel(repo, body.name as string, body.color as string);
        return { status: 201, json: labelJson(label), headers: { location: `${base}/labels/${encodeURIComponent(label.name)}` } };
      }
    }
    if (rest.length === 2 && method === 'GET') {
      const label = repo.labels.get(rest[1]);
      if (!label) throw new HttpError(404, 'Not Found');
      return { status: 200, json: labelJson(label) };
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---------------------------------------------------------------- issues

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        issues = sortIssues(issues, query);
        const items = issues.map((issue) => issueJson(repo, issue));
        return paginate(items, request, `${base}/issues`);
      }
      if (method === 'POST') {
        const issue = forge.createIssue(repo, body.title as string, body.body as string, listOfStrings(body.labels));
        return { status: 201, body: issueBody(repo, issue), headers: { location: `${base}/issues/${issue.number}` } };
      }
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isFinite(number)) throw new HttpError(404, 'Not Found');
      const issue = forge.requireIssue(repo, number);
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: issueBody(repo, issue) };
        if (method === 'PATCH') {
          const now = Date.now();
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            if (body.state !== issue.state) {
              issue.state = body.state;
              issue.closedAt = body.state === 'closed' ? now : null;
            }
          }
          if (Array.isArray(body.labels)) {
            const names = listOfStrings(body.labels);
            const attached: Label[] = [];
            for (const name of names) {
              const label = repo.labels.get(name);
              if (!label) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
              attached.push(label);
            }
            issue.labels = attached;
          }
          issue.updatedAt = now;
          issue.rev += 1;
          return { status: 200, json: issueJson(repo, issue) };
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          const items = issue.comments.map((comment) => commentJson(repo, issue, comment));
          return paginate(items, request, `${base}/issues/${number}/comments`);
        }
        if (method === 'POST') {
          const comment = forge.addComment(repo, issue, body.body as string);
          return { status: 201, json: commentJson(repo, issue, comment), headers: { location: `${base}/issues/comments/${comment.id}` } };
        }
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---------------------------------------------------------------- pulls

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        const direction = query.get('direction') === 'asc' ? 1 : -1;
        pulls.sort((a, b) => (a.createdAt - b.createdAt || a.number - b.number) * direction);
        const items = pulls.map((pull) => pullJson(forge, repo, pull));
        return paginate(items, request, `${base}/pulls`);
      }
      if (method === 'POST') {
        const pull = forge.createPull(repo, {
          title: body.title as string,
          body: typeof body.body === 'string' ? body.body : '',
          head: body.head as string,
          base: body.base as string,
        });
        return { status: 201, json: pullJson(forge, repo, pull), headers: { location: `${base}/pulls/${pull.number}` } };
      }
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isFinite(number)) throw new HttpError(404, 'Not Found');
      const pull = forge.requirePull(repo, number);
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, json: pullJson(forge, repo, pull) };
        if (method === 'PATCH') {
          const now = Date.now();
          if (typeof body.title === 'string') pull.title = body.title;
          if (typeof body.body === 'string') pull.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            pull.state = body.state;
            pull.closedAt = body.state === 'closed' ? now : null;
          }
          if (typeof body.base === 'string' && forge.branchTip(repo, body.base)) pull.base = body.base;
          pull.updatedAt = now;
          return { status: 200, json: pullJson(forge, repo, pull) };
        }
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = forge.pullFiles(repo, pull).map((file) => ({
          sha: file.sha ?? ZERO_OID,
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
          blob_url: `http://localhost/${repo.fullName}/blob/HEAD/${file.filename}`,
          raw_url: `http://localhost/${repo.fullName}/raw/HEAD/${file.filename}`,
          contents_url: `${base}/contents/${file.filename}`,
          patch: '',
        }));
        return paginate(files, request, `${base}/pulls/${number}/files`);
      }
      if (rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
        const headTip = forge.branchTip(repo, pull.head);
        const baseTip = forge.branchTip(repo, pull.base);
        if (headTip === undefined || baseTip === undefined) return { status: 200, json: [] };
        const base = forge.mergeBase(baseTip, headTip);
        const exclude = base === null ? new Set<string>() : new Set(forge.history(base, 100_000));
        const oids = forge.history(headTip, 250).filter((oid) => !exclude.has(oid));
        return { status: 200, json: oids.map((oid) => commitJson(forge, repo, oid)) };
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method === 'GET') {
          if (pull.merged) return { status: 204 };
          throw new HttpError(404, 'Not Found');
        }
        if (method === 'PUT') {
          const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
          if (!['merge', 'squash', 'rebase'].includes(mergeMethod)) throw new HttpError(400, 'Invalid merge method');
          if (typeof body.sha === 'string' && body.sha !== forge.branchTip(repo, pull.head)) {
            throw new HttpError(409, 'Head branch was modified. Review and try the merge again.');
          }
          const result = forge.mergePull(repo, pull, mergeMethod);
          return { status: 200, json: { sha: result.sha, merged: true, message: result.message } };
        }
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}
