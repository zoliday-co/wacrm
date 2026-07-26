import { timingSafeEqual } from 'node:crypto';

/**
 * Shared auth for the scheduled endpoints (`/api/automations/cron`,
 * `/api/flows/cron`).
 *
 * Two header shapes are accepted because the two ways of scheduling
 * this app disagree on how to present a secret:
 *
 *   - `x-cron-secret: <secret>` — external pingers (GitHub Actions,
 *     cron-job.org, a VPS crontab running curl). The original scheme;
 *     kept so existing setups don't break.
 *   - `Authorization: Bearer <secret>` — Vercel Cron. Vercel injects
 *     this header itself from the `CRON_SECRET` env var and gives no
 *     way to configure custom headers in `vercel.json`, so without
 *     this branch every scheduled invocation 401s.
 *
 * The secret is read from `AUTOMATION_CRON_SECRET`, falling back to
 * `CRON_SECRET` — on Vercel the latter is the name the platform
 * already requires, so operators can set just that one if they only
 * ever schedule through Vercel. Setting both to the same value is the
 * portable choice.
 */
export function verifyCronSecret(request: Request): boolean {
  const expected =
    process.env.AUTOMATION_CRON_SECRET ?? process.env.CRON_SECRET;
  if (!expected) return false;

  const bearer = request.headers.get('authorization') ?? '';
  const supplied = bearer.toLowerCase().startsWith('bearer ')
    ? bearer.slice(7).trim()
    : (request.headers.get('x-cron-secret') ?? '');

  return constantTimeEquals(supplied, expected);
}

/** True when the cron secret is configured under either name. */
export function isCronConfigured(): boolean {
  return Boolean(process.env.AUTOMATION_CRON_SECRET ?? process.env.CRON_SECRET);
}

/**
 * Constant-time string compare. `timingSafeEqual` throws on a length
 * mismatch, so the length is checked first — that leaks only the
 * secret's length, which isn't sensitive, while keeping the byte
 * comparison itself free of early-exit timing signal.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
