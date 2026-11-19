// Harness lifecycle for the forge entrypoint.
//
// The process has exactly one job: keep app.ts's server alive for the duration
// of a trial. It binds an ephemeral port (the kernel chooses; 8080 belongs to
// the env), tells the env which port it got, then polls /done until the env
// declares the trial finished. Only then does it shut down and exit 0.
//
// Everything here runs on web globals (fetch, setTimeout, AbortSignal) plus
// the app import — no Node built-ins are imported directly.

import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000; // hard cap per request; polls never hang
const BACKOFF_BASE_MS = 250; // wait after the first failure
const BACKOFF_CAP_MS = 2_000; // wait never grows past this
const DONE_POLL_GAP_MS = 250; // steady-state gap between healthy /done polls

/** Report a fatal problem and end the process with a non-zero code. */
function fail(message: string): never {
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
if (envUrl === '') fail('MAKEFUN_ENV_URL is not set; nothing to register with');

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential retry wait: 250, 500, 1000, 2000, 2000, ... for failures 1, 2, 3, ... */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
}

/** Start the server on a kernel-assigned port and resolve with that port. */
function listen(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (addr !== null && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('server.address() did not yield a TCP port'));
    });
  });
}

/**
 * Announce the bound port to the env.
 *  - 200: registered. 409: someone else registered first; we still wait for /done.
 *  - 400/405: the contract itself is wrong — fatal, no amount of retrying helps.
 *  - anything else (network error, timeout, odd status): transient, back off and retry.
 */
async function register(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) {
        await res.body?.cancel();
        return;
      }
      if (res.status === 400 || res.status === 405) {
        fail(`/register rejected the contract with HTTP ${res.status}`);
      }
      await res.body?.cancel(); // drain so the socket can be reused
    } catch {
      // env not up yet, or the request timed out — treat as transient
    }
    failures += 1;
    await wait(backoffMs(failures));
  }
}

/**
 * Poll GET /done until the body is {"done": true}. The env answers instantly,
 * so each poll is short-lived. Healthy polls repeat at a fixed gap; failed
 * polls back off exponentially and reset the backoff once one succeeds.
 */
async function waitForDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    let healthy = false;
    let done = false;
    try {
      const res = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      healthy = res.ok;
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        done = body.done === true;
      } else {
        await res.body?.cancel();
      }
    } catch {
      // failed or timed-out poll: not done, try again after a backoff
    }
    if (done) return;
    if (healthy) {
      failures = 0;
      await wait(DONE_POLL_GAP_MS);
    } else {
      failures += 1;
      await wait(backoffMs(failures));
    }
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const port = await listen(server);
  process.stdout.write(`[entry] listening on ephemeral port ${port}\n`);

  await register(port);
  process.stdout.write('[entry] registered; polling /done until the trial ends\n');

  await waitForDone();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections(); // don't let keep-alive sockets delay shutdown
  });
  process.stdout.write('[entry] env says done; server closed\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
