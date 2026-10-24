import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { physicalPath } from './install-transaction.js';

const WAIT_MS = 30_000;
export const SETUP_LOCK_NAME = '.cb-setup-lock';
const OWNER = /^owner-([1-9][0-9]*)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function hasCode(error: unknown, ...codes: string[]): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code)),
  );
}

async function removeEmpty(directory: string): Promise<void> {
  try {
    await fs.rmdir(directory);
  } catch (error) {
    if (!hasCode(error, 'ENOENT', 'ENOTEMPTY', 'EEXIST')) throw error;
  }
}

async function removeOwner(
  directory: string,
  owner: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  try {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
    const file = path.join(directory, owner);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) return;
    await fs.unlink(file);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  // A replacement owner publishes a nonempty directory, which rmdir cannot remove.
  await removeEmpty(directory);
}

async function recoverDeadOwner(directory: string): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (!entries.length) {
      await removeEmpty(directory);
      return;
    }
    if (entries.length !== 1 || !entries[0].isFile()) return;
    const owner = entries[0].name;
    const match = OWNER.exec(owner);
    const pid = Number(match?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return;
    try {
      process.kill(pid, 0);
      return;
    } catch (error) {
      if (!hasCode(error, 'ESRCH')) return;
    }
    const identity = await fs.lstat(path.join(directory, owner));
    if (identity.isFile() && identity.size === 0) await removeOwner(directory, owner, identity);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

async function acquire(root: string): Promise<() => Promise<void>> {
  let candidate: string | undefined;
  let acquired = false;
  let timedOut = false;
  try {
    const physicalRoot = await physicalPath(root);
    await fs.mkdir(physicalRoot, { recursive: true, mode: 0o700 });
    const directory = path.join(physicalRoot, SETUP_LOCK_NAME);
    candidate = await fs.mkdtemp(path.join(physicalRoot, '.cb-setup-waiter-'));
    const owner = `owner-${process.pid}-${randomUUID()}`;
    const marker = path.join(candidate, owner);
    await fs.writeFile(marker, '', { mode: 0o600, flag: 'wx' });
    const identity = await fs.lstat(marker);
    const deadline = performance.now() + WAIT_MS;
    while (true) {
      try {
        // Publishing the marker with the directory leaves no ownerless acquisition window.
        await fs.rename(candidate, directory);
        acquired = true;
        return () => removeOwner(directory, owner, identity);
      } catch (error) {
        if (!hasCode(error, 'EEXIST', 'ENOTEMPTY')) throw error;
      }
      await recoverDeadOwner(directory);
      if (performance.now() >= deadline) {
        timedOut = true;
        throw new Error(
          `Another cobrowser setup is still running or its lock at ${directory} could not be verified; wait for it to finish, then check the lock directory and try setup again.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (error) {
    if (timedOut) throw error;
    throw new Error(
      `Could not acquire the setup lock at ${root}; check the home path and directory permissions, then run setup again.`,
    );
  } finally {
    if (candidate && !acquired)
      await fs.rm(candidate, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function withSetupLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const release = await acquire(root);
  let completed = false;
  try {
    const result = await action();
    completed = true;
    return result;
  } finally {
    try {
      await release();
    } catch {
      if (completed)
        throw new Error(
          `Could not release the setup lock at ${root}; check directory permissions and run setup again.`,
        );
    }
  }
}
