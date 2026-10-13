import path from 'node:path';
import { spawnOwned, stopOwned } from './process-platform.mjs';
import { buildExpoEnvironment, discoverExpoUrl, expoArguments, readExpoIdentity, resolveExpoCli } from './expo-adapter.mjs';
import { checkPreflight, isPortListening } from './preflight.mjs';

const START_TIMEOUTS = { api: 30_000, expo: 120_000 };

export class ServiceManager {
  constructor({ getConfig, getAddress, getDashboardPort, events }) {
    this.getConfig = getConfig;
    this.getAddress = getAddress;
    this.getDashboardPort = getDashboardPort;
    this.events = events;
    this.services = {
      api: this.makeService('api', 'Laravel API'),
      expo: this.makeService('expo', 'Expo'),
    };
    this.queue = Promise.resolve();
    this.operation = null;
    this.connection = null;
    this.sessionSettings = null;
  }

  makeService(id, label) {
    return { id, label, state: 'stopped', readiness: 'unknown', child: null, pid: null, startedAt: null, exitCode: null, lastError: null, endpoint: null, operationId: null };
  }

  snapshot() {
    return {
      services: Object.fromEntries(Object.entries(this.services).map(([id, service]) => [id, {
        id, label: service.label, state: service.state, readiness: service.readiness, pid: service.pid,
        startedAt: service.startedAt, exitCode: service.exitCode, lastError: service.lastError,
        endpoint: service.endpoint,
      }])),
      operation: this.operation,
      connection: this.connection,
      configured: Boolean(this.getConfig().frontendPath && this.getConfig().apiPath),
    };
  }

  ownedPorts() {
    const config = this.getConfig();
    const ports = new Set();
    if (this.services.api.child && this.services.api.state !== 'failed') ports.add(config.apiPort);
    if (this.services.expo.child && this.services.expo.state !== 'failed') ports.add(config.expoPort);
    return ports;
  }

