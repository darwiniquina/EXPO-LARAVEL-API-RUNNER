import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnOwned, stopOwned } from '../src/process-platform.mjs';

async function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

test('stops owned fixture process tree', { timeout: 10000 }, async () => {
  const fixture = path.join(import.meta.dirname, 'fixtures', 'service.mjs');
  const child = spawnOwned(process.execPath, [fixture], { cwd: path.dirname(fixture), env: process.env });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  for (let attempt = 0; attempt < 30 && !output.includes('worker pid'); attempt++) await delay(50);
  const workerPid = Number(output.match(/worker pid (\d+)/)?.[1]);
  assert.ok(workerPid > 0, 'fixture worker started');
  const stopped = await stopOwned(child, { graceMs: 1500, forceMs: 1500 });
  assert.equal(stopped.stopped, true);
  for (let attempt = 0; attempt < 20 && await isAlive(workerPid); attempt++) await delay(50);
  assert.equal(await isAlive(workerPid), false, 'descendant exited with owned process tree');
});
