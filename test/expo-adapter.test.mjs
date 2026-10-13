import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildExpoEnvironment, discoverExpoUrl, expoArguments } from '../src/expo-adapter.mjs';

test('injects matching LAN API and Metro host without changing tenant root domain', () => {
  const env = buildExpoEnvironment({ EXPO_PUBLIC_ROOT_DOMAIN: 'example.test', EXPO_PUBLIC_API_URL: 'http://old.test', EXPO_TUNNEL_SUBDOMAIN: 'old' }, { apiUrl: 'http://192.0.2.8:8000', address: '192.0.2.8' });
  assert.equal(env.EXPO_PUBLIC_API_URL, 'http://192.0.2.8:8000');
  assert.equal(env.REACT_NATIVE_PACKAGER_HOSTNAME, '192.0.2.8');
  assert.equal(env.EXPO_PUBLIC_ROOT_DOMAIN, 'example.test');
  assert.equal(env.EXPO_TUNNEL_SUBDOMAIN, undefined);
  assert.equal(env.CI, undefined);
});

test('accepts installed SDK development-client scheme and verifies Metro target', async () => {
  const server = http.createServer((request, response) => {
    const packager = encodeURIComponent(`http://192.0.2.8:${server.address().port}`);
    response.writeHead(307, { Location: `exp+example-app://expo-development-client/?url=${packager}` });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const url = await discoverExpoUrl({ address: '192.0.2.8', port, runtime: 'development-build', scheme: 'example-app', slug: 'example-app' });
    assert.match(url, /^exp\+example-app:/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('uses explicit runtime argument', () => {
  assert.deepEqual(expoArguments('C:/project/node_modules/expo/bin/cli', 8081, 'development-build'), ['C:/project/node_modules/expo/bin/cli', 'start', '--lan', '--port', '8081', '--dev-client']);
});
