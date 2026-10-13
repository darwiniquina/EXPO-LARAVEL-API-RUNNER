const form = document.querySelector('#settings-form');
const banner = document.querySelector('#banner');
let state;
let csrfToken = '';
let eventSource;
let connectionRequest = false;
let renderedOperationState = '';
let savedSettingsSnapshot = null;
let settingsLocked = false;
const consoleRecords = { api: [], expo: [] };
const consolePaused = { api: false, expo: false };
const pendingConsoleRecords = { api: [], expo: [] };
const consoleFlushScheduled = { api: false, expo: false };

const fields = Object.fromEntries([...form.elements].filter((element) => element.name).map((element) => [element.name, element]));

function showBanner(message, kind = '') {
  banner.textContent = message;
  banner.className = `banner ${kind}`.trim();
  banner.classList.remove('hidden');
}

function clearBanner() { banner.classList.add('hidden'); }

function appendLog(record) {
  const service = record.data?.service;
  if (record.type === 'log' && consoleRecords[service]) {
    consoleRecords[service].push(record);
    if (consoleRecords[service].length > 1200) consoleRecords[service].splice(0, consoleRecords[service].length - 1200);
    if (consolePaused[service]) return;
    pendingConsoleRecords[service].push(record);
    if (pendingConsoleRecords[service].length > 1200) pendingConsoleRecords[service].splice(0, pendingConsoleRecords[service].length - 1200);
    if (!consoleFlushScheduled[service]) {
      consoleFlushScheduled[service] = true;
      requestAnimationFrame(() => flushConsole(service));
    }
  }
}

function createConsoleLine(record) {
  const line = document.createElement('div');
  line.className = 'console-line';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date(record.at ?? Date.now()).toLocaleTimeString();
  const message = document.createElement('span');
  message.className = `log-message ${record.data?.stream === 'stderr' ? 'error' : ''}`;
  message.textContent = record.data?.message ?? '';
  line.append(time, message);
  return line;
}

function flushConsole(service) {
  consoleFlushScheduled[service] = false;
  if (consolePaused[service]) {
    pendingConsoleRecords[service].length = 0;
    return;
  }
  const target = document.querySelector(`#${service}-console`);
  const pending = pendingConsoleRecords[service].splice(0);
  if (!pending.length) return;
  if (target.querySelector('.log-empty')) target.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const record of pending) fragment.append(createConsoleLine(record));
  target.append(fragment);
  while (target.childElementCount > 600) target.firstElementChild.remove();
  target.scrollTop = target.scrollHeight;
}

function renderConsole(service) {
  if (consolePaused[service]) return;
  const target = document.querySelector(`#${service}-console`);
  const records = consoleRecords[service];
  const fragment = document.createDocumentFragment();
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'log-empty';
    empty.textContent = `Waiting for ${service === 'api' ? 'API' : 'Expo'} output.`;
    fragment.append(empty);
  }
  for (const record of records.slice(-600)) fragment.append(createConsoleLine(record));
  target.replaceChildren(fragment);
  target.scrollTop = target.scrollHeight;
}

function setSelectOptions(network) {
  const select = fields.networkAddress;
  const previous = select.value || network.selected?.address || state?.config?.network?.manualAddress || '';
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = network.candidates.length ? 'Select LAN interface' : 'No LAN address found';
  select.append(placeholder);
  for (const candidate of network.candidates) {
    const option = document.createElement('option');
    option.value = candidate.address;
    option.textContent = `${candidate.name} · ${candidate.address}`;
    select.append(option);
  }
  if (network.candidates.some((candidate) => candidate.address === previous)) select.value = previous;
  document.querySelector('#network-help').textContent = network.reason === 'multiple-candidates' ? 'Multiple adapters found. Choose the network your phone can reach.' : 'Choose adapter phone can reach. VPNs may need manual selection.';
}

