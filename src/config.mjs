import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export const CONFIG_DIRECTORY = path.join(homedir(), '.rn-laravel-api-runner');
export const CONFIG_PATH = path.join(CONFIG_DIRECTORY, 'config.json');
export const LEGACY_CONFIG_PATH = path.join(homedir(), '.ess-mobile-runner', 'config.json');

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  frontendPath: '',
  apiPath: '',
  phpExecutable: 'php',
  dashboardPort: 4310,
  apiPort: 8000,
  expoPort: 8081,
  network: {
    mode: 'lan',
    preferredInterface: null,
    manualAddress: null,
  },
  expoRuntime: 'development-build',
  openBrowser: true,
});

const TOP_LEVEL_FIELDS = new Set(Object.keys(DEFAULT_CONFIG));
const NETWORK_FIELDS = new Set(Object.keys(DEFAULT_CONFIG.network));

export function validateConfig(input, { allowEmptyPaths = true } = {}) {
  const errors = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { config: 'Settings must be a JSON object.' } };
  }

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.has(key)) errors[key] = 'Unknown setting.';
  }
  if (input.schemaVersion !== 1) errors.schemaVersion = 'Unsupported settings version.';

  for (const key of ['frontendPath', 'apiPath']) {
    if (typeof input[key] !== 'string' || (!allowEmptyPaths && !input[key].trim())) {
      errors[key] = 'Enter a project directory path.';
    }
  }

  for (const key of ['dashboardPort', 'apiPort', 'expoPort']) {
    const port = input[key];
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      errors[key] = 'Use a port between 1024 and 65535.';
    }
  }
  if ([input.dashboardPort, input.apiPort, input.expoPort].filter(Number.isInteger).length === 3 &&
      new Set([input.dashboardPort, input.apiPort, input.expoPort]).size !== 3) {
    errors.apiPort = 'Dashboard, API and Expo ports must be distinct.';
    errors.expoPort = 'Dashboard, API and Expo ports must be distinct.';
  }

  if (typeof input.phpExecutable !== 'string' || !input.phpExecutable.trim()) {
    errors.phpExecutable = 'Enter a PHP executable or PATH command.';
  } else if (!/[\\/]/.test(input.phpExecutable) && /\s/.test(input.phpExecutable)) {
    errors.phpExecutable = 'PATH commands cannot contain spaces or arguments.';
  }

  if (!input.network || typeof input.network !== 'object' || Array.isArray(input.network)) {
    errors.network = 'Network settings must be an object.';
  } else {
    for (const key of Object.keys(input.network)) {
      if (!NETWORK_FIELDS.has(key)) errors[`network.${key}`] = 'Unknown setting.';
    }
    if (input.network.mode !== 'lan') errors['network.mode'] = 'Only LAN mode is supported.';
    for (const key of ['preferredInterface', 'manualAddress']) {
      const value = input.network[key];
      if (value !== null && typeof value !== 'string') errors[`network.${key}`] = 'Use text or null.';
    }
    if (input.network.manualAddress && !isIPv4(input.network.manualAddress)) {
      errors['network.manualAddress'] = 'Enter a valid IPv4 address.';
    }
  }

  if (!['development-build', 'expo-go'].includes(input.expoRuntime)) {
    errors.expoRuntime = 'Choose development build or Expo Go.';
  }
  if (typeof input.openBrowser !== 'boolean') errors.openBrowser = 'Choose whether to open the dashboard.';

  if (Object.keys(errors).length) return { ok: false, errors };
  const config = {
    ...DEFAULT_CONFIG,
    ...input,
    frontendPath: input.frontendPath.trim() ? path.resolve(input.frontendPath.trim()) : '',
    apiPath: input.apiPath.trim() ? path.resolve(input.apiPath.trim()) : '',
    phpExecutable: input.phpExecutable.trim(),
    network: { ...DEFAULT_CONFIG.network, ...input.network },
  };
  return { ok: true, config, errors: {} };
}

export function isIPv4(value) {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((part) =>
    /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
  );
}

export async function loadConfig(filePath = CONFIG_PATH, legacyFilePath = filePath === CONFIG_PATH ? LEGACY_CONFIG_PATH : null) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const validated = validateConfig(parsed);
    if (!validated.ok) return { config: DEFAULT_CONFIG, configured: false, errors: validated.errors };
    return { config: validated.config, configured: Boolean(validated.config.frontendPath && validated.config.apiPath), errors: {} };
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (legacyFilePath) {
        try {
          const legacyRaw = await readFile(legacyFilePath, 'utf8');
          const validated = validateConfig(JSON.parse(legacyRaw));
          if (!validated.ok) return { config: DEFAULT_CONFIG, configured: false, errors: validated.errors };
          await saveConfig(validated.config, filePath);
          return { config: validated.config, configured: Boolean(validated.config.frontendPath && validated.config.apiPath), errors: {} };
        } catch (legacyError) {
          if (legacyError.code !== 'ENOENT') return { config: DEFAULT_CONFIG, configured: false, errors: { config: `Could not migrate saved settings: ${legacyError.message}` } };
        }
      }
      return { config: DEFAULT_CONFIG, configured: false, errors: {} };
    }
    return { config: DEFAULT_CONFIG, configured: false, errors: { config: `Could not read settings: ${error.message}` } };
  }
}

export async function saveConfig(config, filePath = CONFIG_PATH) {
  const validated = validateConfig(config);
  if (!validated.ok) return validated;
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated.config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true })).catch(() => {});
    throw error;
  }
  return { ok: true, config: validated.config, errors: {} };
}
