/**
 * Refuses any DATABASE_URL that is not the isolated db-test container on
 * :5433. Called at `_fixture.ts` module load, so a mis-pointed suite dies
 * before a single connection opens — contract-test teardown hard-DELETEs
 * whatever that URL reaches, and the only database allowed to absorb it is
 * db-test (2026-08-13: a bare `tsx --test` run, where `.env.local` wins,
 * aimed teardown at the dev DB and mangled the seed).
 *
 * Port-only on purpose: `npm test` maps db-test to localhost:5433, but CI or
 * a compose network may reach it under another hostname. The refusal echoes
 * host:port, never the raw URL — the URL carries credentials.
 */
export function assertTestDatabaseUrl(rawUrl: string): void {
  let target: URL | undefined;
  try {
    target = new URL(rawUrl);
  } catch {
    target = undefined;
  }
  if (target?.port === '5433') return;
  const where = target ? `${target.hostname}:${target.port || '(default)'}` : '(unparseable)';
  throw new Error(
    `REFUSING to run contract tests: DATABASE_URL points at ${where}, not the isolated ` +
      'db-test container on :5433, and fixture teardown hard-DELETEs whatever it reaches. ' +
      'Run through `npm test` / `npm run gate`, or export ' +
      'DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres first.',
  );
}
