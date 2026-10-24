import { readFileSync } from 'node:fs';
import path from 'node:path';

export function extensionBuildRevision(directory: string): string | undefined {
  try {
    return /^\/\/ cobrowser-extension-build: ([a-f0-9]{64})\n/.exec(
      readFileSync(path.join(directory, 'service-worker.js'), 'utf8').slice(0, 128),
    )?.[1];
  } catch {
    return undefined;
  }
}
