// The Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable HTTP, speaking both the
// 2026-07-28 revision (server/discover, no handshake) and the legacy initialize handshake.
// Six tools over the shared forge, with the github-mcp-server argument names.

import { randomUUID } from 'node:crypto';
import { Forge, HttpError } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

export interface McpRequest {
  body: Buffer;
  method: string;
}

export interface McpResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const SERVER_INFO = { name: 'gh-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'A GitHub-compatible forge: repositories, issues and pull requests over MCP tools.';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('Repository name'),
        owner: stringProp('Owner login (defaults to the authenticated user)'),
        description: stringProp('Repository description'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('Owner login'), repo: stringProp('Repository name') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('Owner login'),
        repo: stringProp('Repository name'),
        title: stringProp('Issue title'),
        body: stringProp('Issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('Owner login'),
        repo: stringProp('Repository name'),
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter (default open)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('Owner login'),
        repo: stringProp('Repository name'),
        title: stringProp('Pull request title'),
        body: stringProp('Pull request body'),
        head: stringProp('Head branch name'),
        base: stringProp('Base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('Owner login'),
        repo: stringProp('Repository name'),
        pull_number: { type: 'integer', description: 'Pull request number' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method (default merge)' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolText(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  try {
    switch (name) {
      case 'create_repo': {
        const repo = forge.createRepo(str('name'), str('description'), args.private === true);
        return toolText(repoJson(forge, repo));
      }
      case 'get_repo': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (!repo) return toolFailure('Not Found: repository does not exist');
        return toolText(repoJson(forge, repo));
      }
      case 'create_issue': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (!repo) return toolFailure('Not Found: repository does not exist');
        const issue = forge.createIssue(repo, str('title'), str('body'), []);
        return toolText(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (!repo) return toolFailure('Not Found: repository does not exist');
        const state = str('state') === '' ? 'open' : str('state');
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => b.number - a.number);
        return toolText(issues.map((issue) => issueJson(repo, issue)));
      }
      case 'create_pull_request': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (!repo) return toolFailure('Not Found: repository does not exist');
        const pull = forge.createPull(repo, { title: str('title'), body: str('body'), head: str('head'), base: str('base') });
        return toolText(pullJson(forge, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (!repo) return toolFailure('Not Found: repository does not exist');
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
        const pull = repo.pulls.get(number);
        if (!pull) return toolFailure('Not Found: pull request does not exist');
        const method = str('merge_method') === '' ? 'merge' : str('merge_method');
        const result = forge.mergePull(repo, pull, method);
        return toolText({ sha: result.sha, merged: true, message: result.message, pull_number: number });
      }
      default:
        return toolFailure(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof HttpError) return toolFailure(`${err.message} (HTTP ${err.status})`);
    return toolFailure(err instanceof Error ? err.message : String(err));
  }
}

function handleRpc(forge: Forge, message: Record<string, unknown>): { status: number; json?: unknown; headers?: Record<string, string> } {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202 };
  }
  if (isNotification) return { status: 202 };

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        json: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          instructions: INSTRUCTIONS,
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        json: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }),
        headers: { 'mcp-session-id': randomUUID() },
      };
    }
    case 'ping':
      return { status: 200, json: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) {
        return { status: 200, json: rpcError(id, -32602, `Unknown tool: ${name}`) };
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return { status: 200, json: rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`) };
      }
      return { status: 200, json: rpcResult(id, callTool(forge, name, args)) };
    }
    default:
      return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

export function handleMcp(forge: Forge, request: McpRequest): McpResult {
  if (request.method === 'DELETE') return { status: 204 };
  if (request.method !== 'POST') return { status: 405, json: { message: 'Method Not Allowed' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body.toString('utf8'));
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'Parse error: the request body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { status: 400, json: rpcError(null, -32600, 'Invalid Request: empty batch') };
    const answers = parsed
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => handleRpc(forge, entry))
      .filter((answer) => answer.json !== undefined)
      .map((answer) => answer.json);
    if (answers.length === 0) return { status: 202 };
    return { status: 200, json: answers };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, json: rpcError(null, -32600, 'Invalid Request') };
  }
  const answer = handleRpc(forge, parsed as Record<string, unknown>);
  return { status: answer.status, json: answer.json, headers: answer.headers };
}
