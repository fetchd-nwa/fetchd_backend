import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * How a test boots `src/index.ts` as a child: from an EMPTY working directory (pace 12.14 finding 4; build
 * DECISIONS 826, 832).
 *
 * `src/env.ts` loads `.env.local` and `.env` from the working directory outside production and staging: dotenv
 * resolves both against `process.cwd()` (`.env` by `path.resolve(process.cwd(), '.env')`, `.env.local` as a relative
 * path). The backend's own tree may hold its production `.env`, so a child must never start there. `childEnv()`
 * already says `NODE_ENV=staging`, under which `env.ts` loads nothing; on top of that each child starts in a fresh
 * temporary folder, and the guard checks THAT folder, the one the child would read, never the tree. So the tree's
 * own files no longer stop the suite (they used to: "<name> present: refusing to boot" in a tree holding them).
 *
 * The entry point, the tsx loader and tsx's tsconfig are named by absolute path, as `units/O-M1-mac/start-api.sh`
 * boots her API: nothing the child resolves depends on its working directory.
 */
export interface RealBoot {
  /** The child's working directory: empty, made for this child. */
  readonly cwd: string;
  /** `node` arguments: the tsx loader, any preloads, then `src/index.ts`. */
  readonly args: string[];
  /** Merged into the child's environment (tsx would otherwise look for `tsconfig.json` in `cwd`). */
  readonly env: Record<string, string>;
  /** Removes the folder; call once the child has exited. */
  dispose(): void;
}

/** Refuses a working directory that holds `.env` or `.env.local`: `env.ts` would load it outside production. */
export function assertNoEnvFile(dir: string): void {
  for (const name of ['.env', '.env.local']) {
    assert.equal(
      fs.existsSync(path.join(dir, name)),
      false,
      `${name} present in the child's working directory (${dir}): refusing to boot`,
    );
  }
}

/** `preloads`: repo-relative modules to `--import` after tsx (e.g. `test/contracts/_bootDrainProbe.ts`). */
export function realBoot(preloads: string[] = []): RealBoot {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchd-real-boot-'));
  try {
    assertNoEnvFile(cwd);
  } catch (err) {
    fs.rmSync(cwd, { recursive: true, force: true });
    throw err;
  }
  const href = (rel: string): string => pathToFileURL(path.join(REPO_ROOT, rel)).href;
  return {
    cwd,
    args: [
      '--import',
      href('node_modules/tsx/dist/loader.mjs'),
      ...preloads.flatMap((p) => ['--import', href(p)]),
      path.join(REPO_ROOT, 'src', 'index.ts'),
    ],
    env: { TSX_TSCONFIG_PATH: path.join(REPO_ROOT, 'tsconfig.json') },
    dispose: () => fs.rmSync(cwd, { recursive: true, force: true }),
  };
}
