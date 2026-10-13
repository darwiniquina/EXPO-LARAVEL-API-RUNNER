import { createRequire } from 'node:module';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

export async function resolveExpoCli(frontendPath) {
  const projectRequire = createRequire(path.join(frontendPath, 'package.json'));
  let packagePath;
  try {
    packagePath = projectRequire.resolve('expo/package.json');
  } catch {
    packagePath = path.join(frontendPath, 'node_modules', 'expo', 'package.json');
  }
  const expoPackage = JSON.parse(await readFile(packagePath, 'utf8'));
  const entry = typeof expoPackage.bin === 'string' ? expoPackage.bin : expoPackage.bin?.expo;
  if (!entry) throw new Error('Installed Expo package has no CLI entry.');
  const cliPath = path.resolve(path.dirname(packagePath), entry);
  await access(cliPath);
  return { cliPath, version: expoPackage.version };
}

export function expoArguments(cliPath, port, runtime) {
  return [cliPath, 'start', '--lan', '--port', String(port), runtime === 'expo-go' ? '--go' : '--dev-client'];
}

export function buildExpoEnvironment(parentEnvironment, { apiUrl, address }) {
  const env = { ...parentEnvironment };
  for (const key of ['EXPO_PACKAGER_PROXY_URL', 'EXPO_TUNNEL_SUBDOMAIN']) delete env[key];
  delete env.CI;
  env.EXPO_PUBLIC_API_URL = apiUrl;
  env.REACT_NATIVE_PACKAGER_HOSTNAME = address;
  env.FORCE_COLOR = '0';
  return env;
}

export async function discoverExpoUrl({ address, port, runtime, scheme, slug, platform = 'android' }) {
  const choice = runtime === 'development-build' ? '&choice=expo-dev-client' : '';
  const endpoint = `http://127.0.0.1:${port}/_expo/link?platform=${platform}${choice}`;
  const deadline = Date.now() + 30_000;
  let lastError;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (response.status !== 307 && response.status !== 302) throw new Error(`Expo link discovery returned HTTP ${response.status}.`);
      target = response.headers.get('location');
      if (target) break;
      lastError = new Error('Expo link discovery returned no redirect URL.');
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  if (!target) throw new Error(`Expo link discovery failed after 30 seconds: ${lastError?.message ?? 'No redirect received.'}`);

  const url = new URL(target);
  if (runtime === 'development-build') {
    const acceptedSchemes = [scheme, `exp+${slug}`].filter(Boolean).map((value) => `${value}:`);
    if (!acceptedSchemes.includes(url.protocol) || url.hostname !== 'expo-development-client') {
      throw new Error('Expo returned an invalid development-build URL.');
    }
    const packagerUrl = url.searchParams.get('url');
    if (!packagerUrl) throw new Error('Development-build URL has no Metro target.');
    const packager = new URL(packagerUrl);
    if (packager.hostname !== address || Number(packager.port) !== port) {
      throw new Error('Expo link host or port does not match selected LAN session.');
    }
  } else if (url.hostname !== address || Number(url.port) !== port) {
    throw new Error('Expo Go link host or port does not match selected LAN session.');
  }
  return target;
}

export async function readExpoIdentity(frontendPath) {
  const appJson = JSON.parse(await readFile(path.join(frontendPath, 'app.json'), 'utf8'));
  const configured = appJson.expo?.scheme;
  const scheme = Array.isArray(configured) ? configured[0] : configured;
  return { scheme, slug: appJson.expo?.slug };
}