  enqueue(label, work) {
    const operationId = crypto.randomUUID();
    const run = async () => {
      this.operation = { id: operationId, label, state: 'running', startedAt: new Date().toISOString(), error: null };
      this.events.publish('state', this.snapshot());
      try {
        const result = await work(operationId);
        this.operation = { ...this.operation, state: 'complete', finishedAt: new Date().toISOString() };
        this.events.publish('state', this.snapshot());
        return { operationId, result };
      } catch (error) {
        this.operation = { ...this.operation, state: 'failed', error: error.message, finishedAt: new Date().toISOString() };
        this.events.publish('state', this.snapshot());
        throw error;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return { operationId, promise: result };
  }

  startBoth() {
    return this.enqueue('Start Both', (operationId) => this.startBothNow(operationId));
  }

  stopBoth() {
    return this.enqueue('Stop All Services', () => this.stopBothNow());
  }

  action(serviceId, action) {
    if (!this.services[serviceId] || !['start', 'stop', 'restart'].includes(action)) throw new Error('Unsupported service action.');
    return this.enqueue(`${action[0].toUpperCase()}${action.slice(1)} ${this.services[serviceId].label}`, async (operationId) => {
      if (action === 'stop') return this.stopService(serviceId);
      if (action === 'restart') await this.stopService(serviceId);
      await this.ensurePreflight(serviceId);
      return this.startService(serviceId, operationId);
    });
  }

  async ensurePreflight(target = null) {
    const config = this.getConfig();
    const address = this.getAddress();
    const ownedPorts = this.ownedPorts();
    ownedPorts.add(this.getDashboardPort());
    const preflight = await checkPreflight(config, { ownedPorts, selectedAddress: address });
    const relevantChecks = target === 'api'
      ? new Set(['node', 'apiPath', 'apiEnv', 'php', 'phpPlatform', 'network', 'apiPort', 'dashboardPort'])
      : target === 'expo'
        ? new Set(['node', 'frontendPath', 'expo', 'frontendDeps', 'network', 'expoPort', 'dashboardPort'])
        : null;
    const failedChecks = preflight.checks.filter((check) => check.status === 'error' && (!relevantChecks || relevantChecks.has(check.id)));
    if (failedChecks.length) {
      const error = new Error('Setup check failed. Review the highlighted checks.');
      error.details = { ok: false, checks: preflight.checks };
      throw error;
    }
    if (target === 'api') {
      const expo = preflight.checks.find((check) => check.id === 'expo');
      if (expo?.status === 'error') throw new Error(expo.message);
    }
    return preflight;
  }

  async startBothNow(operationId) {
    await this.ensurePreflight();
    const startedHere = [];
    try {
      for (const id of ['api', 'expo']) {
        if (this.services[id].state === 'running') continue;
        await this.startService(id, operationId);
        startedHere.push(id);
      }
      return this.snapshot();
    } catch (error) {
      for (const id of startedHere.reverse()) await this.stopService(id);
      throw error;
    }
  }

  async stopBothNow() {
    const results = [];
    for (const id of ['expo', 'api']) results.push(await this.stopService(id));
    this.connection = null;
    this.sessionSettings = null;
    this.events.publish('state', this.snapshot());
    return results;
  }

  async startService(id, operationId) {
    const service = this.services[id];
    if (service.state === 'running' && service.child && service.child.exitCode === null) return service;
    const config = this.getConfig();
    const address = this.getAddress();
    const apiUrl = `http://${address.address}:${config.apiPort}`;
    const endpoint = id === 'api' ? apiUrl : `http://${address.address}:${config.expoPort}`;
    service.state = 'starting';
    service.readiness = 'unknown';
    service.lastError = null;
    service.operationId = operationId;
    service.endpoint = endpoint;
    this.events.publish('state', this.snapshot());

    let launchedChild = null;
    try {
      let executable;
      let args;
      let cwd;
      let env = { ...process.env };
      if (id === 'api') {
        executable = config.phpExecutable;
        args = ['artisan', 'serve', '--host=0.0.0.0', `--port=${config.apiPort}`, '--tries=1'];
        cwd = config.apiPath;
      } else {
        const cli = await resolveExpoCli(config.frontendPath);
        executable = process.execPath;
        args = expoArguments(cli.cliPath, config.expoPort, config.expoRuntime);
        cwd = config.frontendPath;
        env = buildExpoEnvironment(env, { apiUrl, address: address.address });
      }
      const child = spawnOwned(executable, args, { cwd, env });
      launchedChild = child;
      service.child = child;
      service.pid = child.pid;
      service.startedAt = new Date().toISOString();
      child.stdout.on('data', (chunk) => this.events.log(id, 'stdout', chunk));
      child.stderr.on('data', (chunk) => this.events.log(id, 'stderr', chunk));
      child.once('error', (error) => { child.spawnError = error; this.failService(id, error.message); });
      child.once('exit', (code, signal) => this.handleExit(id, code, signal));
      await this.waitReady(id, child);
      service.state = 'running';
      service.readiness = id === 'api' ? 'listening' : 'ready';
      if (id === 'expo') {
        const { scheme, slug } = await readExpoIdentity(config.frontendPath);
        const expoUrl = await discoverExpoUrl({ address: address.address, port: config.expoPort, runtime: config.expoRuntime, scheme, slug });
        this.connection = { apiUrl, expoUrl, scheme, address: address.address, expoPort: config.expoPort, runtime: config.expoRuntime, verified: true };
        this.sessionSettings = { apiUrl, address: address.address, apiPort: config.apiPort, expoPort: config.expoPort };
      }
      this.events.publish('state', this.snapshot());
      return service;
    } catch (error) {
      if (launchedChild && launchedChild.exitCode === null && launchedChild.signalCode === null) {
        await stopOwned(launchedChild).catch(() => {});
      }
      service.child = null;
      service.pid = null;
      service.state = 'failed';
      service.readiness = 'unknown';
      service.lastError = error.message;
      this.events.publish('state', this.snapshot());
      throw error;
    }
  }

  async waitReady(id, child) {
    const config = this.getConfig();
    const port = id === 'api' ? config.apiPort : config.expoPort;
    const deadline = Date.now() + START_TIMEOUTS[id];
    while (Date.now() < deadline) {
      if (child.spawnError) throw new Error(`Could not start ${id === 'api' ? 'PHP' : 'Expo'}: ${child.spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${id === 'api' ? 'Laravel' : 'Expo'} exited during startup (${child.exitCode ?? child.signalCode}).`);
      if (id === 'api') {
        if (await isPortListening(port)) return;
      } else {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2500) });
          if (response.ok && (await response.text()).includes('packager-status:running')) return;
        } catch {
          // Metro can accept a connection before its status response is complete.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`${id === 'api' ? 'Laravel' : 'Expo'} did not become ready within ${Math.round(START_TIMEOUTS[id] / 1000)} seconds.`);
  }

  async stopService(id) {
    const service = this.services[id];
    const child = service.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      service.state = 'stopped';
      service.readiness = 'unknown';
      service.child = null;
      service.pid = null;
      this.events.publish('state', this.snapshot());
      return { stopped: true, alreadyStopped: true };
    }
    service.state = 'stopping';
    this.events.publish('state', this.snapshot());
    const result = await stopOwned(child);
    if (!result.stopped) throw new Error(`Could not stop ${service.label} process tree.`);
    service.state = 'stopped';
    service.readiness = 'unknown';
    service.child = null;
    service.pid = null;
    service.startedAt = null;
    service.endpoint = null;
    if (id === 'expo') this.connection = null;
    this.events.publish('state', this.snapshot());
    return result;
  }

  failService(id, message) {
    const service = this.services[id];
    service.state = 'failed';
    service.readiness = 'unknown';
    service.lastError = message;
    this.events.publish('state', this.snapshot());
  }

  handleExit(id, code, signal) {
    const service = this.services[id];
    service.exitCode = code;
    service.pid = null;
    service.state = service.state === 'stopping' ? 'stopped' : 'failed';
    service.readiness = 'unknown';
    if (service.state === 'failed') service.lastError = `${service.label} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`;
    service.child = null;
    this.events.publish('state', this.snapshot());
    if (id === 'api' && service.state === 'failed' && this.services.expo.state === 'running') {
      this.enqueue('Stop Expo after API failure', () => this.stopService('expo'));
    }
  }
}