function fillSettings(value) {
  fields.frontendPath.value = value.config.frontendPath || value.suggestions[0] || '';
  fields.apiPath.value = value.config.apiPath || value.suggestions[1] || '';
  fields.phpExecutable.value = value.config.phpExecutable;
  fields.dashboardPort.value = value.config.dashboardPort;
  fields.apiPort.value = value.config.apiPort;
  fields.expoPort.value = value.config.expoPort;
  fields.expoRuntime.value = value.config.expoRuntime;
  fields.openBrowser.checked = value.config.openBrowser;
  setSelectOptions(value.network);
  updateSettingsLock(value.manager);
  savedSettingsSnapshot = settingsFormSnapshot();
  updateSaveButton();
  document.querySelector('#runner-uptime').textContent = `Runner uptime · ${formatUptime(value.runner.uptimeSeconds)}`;
}

function updateSettingsLock(manager) {
  settingsLocked = Object.values(manager.services).some((service) => ['starting', 'running', 'stopping'].includes(service.state));
  document.querySelector('#settings-lock').textContent = settingsLocked ? 'Locked while running' : 'Editable';
  for (const element of form.elements) element.disabled = settingsLocked;
  document.querySelector('#check-setup').disabled = settingsLocked;
  updateSaveButton();
}

function settingsFormSnapshot() { return JSON.stringify(getFormConfig()); }

function settingsHaveChanges() {
  return savedSettingsSnapshot !== null && settingsFormSnapshot() !== savedSettingsSnapshot;
}

function updateSaveButton() {
  document.querySelector('#save-settings').disabled = settingsLocked || !settingsHaveChanges();
}

function setSettingsMessage(message, kind = '') {
  const target = document.querySelector('#settings-message');
  target.textContent = message;
  target.className = ('settings-message ' + kind).trim();
  target.classList.toggle('hidden', !message);
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function renderService(service) {
  const card = document.querySelector(`[data-service="${service.id}"]`);
  const badge = card.querySelector('.state-badge');
  badge.textContent = service.state;
  badge.className = `state-badge state-${service.state}`;
  card.querySelector('.endpoint').textContent = service.endpoint || 'No endpoint';
  const error = card.querySelector('.service-error');
  error.textContent = service.lastError || '';
  error.classList.toggle('hidden', !service.lastError);
  const transitioning = ['starting', 'stopping'].includes(service.state);
  const operationBusy = state?.manager?.operation?.state === 'running';
  card.querySelector('[data-action="start"]').disabled = transitioning || service.state === 'running' || operationBusy;
  card.querySelector('[data-action="restart"]').disabled = transitioning || service.state !== 'running' || operationBusy;
  card.querySelector('[data-action="stop"]').disabled = transitioning || !['running', 'starting'].includes(service.state) || operationBusy;
  if (service.state === 'running' && service.id === 'api') card.querySelector('.service-detail').textContent = 'Listening, application health unverified';
  else if (service.state === 'running' && service.id === 'expo') card.querySelector('.service-detail').textContent = `Metro ready · PID ${service.pid ?? '—'}`;
  else card.querySelector('.service-detail').textContent = service.id === 'api' ? 'Laravel application process' : 'Metro bundle server';
}

function renderState(value, { forceSettings = false } = {}) {
  const preserveEdits = settingsHaveChanges() && !forceSettings;
  state = value;
  csrfToken = value.runner.csrfToken;
  if (!preserveEdits) fillSettings(value);
  renderManager(value.manager);
}

function renderManager(manager) {
  if (state) state.manager = manager;
  const operation = manager.operation;
  const services = Object.values(manager.services);
  const transitioning = services.some((service) => ['starting', 'stopping'].includes(service.state));
  const operationBusy = operation?.state === 'running';
  document.querySelector('#start-both').disabled = transitioning || operationBusy || services.every((service) => service.state === 'running');
  document.querySelector('#stop-both').disabled = transitioning || operationBusy || services.every((service) => !['starting', 'running'].includes(service.state));
  for (const service of services) renderService(service);
  const operationPill = document.querySelector('#operation-pill');
  operationPill.textContent = operation ? `${operation.label} · ${operation.state}` : 'Idle';
  operationPill.classList.toggle('live', operation?.state === 'running');
  const operationKey = operation ? `${operation.id}:${operation.state}` : '';
  if (operationKey && operationKey !== renderedOperationState) {
    renderedOperationState = operationKey;
    if (operation.state === 'failed') showBanner(operation.error || `${operation.label} failed.`, 'error');
    else if (operation.state === 'complete' && operation.label === 'Start Both') showBanner('Both services are ready. Scan the Expo link on your phone.', 'success');
    else if (operation.state === 'complete' && operation.label === 'Stop All Services') showBanner('All services stopped. Runner stays available.', 'success');
  }
  updateSettingsLock(manager);
  if (manager.services.expo.state === 'running') refreshConnection();
  else clearConnection();
}

async function apiRequest(url, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || `Request failed (${response.status}).`);
    error.fieldErrors = value.fieldErrors;
    error.details = value.details;
    throw error;
  }
  return value;
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('state', (event) => {
    const record = JSON.parse(event.data);
    const next = record.data?.manager ? record.data : record.data?.data?.manager ? record.data.data : null;
    if (next) renderState(next);
    else if (record.data?.services) renderManager(record.data);
    if (record.data?.service) appendLog(record);
  });
  eventSource.addEventListener('log', (event) => appendLog(JSON.parse(event.data)));
  eventSource.addEventListener('error', (event) => {
    if (!event.data) return;
    const record = JSON.parse(event.data);
    if (record.data?.details?.checks) renderChecks(record.data.details.checks);
    showBanner(record.data?.message ?? 'Runner operation failed. Check service output.', 'error');
    appendLog(record);
  });
  eventSource.addEventListener('network-change', (event) => {
    const record = JSON.parse(event.data);
    showBanner(record.data?.message ?? 'Network changed. Stop and restart both services.', 'error');
    appendLog(record);
  });
  eventSource.addEventListener('history-truncated', () => showBanner('Some older log output was trimmed. Current service output continues.', ''));
  eventSource.onerror = () => {
    document.querySelector('#operation-pill').textContent = 'Reconnecting…';
  };
}

