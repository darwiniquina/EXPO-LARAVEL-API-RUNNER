import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function getWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/state', headers: { Host: host } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

test('serves session state and rejects invalid Host and cross-origin mutations', async () => {
  const dashboardPort = await unusedPort();
  const app = createApp({ config: { ...DEFAULT_CONFIG, dashboardPort }, configured: false, errors: {} }, { exitOnShutdown: false });
  const base = await app.listen();
  try {
    const stateResponse = await fetch(`${base}/api/state`);
    assert.equal(stateResponse.status, 200);
    const session = stateResponse.headers.get('set-cookie').split(';')[0];
    const state = await stateResponse.json();
    assert.ok(state.runner.csrfToken);

    assert.equal(await getWithHost(dashboardPort, `attacker.test:${dashboardPort}`), 403);

    const crossOrigin = await fetch(`${base}/api/services/start`, {
      method: 'POST',
      headers: { Cookie: session, Origin: 'http://attacker.test', 'X-CSRF-Token': state.runner.csrfToken },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);
  } finally { await app.shutdown(); }
});

test('uses next dashboard port when configured port is already occupied', async () => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const preferredPort = occupied.address().port;
  const app = createApp({ config: { ...DEFAULT_CONFIG, dashboardPort: preferredPort }, configured: false, errors: {} }, { exitOnShutdown: false });
  try {
    const base = await app.listen();
    assert.equal(Number(new URL(base).port), preferredPort + 1);
    const response = await fetch(`${base}/api/state`);
    assert.equal(response.status, 200);
  } finally {
    await app.shutdown();
    await new Promise((resolve) => occupied.close(resolve));
  }
});
