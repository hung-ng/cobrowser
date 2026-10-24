import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [helper, home] = process.argv.slice(2);
const child = spawn(process.execPath, [helper, '--browser', 'chromium'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const arm = path.join(home, 'guard-arm');
const held = path.join(home, 'guard-held');
const release = path.join(home, 'guard-release');
let pending = Buffer.alloc(0);
let queue = Promise.resolve();
let childClosed = false;

function fail(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  child.kill('SIGTERM');
  process.exit(1);
}

async function forward(message, frame) {
  if (message.method === 'guard' && Array.isArray(message.params?.tabs)) {
    const fence = await readFile(arm, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (fence && message.params.tabs.some((tab) => tab.id === JSON.parse(fence).tabId)) {
      await rm(arm);
      await writeFile(held, 'held');
      const deadline = Date.now() + 10_000;
      while (!existsSync(release)) {
        if (childClosed || Date.now() >= deadline)
          throw new Error('The guard fixture was not released; check the test and retry.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await Promise.all([held, release].map((file) => rm(file, { force: true })));
    }
  }
  await new Promise((resolve, reject) => {
    process.stdout.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

process.stdin.pipe(child.stdin);
child.stdin.on('error', () => process.stdin.unpipe(child.stdin));
child.once('error', fail);
process.stdout.on('error', fail);
child.stdout.on('data', (chunk) => {
  try {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0);
      if (!length || length > 1024 * 1024)
        throw new Error('The helper sent an invalid frame; check the fixture and retry.');
      const size = length + 4;
      if (pending.length < size) break;
      const frame = Buffer.from(pending.subarray(0, size));
      pending = pending.subarray(size);
      const message = JSON.parse(frame.subarray(4).toString('utf8'));
      queue = queue.then(() => forward(message, frame)).catch(fail);
    }
  } catch (error) {
    fail(error);
  }
});
child.once('close', (code) => {
  childClosed = true;
  void queue.then(() => process.exit(code ?? 1));
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
process.once('exit', () => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