function clearConnection() {
  document.querySelector('#connection-pill').textContent = 'Waiting';
  document.querySelector('#connection-pill').classList.remove('live');
  document.querySelector('#qr-image').classList.add('hidden');
  document.querySelector('#qr-placeholder').classList.remove('hidden');
  document.querySelector('#expo-url').textContent = 'Not connected';
  document.querySelector('#api-url').textContent = 'API: not connected';
  document.querySelector('#copy-expo').disabled = true;
  document.querySelector('#copy-api').disabled = true;
  document.querySelector('#connection-note').textContent = 'API says “Listening, application health unverified.” Device login checks tenant routing.';
}

async function refreshConnection() {
  if (connectionRequest) return;
  connectionRequest = true;
  try {
    const connection = await apiRequest('/api/connection');
    document.querySelector('#connection-pill').textContent = 'Ready';
    document.querySelector('#connection-pill').classList.add('live');
    const image = document.querySelector('#qr-image');
    image.src = connection.qr;
    image.classList.remove('hidden');
    document.querySelector('#qr-placeholder').classList.add('hidden');
    document.querySelector('#expo-url').textContent = connection.expoUrl;
    document.querySelector('#api-url').textContent = connection.apiUrl;
    document.querySelector('#copy-expo').disabled = false;
    document.querySelector('#copy-api').disabled = false;
  } catch (error) {
    document.querySelector('#connection-pill').textContent = 'Discovering link';
    document.querySelector('#connection-note').textContent = error.message;
  } finally { connectionRequest = false; }
}

function renderChecks(checks) {
  const container = document.querySelector('#check-results');
  const fragment = document.createDocumentFragment();
  for (const check of checks) {
    const row = document.createElement('div'); row.className = 'check-row-result';
    const status = document.createElement('strong'); status.className = `check-${check.status}`; status.textContent = check.status.toUpperCase();
    const label = document.createElement('strong'); label.textContent = check.label;
    const message = document.createElement('span'); message.textContent = check.message;
    row.append(status, label, message); fragment.append(row);
  }
  container.replaceChildren(fragment);
  container.classList.remove('hidden');
}

