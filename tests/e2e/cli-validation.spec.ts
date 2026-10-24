import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../../dist/cli.js');
const env = { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined };

test('caps early argument errors regardless of global option order', async () => {
  for (const cap of [1, 10, 64]) {
    for (const json of [false, true]) {
      for (const browserFirst of [false, true]) {
        const args = browserFirst
          ? ['tabs', '--browser', '--max-chars', String(cap)]
          : ['tabs', '--max-chars', String(cap), '--browser'];
        if (json) args.push('--json');
        const failure = await exec(process.execPath, [cli, ...args], { env }).catch(
          (error) => error,
        );
        expect(failure.code).toBe(1);
        const output = json ? failure.stdout : failure.stderr;
        expect(output.length).toBeGreaterThan(0);
        expect(output.length).toBeLessThanOrEqual(cap);
        expect(json ? failure.stderr : failure.stdout).toBe('');
        if (json) {
          const value = JSON.parse(output);
          if (value && typeof value === 'object' && 'ok' in value) expect(value.ok).toBe(false);
          if (cap >= 64) expect(value.error.code).toBe('BAD_REQUEST');
        }
      }
    }
  }
});

test('keeps actionable argument diagnostics when capacity permits', async () => {
  for (const json of [false, true]) {
    const args = ['tabs', '--browser', '--max-chars', '200'];
    if (json) args.push('--json');
    const failure = await exec(process.execPath, [cli, ...args], { env }).catch((error) => error);
    expect(failure.code).toBe(1);
    const output = json ? failure.stdout : failure.stderr;
    expect(output.length).toBeLessThanOrEqual(200);
    if (json)
      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'Use --browser with a value.' },
      });
    else expect(output).toContain('BAD_REQUEST: Use --browser with a value.');
  }
});
