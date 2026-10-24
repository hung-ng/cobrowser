import fsp from 'node:fs/promises';
import path from 'node:path';

interface InstallTarget {
  path: string;
  kind: 'file' | 'directory';
}

interface InstallEntry extends InstallTarget {
  temporary: string;
  staged: string;
  backup: string;
  backedUp: boolean;
  installed: boolean;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export async function physicalPath(file: string): Promise<string> {
  try {
    return await fsp.realpath(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
    // A dangling symlink is not a directory that setup can create.
    if (
      await fsp.lstat(file).catch((cause) => (isMissing(cause) ? undefined : Promise.reject(cause)))
    )
      throw new Error(`The path ${file} is a broken link; fix it and run setup again.`);
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await physicalPath(parent), path.basename(file));
  }
}

export class InstallTransaction {
  private entries: InstallEntry[] = [];
  private recoveryDirectory?: string;
  private recoveryFile?: string;
  private retainRecovery = false;

  constructor(
    private root: string,
    private targets: InstallTarget[],
  ) {}

  async prepare(): Promise<void> {
    const resolved: string[] = [];
    for (const target of this.targets) {
      try {
        const existing = await fsp.lstat(target.path).catch((error) => {
          if (!isMissing(error)) throw error;
          return undefined;
        });
        if (existing && !(target.kind === 'file' ? existing.isFile() : existing.isDirectory()))
          throw new Error('Unexpected target type.');
        resolved.push(await physicalPath(target.path));
      } catch {
        throw new Error(
          `Could not prepare ${target.path}; check its file type and directory permissions, then run setup again.`,
        );
      }
    }
    for (let index = 0; index < resolved.length; index++)
      for (let other = 0; other < index; other++) {
        const first = resolved[index];
        const second = resolved[other];
        if (
          first === second ||
          first.startsWith(`${second}${path.sep}`) ||
          second.startsWith(`${first}${path.sep}`)
        )
          throw new Error(
            'Setup destinations overlap; choose separate native-host directories outside the runtime and extension folders, then run setup again.',
          );
      }
    for (const target of this.targets) {
      try {
        await fsp.mkdir(path.dirname(target.path), { recursive: true, mode: 0o700 });
        const temporary = await fsp.mkdtemp(path.join(path.dirname(target.path), '.cb-install-'));
        this.entries.push({
          ...target,
          temporary,
          staged: path.join(temporary, 'staged'),
          backup: path.join(temporary, 'previous'),
          backedUp: false,
          installed: false,
        });
      } catch {
        throw new Error(
          `Could not prepare ${target.path}; check directory permissions and run setup again.`,
        );
      }
    }
    try {
      this.recoveryDirectory = await fsp.mkdtemp(path.join(this.root, '.cb-recovery-'));
      this.recoveryFile = path.join(this.recoveryDirectory, 'recovery.json');
      await fsp.writeFile(
        this.recoveryFile,
        `${JSON.stringify({ files: this.entries.map(({ path: target, backup }) => ({ target, backup })) }, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch {
      throw new Error(
        'Could not prepare setup recovery files; check directory permissions and run setup again.',
      );
    }
  }

  staged(target: string): string {
    const entry = this.entries.find((entry) => entry.path === target);
    if (!entry) throw new Error('The setup destination was not prepared; run setup again.');
    return entry.staged;
  }

  async commit(): Promise<void> {
    for (const entry of this.entries) {
      try {
        const staged = await fsp.lstat(entry.staged);
        if (!(entry.kind === 'file' ? staged.isFile() : staged.isDirectory()))
          throw new Error('Unexpected staged file type.');
      } catch {
        throw new Error(
          `Could not prepare ${entry.path}; check the source build and directory permissions, then run setup again.`,
        );
      }
    }
    let destination = this.root;
    try {
      for (const entry of this.entries) {
        destination = entry.path;
        try {
          await fsp.rename(entry.path, entry.backup);
          entry.backedUp = true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await fsp.rename(entry.staged, entry.path);
        entry.installed = true;
      }
    } catch {
      for (const entry of [...this.entries].reverse()) {
        try {
          if (entry.installed) {
            await fsp.rename(entry.path, entry.staged);
            entry.installed = false;
          }
          if (entry.backedUp) {
            await fsp.rename(entry.backup, entry.path);
            entry.backedUp = false;
          }
        } catch {
          this.retainRecovery = true;
        }
      }
      if (this.retainRecovery) {
        const journal = {
          files: this.entries
            .filter((entry) => entry.backedUp || entry.installed)
            .map((entry) => ({
              target: entry.path,
              ...(entry.backedUp ? { backup: entry.backup } : {}),
              ...(entry.installed ? { remove: true } : {}),
            })),
        };
        try {
          const temporary = `${this.recoveryFile}.tmp`;
          await fsp.writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
          await fsp.rename(temporary, this.recoveryFile!);
        } catch {
          // The original journal still lists every possible backup if this update fails.
        }
        throw new Error(
          `Setup failed; restore the files listed in ${this.recoveryFile} before running setup again.`,
        );
      }
      throw new Error(
        `Could not install ${destination}; the previous installation was restored, so check directory permissions and run setup again.`,
      );
    }
  }

  async cleanup(): Promise<string[]> {
    const retained: string[] = [];
    for (const entry of this.entries) {
      if (this.retainRecovery && (entry.backedUp || entry.installed)) continue;
      try {
        await fsp.rm(entry.temporary, { recursive: true, force: true });
      } catch {
        retained.push(entry.temporary);
      }
    }
    if (this.recoveryDirectory && !this.retainRecovery) {
      try {
        await fsp.rm(this.recoveryDirectory, { recursive: true, force: true });
      } catch {
        retained.push(this.recoveryDirectory);
      }
    }
    return retained.map(
      (directory) => `Setup cleanup left files at ${directory}; remove them when ready.`,
    );
  }
}