function getFormConfig() {
  return {
    schemaVersion: 1,
    frontendPath: fields.frontendPath.value.trim(),
    apiPath: fields.apiPath.value.trim(),
    phpExecutable: fields.phpExecutable.value.trim(),
    dashboardPort: Number(fields.dashboardPort.value),
    apiPort: Number(fields.apiPort.value),
    expoPort: Number(fields.expoPort.value),
    network: { mode: 'lan', preferredInterface: null, manualAddress: fields.networkAddress.value || null },
    expoRuntime: fields.expoRuntime.value,
    openBrowser: fields.openBrowser.checked,
  };
}

function clearFieldErrors() { document.querySelectorAll('.field-error').forEach((element) => { element.textContent = ''; }); }

form.addEventListener('input', updateSaveButton);
form.addEventListener('change', updateSaveButton);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearBanner(); clearFieldErrors(); setSettingsMessage('');
  try {
    const submitted = getFormConfig(); delete submitted._previousNetwork;
    const value = await apiRequest('/api/config', { method: 'PUT', body: submitted });
    renderState(value, { forceSettings: true });
    settingsDialog.close();
    showBanner(`Settings saved to ${value.config.configPath}. Dashboard port changes apply after restarting Runner.`, 'success');
  } catch (error) {
    if (error.fieldErrors) for (const [key, message] of Object.entries(error.fieldErrors)) {
      const target = document.querySelector(`[data-error="${CSS.escape(key)}"]`);
      if (target) target.textContent = message;
    }
    setSettingsMessage(error.message, 'error');
  }
});

document.querySelector('#check-setup').addEventListener('click', async () => {
  setSettingsMessage('');
  try {
    const config = getFormConfig(); delete config._previousNetwork;
    const result = await apiRequest('/api/check', { method: 'POST', body: config });
    renderChecks(result.checks);
    setSettingsMessage(result.ok ? 'Setup checks passed. Review results below.' : 'Setup needs fixes. Review results below.', result.ok ? 'success' : 'error');
  } catch (error) { setSettingsMessage(error.message, 'error'); }
});

document.querySelector('#start-both').addEventListener('click', async () => {
  if (openSettingsForUnsavedChanges()) return;
  clearBanner();
  try { await apiRequest('/api/services/start', { method: 'POST', body: {} }); showBanner('Starting Laravel API, then Expo. Progress appears below.', ''); }
  catch (error) { showBanner(error.message, 'error'); }
});
document.querySelector('#stop-both').addEventListener('click', async () => {
  clearBanner();
  try { await apiRequest('/api/services/stop', { method: 'POST', body: {} }); showBanner('Stopping Expo, then Laravel API.', ''); }
  catch (error) { showBanner(error.message, 'error'); }
});
document.querySelectorAll('.service-card button').forEach((button) => button.addEventListener('click', async () => {
  const card = button.closest('.service-card');
  if (button.dataset.action !== 'stop' && openSettingsForUnsavedChanges()) return;
  try { await apiRequest(`/api/services/${card.dataset.service}/${button.dataset.action}`, { method: 'POST', body: {} }); }
  catch (error) { showBanner(error.message, 'error'); }
}));
document.querySelector('#exit-runner').addEventListener('click', async () => {
  if (!confirm('Exit Runner and stop owned API and Expo processes?')) return;
  try { await apiRequest('/api/shutdown', { method: 'POST', body: {} }); showBanner('Runner is stopping services and closing.', ''); }
  catch (error) { showBanner(error.message, 'error'); }
});
function updateButton(button, label, iconName) {
  button.querySelector('.button-label').textContent = label;
  button.querySelector('use')?.setAttribute('href', `#icon-${iconName}`);
}

document.querySelector('#copy-expo').addEventListener('click', () => navigator.clipboard.writeText(document.querySelector('#expo-url').textContent));
document.querySelector('#copy-api').addEventListener('click', () => navigator.clipboard.writeText(document.querySelector('#api-url').textContent));

