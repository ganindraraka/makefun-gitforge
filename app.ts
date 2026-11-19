// The forge's HTTP surface: git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3,
// GraphQL v4 at /api/graphql and MCP at /mcp, all over one in-memory store. main.ts owns the
// lifecycle; this file builds the server and routes every request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, HttpError } from './src/store.ts';
import { GitHttp } from './src/git-http.ts';
import type { GitResult } from './src/git-http.ts';
import { handleRest, fastIssueBody } from './src/rest.ts';
import type { RestResult } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { GitError } from './src/git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const API_PREFIX = '/api/v3';
const API_PREFIX_SLASH = `${API_PREFIX}/`;
const REPOS_PREFIX = `${API_PREFIX}/repos/`;
const EMPTY_QUERY = new URLSearchParams();
const EMPTY_BODY = Buffer.alloc(0);
/** Characters that force full URL parsing: query, fragment, encoding, dot segments, backslash. */
const URL_SPECIAL = /[?#%.\\]/;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(8, '0').toUpperCase();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const buf = body === undefined ? EMPTY_BODY : Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(buf);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): Record<string, unknown> {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Body should be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice(7).trim();
  if (presented === '') return false;
  return token === '' || presented === token;
}

function renderRest(res: ServerResponse, result: RestResult): void {
  if (result.status === 204 || (result.json === undefined && result.body === undefined)) {
    res.writeHead(result.status, { 'x-github-request-id': requestId(), ...result.headers });
    res.end();
    return;
  }
  if (result.body !== undefined) {
    res.writeHead(result.status, {
      'content-type': JSON_TYPE,
      'content-length': result.body.length,
      'x-github-request-id': requestId(),
      ...result.headers,
    });
    res.end(result.body);
    return;
  }
  sendJson(res, result.status, result.json, result.headers);
}

function renderGit(res: ServerResponse, result: GitResult): void {
  if (result.body !== undefined) {
    sendBuffer(res, result.status, result.contentType ?? 'application/octet-stream', result.body);
    return;
  }
  sendJson(res, result.status, result.json ?? { message: 'Not Found' });
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

export function createApp(): Server {
  const forge = new Forge();
  const gitHttp = new GitHttp(forge);
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET') {
      const rawUrl = req.url ?? '';
      if (rawUrl.startsWith(REPOS_PREFIX) && !URL_SPECIAL.test(rawUrl) && authorized(req, token)) {
        try {
          const body = fastIssueBody(forge, rawUrl);
          if (body !== undefined) {
            res.writeHead(200, {
              'content-type': JSON_TYPE,
              'content-length': body.length,
              'x-github-request-id': requestId(),
            });
            res.end(body);
            return;
          }
        } catch (err) {
          renderError(res, err);
          return;
        }
      }
    }
    handle(req, res).catch((err) => {
      renderError(res, err);
    });
  });
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  server.keepAliveTimeout = 30_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    let path: string;
    let query: URLSearchParams;
    if (rawUrl.charCodeAt(0) === 47 && !URL_SPECIAL.test(rawUrl)) {
      path = rawUrl;
      query = EMPTY_QUERY;
    } else {
      let url: URL;
      try {
        url = new URL(rawUrl, 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      path = url.pathname;
      query = url.searchParams;
    }

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === API_PREFIX || path.startsWith(API_PREFIX_SLASH)) {
      if (!authorized(req, token)) {
        sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
        return;
      }
      const body = method === 'GET' || method === 'HEAD' ? {} : parseJsonBody(await readBody(req));
      const result = handleRest(forge, {
        method,
        path: path.slice(API_PREFIX.length),
        query,
        body,
        host: req.headers.host ?? 'localhost',
      });
      renderRest(res, result);
      return;
    }

    if (path === '/api/graphql') {
      if (!authorized(req, token)) {
        sendJson(res, 401, { message: 'This endpoint requires you to be authenticated.' });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const runOne = (entry: Record<string, unknown>): unknown =>
        executeGraphQL(
          forge,
          typeof entry.query === 'string' ? entry.query : '',
          (entry.variables ?? {}) as Record<string, unknown>,
          typeof entry.operationName === 'string' ? entry.operationName : null,
        );
      if (Array.isArray(parsed)) {
        sendJson(res, 200, parsed.map((entry) => runOne((entry ?? {}) as Record<string, unknown>)));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        sendJson(res, 400, { message: 'Body should be a JSON object' });
        return;
      }
      sendJson(res, 200, runOne(parsed as Record<string, unknown>));
      return;
    }

    if (path === '/mcp') {
      if (!authorized(req, token)) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }
      const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      const result = handleMcp(forge, { body, method });
      if (result.json === undefined) {
        res.writeHead(result.status, { 'x-github-request-id': requestId(), ...result.headers });
        res.end();
        return;
      }
      sendJson(res, result.status, result.json, result.headers);
      return;
    }

    const gitMatch = GIT_PATH.exec(path);
    if (gitMatch) {
      if (!authorized(req, token)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      let owner: string;
      let name: string;
      try {
        owner = decodeURIComponent(gitMatch[1]);
        name = decodeURIComponent(gitMatch[2]);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      const result = gitHttp.handle({
        method,
        owner,
        name,
        suffix: gitMatch[3] ?? '',
        query,
        gitProtocol: req.headers['git-protocol'] ?? '',
        body,
      });
      renderGit(res, result);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  function renderError(res: ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message, ...(err.extra ?? {}) });
      return;
    }
    if (err instanceof GitError) {
      sendJson(res, 400, { message: err.message });
      return;
    }
    process.stderr.write(`[forge] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    sendJson(res, 500, { message: 'Internal Server Error' });
  }

  return server;
}
