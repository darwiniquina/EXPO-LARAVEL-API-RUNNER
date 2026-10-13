import { spawn } from 'node:child_process';

export function spawnOwned(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function runTaskkill(pid, force) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const child = spawn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore', shell: false });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

export async function stopOwned(child, { graceMs = 1800, forceMs = 1200 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { stopped: true, forced: false };
  if (process.platform === 'win32') {
    await runTaskkill(child.pid, false);
    if (await waitForExit(child, graceMs)) return { stopped: true, forced: false };
    await runTaskkill(child.pid, true);
    return { stopped: await waitForExit(child, forceMs), forced: true };
  }

  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  if (await waitForExit(child, graceMs)) return { stopped: true, forced: false };
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  return { stopped: await waitForExit(child, forceMs), forced: true };
}

export function openBrowser(url) {
  let executable;
  let args;
  if (process.platform === 'win32') [executable, args] = ['cmd.exe', ['/c', 'start', '', url]];
  else if (process.platform === 'darwin') [executable, args] = ['open', [url]];
  else [executable, args] = ['xdg-open', [url]];
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  child.unref();
  return child;
}