const consoleDrawer = document.querySelector('#console-drawer');
const consoleButton = document.querySelector('#show-consoles');
const settingsDialog = document.querySelector('#settings-dialog');
const aboutDialog = document.querySelector('#about-dialog');
document.querySelector('#show-settings').addEventListener('click', () => settingsDialog.showModal());
document.querySelector('#close-settings').addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});
document.querySelector('#show-about').addEventListener('click', () => aboutDialog.showModal());
document.querySelector('#close-about').addEventListener('click', () => aboutDialog.close());
aboutDialog.addEventListener('click', (event) => {
  if (event.target === aboutDialog) aboutDialog.close();
});

function openSettingsForUnsavedChanges() {
  if (!settingsHaveChanges()) return false;
  if (!settingsDialog.open) settingsDialog.showModal();
  setSettingsMessage('Save or revert pending settings before starting services.', 'error');
  return true;
}

function setConsolesOpen(open) {
  consoleDrawer.classList.toggle('hidden', !open);
  consoleDrawer.setAttribute('aria-hidden', String(!open));
  consoleButton.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('console-open', open);
}
consoleButton.addEventListener('click', () => setConsolesOpen(consoleDrawer.classList.contains('hidden')));
document.querySelector('#close-consoles').addEventListener('click', () => {
  document.body.classList.remove('console-fullscreen');
  updateButton(document.querySelector('#console-fullscreen'), 'Full screen', 'maximize');
  setConsolesOpen(false);
});
document.querySelector('#console-fullscreen').addEventListener('click', (event) => {
  const fullscreen = document.body.classList.toggle('console-fullscreen');
  updateButton(event.currentTarget, fullscreen ? 'Dock right' : 'Full screen', fullscreen ? 'minimize' : 'maximize');
});
for (const service of ['api', 'expo']) {
  document.querySelector(`#pause-${service}-console`).addEventListener('click', (event) => {
    consolePaused[service] = !consolePaused[service];
    pendingConsoleRecords[service].length = 0;
    updateButton(event.currentTarget, consolePaused[service] ? 'Resume' : 'Pause', consolePaused[service] ? 'play' : 'pause');
    event.currentTarget.setAttribute('aria-pressed', String(consolePaused[service]));
    if (!consolePaused[service]) renderConsole(service);
  });
  document.querySelector(`#clear-${service}-console`).addEventListener('click', () => {
    consoleRecords[service].length = 0;
    pendingConsoleRecords[service].length = 0;
    if (consolePaused[service]) {
      const cleared = document.createElement('p');
      cleared.className = 'log-empty';
      cleared.textContent = 'Console cleared. Resume to continue.';
      document.querySelector(`#${service}-console`).replaceChildren(cleared);
    } else renderConsole(service);
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !consoleDrawer.classList.contains('hidden')) {
    document.body.classList.remove('console-fullscreen');
    updateButton(document.querySelector('#console-fullscreen'), 'Full screen', 'maximize');
    setConsolesOpen(false);
  }
});

const themeToggle = document.querySelector('#theme-toggle');
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  updateButton(themeToggle, theme === 'dark' ? 'Light theme' : 'Dark theme', theme === 'dark' ? 'sun' : 'moon');
  themeToggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  document.querySelector('meta[name="color-scheme"]').content = theme;
}
applyTheme(localStorage.getItem('rn-laravel-api-runner-theme') === 'dark' ? 'dark' : 'light');
themeToggle.addEventListener('click', () => {
  const theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('rn-laravel-api-runner-theme', theme);
  applyTheme(theme);
});

async function initialize() {
  try {
    const value = await apiRequest('/api/state');
    renderState(value);
    connectEvents();
    if (!value.configured) {
      setSettingsMessage('Choose project folders, confirm network, then save settings.');
      settingsDialog.showModal();
    }
  } catch (error) { showBanner(error.message, 'error'); }
}

initialize();
