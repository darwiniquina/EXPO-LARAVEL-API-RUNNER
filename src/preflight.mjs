import net from 'node:net';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolveExpoCli } from './expo-adapter.mjs';

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

export function isPortListening(port, host = '127.0.0.1', timeoutMs = 450) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function runCapture(executable, args, { cwd, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, output, error: 'Timed out.' }); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, output, error: error.message }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output, error: code === 0 ? null : 'Command failed.' }); });
  });
}

export async function checkPreflight(config, { ownedPorts = new Set(), selectedAddress = null } = {}) {
  const checks = [];
  const add = (id, label, status, message = '') => checks.push({ id, label, status, message });

  const nodeVersion = process.versions.node.split('.').map(Number);
  const nodeSupported = nodeVersion[0] >= 24;
  add('node', 'Node.js', nodeSupported ? 'ok' : 'error', nodeSupported ? `Node.js ${process.versions.node} available.` : `Node.js 24+ required; received ${process.versions.node}.`);

  if (!config.frontendPath) add('frontendPath', 'Frontend folder', 'error', 'Choose frontend project folder.');
  else if (!await exists(path.join(config.frontendPath, 'package.json'))) add('frontendPath', 'Frontend folder', 'error', 'package.json not found in selected folder.');
  else {
    try {
      const pkg = JSON.parse(await readFile(path.join(config.frontendPath, 'package.json'), 'utf8'));
      const expo = await resolveExpoCli(config.frontendPath);
      add('expo', 'Expo CLI', 'ok', `Expo ${expo.version} ready for ${pkg.name ?? 'project'}.`);
    } catch (error) { add('expo', 'Expo CLI', 'error', error.message); }
    if (!await exists(path.join(config.frontendPath, 'node_modules'))) add('frontendDeps', 'Frontend dependencies', 'error', 'node_modules not found. Install project dependencies manually.');
    if (await exists(path.join(config.frontendPath, '.env'))) add('frontendEnv', 'Frontend environment', 'ok', '.env found; runner URL will override only for Expo process.');
    else add('frontendEnv', 'Frontend environment', 'warning', 'No .env found. Expo may need project-specific environment values.');
  }

  if (!config.apiPath) add('apiPath', 'API folder', 'error', 'Choose API project folder.');
  else {
    const required = [
      ['artisan', 'artisan'],
      ['composer', 'composer.json'],
      ['vendor', path.join('vendor', 'autoload.php')],
    ];
    const missing = [];
    for (const [name, relative] of required) if (!await exists(path.join(config.apiPath, relative))) missing.push(name);
    if (missing.length) add('apiPath', 'API project', 'error', `Missing ${missing.join(', ')}. Install dependencies manually; runner will not install them.`);
    else {
      add('apiPath', 'API project', 'ok', 'Laravel files and vendor dependencies found.');
      if (!await exists(path.join(config.apiPath, '.env'))) add('apiEnv', 'API environment', 'error', '.env not found.');
      else add('apiEnv', 'API environment', 'ok', '.env found; contents stay private.');
      if (await exists(path.join(config.apiPath, 'bootstrap', 'cache', 'config.php'))) {
        add('laravelConfig', 'Laravel config cache', 'warning', 'Cached config exists; it can preserve stale settings. Review or clear manually if needed.');
      }
    }
  }

  if (config.apiPath && await exists(path.join(config.apiPath, 'vendor', 'composer', 'platform_check.php'))) {
    const platform = await runCapture(config.phpExecutable, [path.join(config.apiPath, 'vendor', 'composer', 'platform_check.php')], { cwd: config.apiPath });
    add('phpPlatform', 'PHP dependency platform', platform.code === 0 ? 'ok' : 'error', platform.code === 0 ? 'Installed dependencies accept this PHP runtime.' : platform.output.trim().slice(-600) || platform.error);
  } else {
    const version = await runCapture(config.phpExecutable, ['-r', 'echo PHP_VERSION;']);
    const match = version.output.match(/^(\d+)\.(\d+)/);
    const supported = version.code === 0 && match && (Number(match[1]) > 8 || (Number(match[1]) === 8 && Number(match[2]) >= 2));
    add('php', 'PHP executable', supported ? 'ok' : 'error', supported ? `PHP ${version.output.trim()} available.` : version.error ?? `PHP 8.2+ required; received ${version.output.trim() || 'no output'}.`);
  }

  if (!selectedAddress) add('network', 'LAN address', 'error', 'Select a LAN IPv4 address before starting services.');
  else add('network', 'LAN address', 'ok', `Phone endpoint will use ${selectedAddress.address} (${selectedAddress.name}).`);

  for (const [id, label, port] of [['dashboardPort', 'Dashboard port', config.dashboardPort], ['apiPort', 'API port', config.apiPort], ['expoPort', 'Expo port', config.expoPort]]) {
    if (ownedPorts.has(port)) add(id, label, 'ok', `Port ${port} belongs to this runner session.`);
    else if (await isPortListening(port)) add(id, label, 'error', `Port ${port} is already in use. Stop the other process or change this port.`);
    else add(id, label, 'ok', `Port ${port} is available.`);
  }
  const failed = checks.some((check) => check.status === 'error');
  return { ok: !failed, checks };
}
