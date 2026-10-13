import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DEFAULT_CONFIG, loadConfig, saveConfig, validateConfig } from '../src/config.mjs';

test('validates distinct unprivileged ports and rejects unknown fields', () => {
  const valid = validateConfig({ ...DEFAULT_CONFIG, frontendPath: 'C:/Projects/expo-app', apiPath: 'C:/Projects/laravel-api' }, { allowEmptyPaths: false });
  assert.equal(valid.ok, true);
  const invalid = validateConfig({ ...DEFAULT_CONFIG, unexpected: true, apiPort: 4310 });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.unexpected);
  assert.match(invalid.errors.apiPort, /distinct/);
});

test('writes a private config atomically to selected path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rn-laravel-api-runner-config-'));
  const file = path.join(directory, 'nested', 'config.json');
  try {
    const result = await saveConfig({ ...DEFAULT_CONFIG, frontendPath: 'C:/Projects/expo-app', apiPath: 'C:/Projects/laravel-api' }, file);
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('migrates legacy local settings without deleting original file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rn-laravel-api-runner-migration-'));
  const legacyFile = path.join(directory, 'legacy', 'config.json');
  const currentFile = path.join(directory, 'current', 'config.json');
  const config = { ...DEFAULT_CONFIG, frontendPath: 'C:/Projects/expo-app', apiPath: 'C:/Projects/laravel-api' };
  try {
    await saveConfig(config, legacyFile);
    const loaded = await loadConfig(currentFile, legacyFile);
    assert.equal(loaded.config.frontendPath, path.resolve(config.frontendPath));
    assert.equal(JSON.parse(await readFile(currentFile, 'utf8')).apiPath, path.resolve(config.apiPath));
    assert.equal(JSON.parse(await readFile(legacyFile, 'utf8')).frontendPath, path.resolve(config.frontendPath));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
