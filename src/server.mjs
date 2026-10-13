import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { CONFIG_PATH, loadConfig, saveConfig, validateConfig } from './config.mjs';
import { listIPv4Interfaces, selectAddress } from './network.mjs';
import { EventBuffer } from './event-buffer.mjs';
import { checkPreflight, isPortListening } from './preflight.mjs';
import { ServiceManager } from './service-manager.mjs';
import { openBrowser } from './process-platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const startedAt = Date.now();

function suggestions() {
  return [];
}

function currentSelection(config) {
  const candidates = listIPv4Interfaces();
  return { candidates, ...selectAddress(candidates, config.network) };
}

function safeConfig(config) {
  return { ...config, configPath: CONFIG_PATH };
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

export function createApp(configState, { exitOnShutdown = true } = {}) {
  let config = configState.config;
  let boundPort = config.dashboardPort;
  let selection = currentSelection(config);
  const events = new EventBuffer();
  const sessionCookie = randomBytes(24).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const manager = new ServiceManager({ getConfig: () => config, getAddress: () => selection.selected, getDashboardPort: () => boundPort, events });
  let server;
  let shuttingDown = false;
  let shutdownTimer = null;

  const sessionCookieHeader = `rn_laravel_api_runner_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`;
  const authorityAllowed = (host) => [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`].includes(host?.toLowerCase());

  async function readBody(request, maximum = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maximum) throw Object.assign(new Error('Request body exceeds 64 KB.'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function hasSession(request) {
    const cookie = request.headers.cookie ?? '';
    return cookie.split(';').some((item) => item.trim() === `rn_laravel_api_runner_session=${sessionCookie}`);
  }

  function sameOrigin(request) {
    const origin = request.headers.origin;
    return origin === `http://${request.headers.host}`;
  }

  function publicState() {
    const configValue = safeConfig(config);
    return {
      config: configValue,
      configured: Boolean(config.frontendPath && config.apiPath),
      suggestions: suggestions(),
      network: { candidates: selection.candidates, selected: selection.selected, needsSelection: selection.needsSelection, reason: selection.reason },
      manager: manager.snapshot(),
      runner: { startedAt: new Date(startedAt).toISOString(), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), csrfToken },
    };
  }

  async function preflight() {
    const ownedPorts = manager.ownedPorts();
    if (server?.listening) ownedPorts.add(boundPort);
    return checkPreflight(config, { ownedPorts, selectedAddress: selection.selected });
  }

  async function handle(request, response) {
    if (!authorityAllowed(request.headers.host)) return json(response, 403, { error: 'Dashboard accepts loopback Host only.' });
    const url = new URL(request.url, `http://${request.headers.host}`);
    const isMutation = ['PUT', 'POST', 'DELETE', 'PATCH'].includes(request.method);
    if (isMutation && (!hasSession(request) || request.headers['x-csrf-token'] !== csrfToken || !sameOrigin(request))) {
      return json(response, 403, { error: 'Session or same-origin check failed. Refresh dashboard and retry.' });
    }
    if (request.headers.origin && !sameOrigin(request) && url.pathname.startsWith('/api/')) {
      return json(response, 403, { error: 'Cross-origin request rejected.' });
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      return json(response, 200, publicState(), { 'Set-Cookie': sessionCookieHeader });
    }
    if (request.method === 'GET' && url.pathname === '/api/network') {
      selection = currentSelection(config);
      return json(response, 200, publicState());
    }
    if (request.method === 'GET' && url.pathname === '/api/connection') {
      const connection = manager.connection;
      if (!connection || manager.services.expo.state !== 'running') return json(response, 409, { error: 'Expo link is not ready.' });
      const qr = await QRCode.toDataURL(connection.expoUrl, { errorCorrectionLevel: 'M', margin: 2, width: 280 });
      return json(response, 200, { ...connection, qr });
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      if (!hasSession(request)) return json(response, 403, { error: 'Refresh dashboard to establish a session.' });
      const lastEventId = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0) || 0;
      const replay = events.replay(lastEventId);
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(`event: state\ndata: ${JSON.stringify({ type: 'state', data: publicState() })}\n\n`);
      if (replay.truncated) response.write(`event: history-truncated\ndata: ${JSON.stringify({ after: lastEventId })}\n\n`);
      for (const record of replay.records) response.write(`id: ${record.id}\nevent: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`);
      events.clients.add(response);
      response.on('drain', () => {
        if (!response.needsDrain) return;
        const dropped = response.droppedEvents ?? 0;
        response.needsDrain = false;
        response.droppedEvents = 0;
        if (dropped) response.write(`event: history-truncated\ndata: ${JSON.stringify({ dropped })}\n\n`);
      });
      const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 20_000);
      request.on('close', () => { clearInterval(heartbeat); events.clients.delete(response); });
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/config') {
      if (Object.values(manager.services).some((service) => ['starting', 'running', 'stopping'].includes(service.state))) {
        return json(response, 409, { error: 'Stop both services before changing settings.' });
      }
      let value;
      try { value = JSON.parse(await readBody(request)); }
      catch (error) { return json(response, error.status ?? 400, { error: error.status ? error.message : 'Invalid JSON body.' }); }
      const validation = validateConfig(value, { allowEmptyPaths: false });
      if (!validation.ok) return json(response, 422, { error: 'Settings need attention.', fieldErrors: validation.errors });
      selection = currentSelection(validation.config);
      if (validation.config.network.manualAddress && !selection.candidates.some((item) => item.address === validation.config.network.manualAddress)) {
        return json(response, 422, { error: 'Manual LAN address is not assigned to this machine.', fieldErrors: { 'network.manualAddress': 'Choose an address shown in the interface list.' } });
      }
      const saved = await saveConfig(validation.config);
      if (!saved.ok) return json(response, 422, { error: 'Settings need attention.', fieldErrors: saved.errors });
      config = saved.config;
      selection = currentSelection(config);
      events.publish('state', manager.snapshot());
      return json(response, 200, publicState());
    }
    if (request.method === 'POST' && url.pathname === '/api/check') {
      let checkConfig = config;
      if (Number(request.headers['content-length'] ?? 0) > 0) {
        try {
          const body = JSON.parse(await readBody(request));
          const validated = validateConfig(body, { allowEmptyPaths: false });
          if (!validated.ok) return json(response, 422, { error: 'Settings need attention.', fieldErrors: validated.errors });
          checkConfig = validated.config;
        } catch (error) { return json(response, error.status ?? 400, { error: error.status ? error.message : 'Invalid JSON body.' }); }
      }
      const ownedPorts = manager.ownedPorts();
      if (server?.listening) ownedPorts.add(boundPort);
      return json(response, 200, await checkPreflight(checkConfig, { ownedPorts, selectedAddress: currentSelection(checkConfig).selected }));
    }
    if (request.method === 'POST' && url.pathname === '/api/services/start') {
      const operation = manager.startBoth();
      operation.promise.catch((error) => events.publish('error', { operationId: operation.operationId, message: error.message, details: error.details ?? null }));
      return json(response, 202, { operationId: operation.operationId });
    }
    if (request.method === 'POST' && url.pathname === '/api/services/stop') {
      const operation = manager.stopBoth();
      operation.promise.catch((error) => events.publish('error', { operationId: operation.operationId, message: error.message }));
      return json(response, 202, { operationId: operation.operationId });
    }
    const action = url.pathname.match(/^\/api\/services\/(api|expo)\/(start|stop|restart)$/);
    if (request.method === 'POST' && action) {
      const operation = manager.action(action[1], action[2]);
      operation.promise.catch((error) => events.publish('error', { operationId: operation.operationId, message: error.message, details: error.details ?? null }));
      return json(response, 202, { operationId: operation.operationId });
    }
    if (request.method === 'POST' && url.pathname === '/api/shutdown') {
      json(response, 202, { shuttingDown: true });
      shutdown().catch(() => {});
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      const body = await readFile(path.join(PUBLIC, 'index.html'));
      response.writeHead(200, { 'Content-Type': contentTypes['.html'], 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookieHeader, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      response.end(body);
      return;
    }
    if (request.method === 'GET' && ['/styles.css', '/app.js'].includes(url.pathname)) {
      const ext = path.extname(url.pathname);
      const body = await readFile(path.join(PUBLIC, path.basename(url.pathname)));
      response.writeHead(200, { 'Content-Type': contentTypes[ext], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(body);
      return;
    }
    json(response, 404, { error: 'Not found.' });
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(networkTimer);
    for (const client of events.clients) client.end();
    await manager.stopBoth().promise.catch(() => {});
    if (server?.listening) {
      server.close();
      if (exitOnShutdown) {
        shutdownTimer = setTimeout(() => process.exit(0), 250);
        shutdownTimer.unref();
      }
    }
  }

  server = http.createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    handle(request, response).catch((error) => {
      if (response.headersSent) return response.destroy();
      json(response, error.status ?? 500, { error: error.message || 'Unexpected runner error.' });
    });
  });

  const networkTimer = setInterval(() => {
    const next = currentSelection(config);
    if (next.selected?.address !== selection.selected?.address) {
      const previousAddress = selection.selected?.address ?? null;
      selection = next;
      events.publish('network-change', { previousAddress, currentAddress: next.selected?.address ?? null, message: 'Network changed: stop and restart both services.' });
    } else selection = next;
  }, 5000);
  networkTimer.unref();

  return {
    server, manager, events, shutdown,
    async listen() {
      const preferredPort = config.dashboardPort;
      const tryPort = (port) => new Promise((resolve, reject) => {
        const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      try {
        await tryPort(preferredPort);
        boundPort = preferredPort;
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        let listening = false;
        for (let offset = 1; offset <= 20; offset += 1) {
          const candidate = preferredPort + offset;
          if (candidate > 65535) break;
          try {
            await tryPort(candidate);
            boundPort = candidate;
            listening = true;
            break;
          } catch (candidateError) {
            if (candidateError.code !== 'EADDRINUSE') throw candidateError;
          }
        }
        if (!listening) throw new Error(`Dashboard ports ${preferredPort}–${Math.min(preferredPort + 20, 65535)} are already in use.`);
      }
      return `http://127.0.0.1:${boundPort}`;
    },
    async check() {
      const result = await preflight();
      return { ...result, state: publicState() };
    },
  };
}

async function main() {
  const loaded = await loadConfig();
  const app = createApp(loaded);
  if (process.argv.includes('--check')) {
    const result = await app.check();
    for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.label}: ${check.message}`);
    process.exitCode = result.ok ? 0 : 1;
    await app.shutdown();
    return;
  }
  try {
    const existing = await fetch(`http://127.0.0.1:${loaded.config.dashboardPort}/api/state`, { signal: AbortSignal.timeout(1200) });
    if (existing.ok) {
      const state = await existing.json();
      if (state?.runner?.csrfToken && state?.manager?.services) {
        const address = `http://127.0.0.1:${loaded.config.dashboardPort}`;
        console.log(`RN Laravel API Runner already running at ${address}`);
        console.log('Opening existing dashboard. Use Stop All Services to stop Laravel and Expo.');
        if (loaded.config.openBrowser) openBrowser(address);
        await app.shutdown();
        return;
      }
    }
  } catch {
    // The preferred port may be free or belong to another local application.
  }
  let address;
  try { address = await app.listen(); }
  catch (error) {
    console.error(`Runner could not start: ${error.code === 'EADDRINUSE' ? `dashboard port ${loaded.config.dashboardPort} is already in use` : error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`RN Laravel API Runner listening at ${address}${address.endsWith(`:${loaded.config.dashboardPort}`) ? '' : ` (configured port ${loaded.config.dashboardPort} is busy)`}`);
  console.log('Stop services with Stop All Services. Exit Runner stops owned services.');
  if (loaded.errors.config) console.error(loaded.errors.config);
  if (loaded.config.openBrowser) {
    try {
      openBrowser(address).once('error', (error) => console.log(`Open dashboard: ${address} (${error.message})`));
    } catch (error) { console.log(`Open dashboard: ${address} (${error.message})`); }
  }
  process.on('SIGINT', () => { app.shutdown().catch(() => { process.exitCode = 1; }); });
  process.on('SIGTERM', () => { app.shutdown().catch(() => { process.exitCode = 1; }); });
  process.on('uncaughtException', (error) => {
    console.error(`Fatal runner error: ${error.message}`);
    app.shutdown().catch(() => { process.exitCode = 1; });
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(`Runner startup failed: ${error.message}`); process.exitCode = 1; });
}
