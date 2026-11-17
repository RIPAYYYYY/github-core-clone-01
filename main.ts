// main.ts: the process entry point. It owns only the lifecycle the harness drives, nothing of the
// forge itself (that is app.ts and the modules behind it):
//
//   - MAKEFUN_ENV_URL names the suite's origin. Without it there is nobody to register with, so the
//     process exits 1 immediately.
//   - The forge binds an ephemeral port with listen(0) — never 8080, which belongs to the suite.
//   - It POSTs {"port": N} to $MAKEFUN_ENV_URL/register. The suite records the caller's address with
//     that port as the forge's base URL and drives it from there. The first register wins; a 409
//     answer means one already landed and changes nothing.
//   - It polls GET $MAKEFUN_ENV_URL/done until the suite answers {"done": true}, then closes the
//     server and exits 0. Failed polls are retried with backoff; the process never exits early.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is unset: no suite to register with\n');
  process.exit(1);
}

/** One register or poll attempt may hang at most this long before it is abandoned and retried. */
const ATTEMPT_TIMEOUT_MS = 30_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff between retries: 250 ms doubling to a 2 s cap. */
function backoff(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** Math.min(attempt, 8));
}

/** Register the bound port, retrying transient failures; 400/405 are contract errors and fatal. */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoff(attempt));
  }
}

/** Poll the suite's /done until it reports the trial is over. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The suite is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoff(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const bound = server.address();
if (bound === null || typeof bound === 'string') throw new Error('the forge did not bind an ephemeral TCP port');
process.stdout.write(`[forge] listening on port ${bound.port}\n`);

await register(bound.port);
process.stdout.write('[forge] registered; waiting for the suite to finish\n');

await waitForDone();
server.close();
process.stdout.write('[forge] done\n');
process.exit(0);
