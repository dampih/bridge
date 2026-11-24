'use strict';

const bridge = window.bridgeDesktop;
const $ = (selector, root = document) => root.querySelector(selector);
const launchForm = $('#launch-form');
const folderOutput = $('#selected-folder');
const folderButton = $('#pick-folder');
const portInput = $('#port');
const nextPortButton = $('#next-port');
const launchButton = $('#start-tunnel');
const launchFeedback = $('#launch-feedback');
const profileList = $('#profile-list');
const profileTemplate = $('#profile-template');
const profilesEmpty = $('#profiles-empty');
const profilesFeedback = $('#profiles-feedback');
const newProfileButton = $('#new-profile');
const profileForm = $('#profile-form');
const profileNameInput = $('#profile-name');
const profileFolderOutput = $('#profile-folder');
const profileFolderButton = $('#pick-profile-folder');
const profilePortInput = $('#profile-port');
const profileTunnelModeInput = $('#profile-tunnel-mode');
const profileNamedFields = $('#profile-named-fields');
const profilePublicUrlInput = $('#profile-public-url');
const profileConnectorTokenInput = $('#profile-connector-token');
const profileConnectorTokenHelp = $('#profile-connector-token-help');
const profileLocalRoute = $('#profile-local-route');
const saveProfileButton = $('#save-profile');
const cancelProfileButton = $('#cancel-profile');
const profileFormFeedback = $('#profile-form-feedback');
const syncFeedback = $('#sync-feedback');
const instanceList = $('#instance-list');
const instanceTemplate = $('#instance-template');
const approvalTemplate = $('#approval-template');
const announcement = $('#announcement');

const statuses = new Map([
  ['starting-server', 'Starting server'],
  ['starting-tunnel', 'Starting tunnel'],
  ['online', 'Online'],
  ['stopping', 'Stopping'],
  ['stopped', 'Stopped'],
  ['failed', 'Failed'],
]);
const modeHelp = {
  review: 'Asks before changes, shell commands, and folder switches.',
  default: 'Asks before deletes, destructive Git operations, sensitive file access, and folder switches.',
  auto: 'Allows recoverable actions such as moving files to the Bridge trash; asks before higher-risk actions.',
  turbo: 'Does not ask for approval on new actions. Server restrictions still apply.'
};
const stoppable = new Set(['starting-server', 'starting-tunnel', 'online']);
const defaultPort = 3101;
const maxPort = 65535;
const maxLogEntries = 80;
const maxLogCharacters = 16000;
const maxRetainedCards = 15;
const cards = new Map();
let nextCardNumber = 0;
let nextApprovalNumber = 0;
let snapshotReceived = false;
let snapshotVersion = 0;
let connected = false;
let selectedFolder = null;
let picking = false;
let starting = false;
let announcingFrame;
let pendingInstanceFocus;
let profilesReady = false;
let editingProfileId;
let profileFolder = null;
let hasSavedConnectorToken = false;
let profilePicking = false;
let profileBusy = false;
let editorReturnFocus;

function safeText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  // Public snapshots must already be scrubbed; also mask common credential forms here.
  return String(value)
    .replace(/\b((?:auth[_-]?token|access[_-]?token|tunnel[_-]?token|connector[_-]?token|token)["']?\s*[:=]\s*["']?)[^\s&#"'<>]+/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)[\w.+=/-]+/gi, '$1[redacted]')
    .replace(/\b[a-f\d]{32,}\b/gi, '[redacted]');
}

function text(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function message(element, value, success = false) {
  text(element, value);
  element.classList.toggle('is-success', success);
  element.hidden = value === '';
}

function errorMessage(error, fallback) {
  const detail = error?.message ?? error;
  return safeText(detail).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim().slice(0, 2000) || fallback;
}

function announce(value) {
  cancelAnimationFrame(announcingFrame);
  text(announcement, '');
  announcingFrame = requestAnimationFrame(() => text(announcement, value));
}

function unavailable(button, value) {
  button.setAttribute('aria-disabled', String(value));
}

function setActionVisibility(button, visible, fallback) {
  if (!visible && button === document.activeElement) fallback.focus({ preventScroll: true });
  button.hidden = !visible;
}

function folderName(folder) {
  const trimmed = folder.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || folder || 'Workspace';
}

function updateLaunchControls() {
  unavailable(folderButton, !connected || picking || profilePicking || starting);
  unavailable(launchButton, !connected || !selectedFolder || picking || starting);
  text(folderButton, picking ? 'Choosing folder…' : selectedFolder ? 'Change folder' : 'Choose folder');
  text(launchButton, starting ? 'Starting…' : 'Start public tunnel');
}

function nextAvailablePort(from, reserved) {
  const used = new Set();
  if (reserved !== undefined) used.add(reserved);
  for (const { instance } of cards.values()) {
    if (stoppable.has(instance.status) || instance.status === 'stopping') used.add(Number(instance.port));
  }
  for (let offset = 0; offset < maxPort; offset++) {
    const candidate = ((from - 1 + offset) % maxPort) + 1;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

function suggestPort(from, reserved) {
  const port = nextAvailablePort(from, reserved);
  if (port === null) {
    message(launchFeedback, 'All local port numbers are in use by Bridge instances. Stop an instance before starting another.');
    return;
  }
  portInput.value = String(port);
  announce(`Local port set to ${port}.`);
}

folderButton.addEventListener('click', async () => {
  if (!connected || picking || profilePicking || starting) return;
  picking = true;
  updateLaunchControls();
  updateProfileControls();
  message(launchFeedback, '');
  try {
    const folder = await bridge.pickFolder();
    if (typeof folder === 'string' && folder) {
      selectedFolder = folder;
      text(folderOutput, safeText(folder));
      announce(`Selected folder: ${safeText(folder)}.`);
    }
  } catch (error) {
    message(launchFeedback, errorMessage(error, 'Could not open the folder picker.'));
  } finally {
    picking = false;
    updateLaunchControls();
    updateProfileControls();
  }
});

nextPortButton.addEventListener('click', () => {
  const value = portInput.valueAsNumber;
  const valid = Number.isInteger(value) && value >= 1 && value <= maxPort;
  message(launchFeedback, '');
  suggestPort(valid ? value % maxPort + 1 : defaultPort);
});

launchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!connected || picking || starting || !selectedFolder || !launchForm.reportValidity()) return;
  const port = portInput.valueAsNumber;
  const folder = selectedFolder;
  starting = true;
  updateLaunchControls();
  message(launchFeedback, '');
  try {
    await bridge.start({ folder, port });
    if (portInput.valueAsNumber === port) suggestPort(port % maxPort + 1, port);
  } catch (error) {
    message(launchFeedback, errorMessage(error, 'Could not start the public tunnel.'));
  } finally {
    starting = false;
    updateLaunchControls();
  }
});

function updateProfileControls() {
  const editorOpen = !profileForm.hidden;
  const manageDisabled = !profilesReady || profileBusy || editorOpen;
  unavailable(newProfileButton, manageDisabled);
  unavailable(profileFolderButton, profileBusy || profilePicking || picking);
  unavailable(saveProfileButton, profileBusy || profilePicking || !profileFolder);
  unavailable(cancelProfileButton, profileBusy || profilePicking);
  for (const button of profileList.querySelectorAll('.edit-profile, .delete-profile')) {
    unavailable(button, manageDisabled);
  }
  for (const button of profileList.querySelectorAll('.start-profile')) {
    unavailable(button, profileBusy);
  }
}

function updateProfileFolder() {
  text(profileFolderOutput, safeText(profileFolder) || 'No folder selected');
  text(profileFolderButton, profilePicking ? 'Choosing folder…' : profileFolder ? 'Change folder' : 'Choose folder');
}

function localRoute(port) {
  return Number.isInteger(port) && port >= 1 && port <= maxPort ? `http://127.0.0.1:${port}` : '';
}

function httpsOrigin(value) {
  const input = value.trim();
  if (!/^https:\/\/[a-z0-9.-]+\/?$/i.test(input)) return '';
  try {
    const url = new URL(input);
    const labels = url.hostname.split('.');
    if (labels.length > 1 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
        !/^\d+(?:\.\d+){3}$/.test(url.hostname)) return url.origin;
  } catch {
    // Invalid URL.
  }
  return '';
}

function updateProfileLocalRoute() {
  text(profileLocalRoute, localRoute(profilePortInput.valueAsNumber) || 'http://127.0.0.1:<local port>');
}

function updateProfileTunnelFields() {
  const named = profileTunnelModeInput.value === 'named';
  profileNamedFields.hidden = !named;
  profilePublicUrlInput.disabled = !named;
  profilePublicUrlInput.required = named;
  profileConnectorTokenInput.disabled = !named;
  if (!named) profileConnectorTokenInput.value = '';
  text(profileConnectorTokenHelp, hasSavedConnectorToken
    ? 'A token is saved. Leave this blank to keep it.'
    : 'Enter the connector token for this named tunnel.');
  updateProfileLocalRoute();
}

function showProfileEditor(profile, trigger) {
  if (!profilesReady || profileBusy || !profileForm.hidden) return;
  editorReturnFocus = trigger;
  editingProfileId = profile?.id;
  profileFolder = profile?.folder ?? null;
  profileNameInput.value = profile?.name ?? '';
  profilePortInput.value = String(profile?.port ?? nextAvailablePort(defaultPort) ?? defaultPort);
  profileTunnelModeInput.value = profile?.tunnelMode === 'named' ? 'named' : 'quick';
  profilePublicUrlInput.value = profile?.tunnelMode === 'named' ? profile.publicUrl ?? '' : '';
  profileConnectorTokenInput.value = '';
  hasSavedConnectorToken = profile?.hasConnectorToken === true;
  updateProfileTunnelFields();
  text($('#profile-form-title'), profile ? 'Edit profile' : 'New profile');
  updateProfileFolder();
  message(profilesFeedback, '');
  message(profileFormFeedback, '');
  profileForm.hidden = false;
  newProfileButton.setAttribute('aria-expanded', 'true');
  updateProfileControls();
  profileNameInput.focus();
}

function closeProfileEditor() {
  profileConnectorTokenInput.value = '';
  profileForm.hidden = true;
  newProfileButton.setAttribute('aria-expanded', 'false');
  const trigger = editorReturnFocus?.isConnected ? editorReturnFocus : newProfileButton;
  editorReturnFocus = undefined;
  updateProfileControls();
  trigger.focus();
}

function renderProfiles(profiles) {
  const list = document.createDocumentFragment();
  profiles.forEach((profile, index) => {
    const root = profileTemplate.content.firstElementChild.cloneNode(true);
    const heading = $('.profile-name', root);
    const start = $('.start-profile', root);
    const edit = $('.edit-profile', root);
    const remove = $('.delete-profile', root);
    const name = safeText(profile.name) || 'Project';
    heading.id = `profile-heading-${index}`;
    text(heading, name);
    text($('.profile-location', root), safeText(profile.folder));
    text($('.profile-port', root), safeText(profile.port));
    const named = profile.tunnelMode === 'named';
    text($('.profile-tunnel-mode', root), named ? 'Named tunnel' : 'Quick tunnel');
    const origin = named && typeof profile.publicUrl === 'string' ? httpsOrigin(profile.publicUrl) : '';
    const originOutput = $('.profile-public-origin', root);
    text(originOutput, origin ? `Public origin: ${origin}` : '');
    originOutput.hidden = !origin;
    for (const [action, button] of [['start', start], ['edit', edit], ['delete', remove]]) {
      button.id = `profile-${action}-${index}`;
      button.setAttribute('aria-labelledby', `${button.id} ${heading.id}`);
    }
    const feedback = $('.profile-feedback', root);
    start.addEventListener('click', () => startSavedProfile(profile.id, start, feedback));
    edit.addEventListener('click', () => showProfileEditor(profile, edit));
    remove.addEventListener('click', () => deleteSavedProfile(profile.id, name, feedback));
    list.append(root);
  });
  profileList.replaceChildren(list);
  profileList.hidden = profiles.length === 0;
  text(profilesEmpty, 'No saved profiles yet.');
  profilesEmpty.hidden = profiles.length > 0;
  updateProfileControls();
}

async function startSavedProfile(id, button, feedback) {
  if (profileBusy) return;
  profileBusy = true;
  updateProfileControls();
  text(button, 'Starting…');
  message(feedback, '');
  try {
    await bridge.startProfile(id);
    message(feedback, 'Tunnel start requested. See Tunnel instances for its status.', true);
  } catch (error) {
    message(feedback, errorMessage(error, 'Could not start the public tunnel.'));
  } finally {
    profileBusy = false;
    text(button, 'Start public tunnel');
    updateProfileControls();
  }
}

async function deleteSavedProfile(id, name, feedback) {
  if (profileBusy || !profileForm.hidden) return;
  if (!window.confirm(`Delete the saved profile “${name}”? Running tunnels will not be stopped.`)) return;
  profileBusy = true;
  updateProfileControls();
  message(feedback, '');
  message(profilesFeedback, '');
  try {
    const profiles = await bridge.deleteProfile(id);
    const restoreFocus = profileList.contains(document.activeElement);
    renderProfiles(profiles);
    if (restoreFocus) newProfileButton.focus();
    message(profilesFeedback, 'Profile deleted.', true);
  } catch (error) {
    message(feedback, errorMessage(error, 'Could not delete the profile.'));
  } finally {
    profileBusy = false;
    updateProfileControls();
  }
}

profileTunnelModeInput.addEventListener('change', () => {
  updateProfileTunnelFields();
  message(profileFormFeedback, '');
});
profilePortInput.addEventListener('input', updateProfileLocalRoute);

newProfileButton.addEventListener('click', () => showProfileEditor(null, newProfileButton));
cancelProfileButton.addEventListener('click', () => {
  if (!profileBusy && !profilePicking) closeProfileEditor();
});

profileFolderButton.addEventListener('click', async () => {
  if (profileBusy || profilePicking || picking) return;
  profilePicking = true;
  updateProfileFolder();
  updateProfileControls();
  updateLaunchControls();
  message(profileFormFeedback, '');
  try {
    const folder = await bridge.pickFolder();
    if (typeof folder === 'string' && folder) {
      profileFolder = folder;
      announce(`Selected folder: ${safeText(folder)}.`);
    }
  } catch (error) {
    message(profileFormFeedback, errorMessage(error, 'Could not open the folder picker.'));
  } finally {
    profilePicking = false;
    updateProfileFolder();
    updateProfileControls();
    updateLaunchControls();
  }
});

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (profileForm.hidden || profileBusy || profilePicking || !profileForm.reportValidity()) return;
  const name = profileNameInput.value.trim();
  if (!name || !profileFolder) {
    message(profileFormFeedback, !name ? 'Enter a profile name.' : 'Choose a workspace folder.');
    (!name ? profileNameInput : profileFolderButton).focus();
    return;
  }
  const tunnelMode = profileTunnelModeInput.value === 'named' ? 'named' : 'quick';
  const data = { name, folder: profileFolder, port: profilePortInput.valueAsNumber, tunnelMode };
  if (tunnelMode === 'named') {
    data.publicUrl = httpsOrigin(profilePublicUrlInput.value);
    if (!data.publicUrl) {
      message(profileFormFeedback, 'Enter an HTTPS public hostname without credentials, a port, path, query, or fragment.');
      profilePublicUrlInput.focus();
      return;
    }
    const connectorToken = profileConnectorTokenInput.value.trim();
    if (!connectorToken && !hasSavedConnectorToken) {
      message(profileFormFeedback, 'Enter the connector token for this named tunnel.');
      profileConnectorTokenInput.focus();
      return;
    }
    if (connectorToken) data.connectorToken = connectorToken;
  }
  profileConnectorTokenInput.value = '';
  if (editingProfileId !== undefined) data.id = editingProfileId;
  profileBusy = true;
  updateProfileControls();
  text(saveProfileButton, 'Saving…');
  message(profileFormFeedback, '');
  try {
    renderProfiles(await bridge.saveProfile(data));
    closeProfileEditor();
    message(profilesFeedback, 'Profile saved.', true);
  } catch (error) {
    message(profileFormFeedback, errorMessage(error, 'Could not save the profile.'));
  } finally {
    profileBusy = false;
    text(saveProfileButton, 'Save profile');
    updateProfileControls();
  }
});

async function loadProfiles() {
  try {
    const profiles = await bridge.listProfiles();
    renderProfiles(profiles);
    profilesReady = true;
    updateProfileControls();
  } catch (error) {
    profilesEmpty.hidden = true;
    message(profilesFeedback, errorMessage(error, 'Could not load saved profiles.'));
  }
}

function renderLogs(card, entries) {
  const logs = Array.isArray(entries) ? entries : [];
  const recent = logs.slice(-maxLogEntries).map((entry) => safeText(entry?.message ?? entry?.text ?? entry));
  const output = recent.join('\n');
  const clipped = logs.length > recent.length || output.length > maxLogCharacters;
  const visible = output.slice(-maxLogCharacters);
  const view = card.logOutput;
  const scrollTop = view.scrollTop;
  const atBottom = view.scrollHeight - view.clientHeight - scrollTop <= 4;
  text(card.logCount, logs.length ? (clipped ? '(trimmed)' : `(${recent.length})`) : '(none yet)');
  text(view, visible ? `${clipped ? 'Some earlier log output is omitted.\n\n' : ''}${visible}` : 'No log output yet.');
  if (view.clientHeight) view.scrollTop = atBottom ? view.scrollHeight : scrollTop;
}

function makeApproval(card, request) {
  const root = approvalTemplate.content.firstElementChild.cloneNode(true);
  const approve = $('.approve-request', root);
  const deny = $('.deny-request', root);
  const entry = {
    root, approve, deny,
    action: $('.approval-action', root),
    detail: $('.approval-detail', root),
    reason: $('.approval-reason', root),
    feedback: $('.approval-feedback', root),
    busy: false,
    answered: false,
  };
  const number = ++nextApprovalNumber;
  entry.action.id = `approval-action-${number}`;
  entry.detail.id = `approval-detail-${number}`;
  entry.reason.id = `approval-reason-${number}`;
  approve.id = `approve-request-${number}`;
  deny.id = `deny-request-${number}`;
  for (const button of [approve, deny]) {
    button.setAttribute('aria-labelledby', `${button.id} ${entry.action.id}`);
  }
  approve.addEventListener('click', () => answerApproval(card, request.id, entry, true));
  deny.addEventListener('click', () => answerApproval(card, request.id, entry, false));
  return entry;
}

function updateApprovalControls(entry) {
  const disabled = entry.busy || entry.answered;
  unavailable(entry.approve, disabled);
  unavailable(entry.deny, disabled);
}

async function answerApproval(card, requestId, entry, approved) {
  if (entry.busy || entry.answered || card.approvals.get(requestId) !== entry) return;
  entry.busy = true;
  updateApprovalControls(entry);
  message(entry.feedback, '');
  try {
    await bridge.answerApproval({ instanceId: card.instance.id, requestId, approved });
    entry.answered = true;
    message(entry.feedback, approved ? 'Approval sent.' : 'Denial sent.', true);
    announce(approved ? 'Request approved.' : 'Request denied.');
  } catch (error) {
    const feedback = card.approvals.get(requestId) === entry ? entry.feedback : card.feedback;
    message(feedback, errorMessage(error, 'Could not answer this request.'));
    announce(feedback.textContent);
  } finally {
    entry.busy = false;
    updateApprovalControls(entry);
  }
}

function renderApprovals(card, requests) {
  const current = new Set();
  for (const request of Array.isArray(requests) ? requests : []) {
    current.add(request.id);
    let entry = card.approvals.get(request.id);
    if (!entry) {
      entry = makeApproval(card, request);
      card.approvals.set(request.id, entry);
      card.approvalList.append(entry.root);
    }
    const action = safeText(request.action) || 'Action requiring approval';
    const detail = safeText(request.detail);
    const reason = safeText(request.reason);
    text(entry.action, action);
    text(entry.detail, detail);
    text(entry.reason, reason ? `Reason: ${reason}` : '');
    entry.detail.hidden = !detail;
    entry.reason.hidden = !reason;
    const description = [detail && entry.detail.id, reason && entry.reason.id].filter(Boolean).join(' ');
    for (const button of [entry.approve, entry.deny]) {
      if (description) button.setAttribute('aria-describedby', description);
      else button.removeAttribute('aria-describedby');
    }
  }
  for (const [id, entry] of card.approvals) {
    if (current.has(id)) continue;
    if (entry.root.contains(document.activeElement)) card.root.focus({ preventScroll: true });
    entry.root.remove();
    card.approvals.delete(id);
  }
  card.approvalSection.hidden = current.size === 0;
}

function makeCard(instance) {
  const root = instanceTemplate.content.firstElementChild.cloneNode(true);
  const card = {
    root, instance,
    name: $('.instance-name', root),
    folder: $('.instance-folder', root),
    status: $('.status-badge', root),
    port: $('.instance-port', root),
    routeRow: $('.instance-route-row', root),
    route: $('.instance-route', root),
    ingress: $('.instance-ingress', root),
    error: $('.instance-error', root),
    actions: $('.instance-actions', root),
    copy: $('.copy-url', root),
    stop: $('.stop-instance', root),
    feedback: $('.instance-feedback', root),
    modeRow: $('.instance-mode', root),
    modeSelect: $('.mode-select', root),
    modeHelp: $('.mode-help', root),
    changingMode: false,
    approvalSection: $('.approval-section', root),
    approvalList: $('.approval-list', root),
    logCount: $('.log-count', root),
    logOutput: $('.log-output', root),
    approvals: new Map(),
    copying: false,
    stopping: false,
  };
  const number = ++nextCardNumber;
  card.name.id = `instance-heading-${number}`;
  card.error.id = `instance-error-${number}`;
  root.setAttribute('aria-labelledby', card.name.id);
  root.setAttribute('aria-describedby', `${card.error.id} instance-status-${number}`);
  card.status.id = `instance-status-${number}`;
  card.modeHelp.id = `mode-help-${number}`;
  card.modeSelect.setAttribute('aria-describedby', card.modeHelp.id);
  card.modeSelect.addEventListener('change', () => setApprovalMode(card));
  card.copy.addEventListener('click', () => copyUrl(card));
  card.stop.addEventListener('click', () => stopInstance(card));
  return card;
}

function statusLabel(instance, state = instance.status) {
  if (state === 'online' && instance.tunnelMode === 'named') return 'Connector ready';
  return statuses.get(state) || 'Unknown';
}

function renderCard(card) {
  const { instance } = card;
  const state = card.stopping && stoppable.has(instance.status) ? 'stopping' : instance.status;
  const folder = safeText(instance.folder);
  const named = instance.tunnelMode === 'named';
  const route = named ? localRoute(instance.port) : '';
  const copyVisible = state === 'online' && Boolean(instance.publicUrl);
  const stopVisible = stoppable.has(state) || state === 'stopping';
  text(card.name, safeText(instance.profileName) || folderName(folder));
  text(card.folder, folder || 'Folder unavailable');
  text(card.port, safeText(instance.port));
  text(card.status, statusLabel(instance, state));
  card.status.dataset.state = named && state === 'online' ? 'connector-ready' : statuses.has(state) ? state : 'unknown';
  text(card.route, route);
  card.routeRow.hidden = !route;
  card.ingress.hidden = !named || state !== 'online';
  message(card.error, safeText(instance.error?.message ?? instance.error));
  setActionVisibility(card.copy, copyVisible, card.root);
  setActionVisibility(card.stop, stopVisible, card.root);
  card.actions.hidden = !copyVisible && !stopVisible;
  unavailable(card.copy, card.copying);
  unavailable(card.stop, state === 'stopping');
  text(card.copy, card.copying ? 'Copying…' : 'Copy MCP URL');
  text(card.stop, state === 'stopping' ? 'Stopping…' : 'Stop tunnel');
  card.modeRow.hidden = state !== 'online';
  card.modeSelect.disabled = card.changingMode;
  card.modeSelect.value = instance.approvalMode;
  text(card.modeHelp, card.changingMode ? 'Waiting for confirmation…' : modeHelp[instance.approvalMode] || '');
  renderApprovals(card, instance.approvals);
  renderLogs(card, instance.logs);
}

async function setApprovalMode(card) {
  if (card.changingMode || card.stopping || card.instance.status !== 'online') return;
  const mode = card.modeSelect.value;
  if (mode === card.instance.approvalMode) return;
  card.changingMode = true;
  message(card.feedback, '');
  renderCard(card);
  try {
    await bridge.setApprovalMode({ instanceId: card.instance.id, mode });
  } catch (error) {
    message(card.feedback, errorMessage(error, 'Could not change approval mode.'));
    announce(card.feedback.textContent);
  } finally {
    card.changingMode = false;
    renderCard(card);
  }
}

async function copyUrl(card) {
  if (card.copying || card.stopping || card.instance.status !== 'online' || !card.instance.publicUrl) return;
  card.copying = true;
  renderCard(card);
  message(card.feedback, '');
  try {
    await bridge.copyUrl(card.instance.id);
    message(card.feedback, 'MCP URL copied to the clipboard.', true);
  } catch (error) {
    // Do not show clipboard errors that could include the authenticated URL.
    message(card.feedback, card.instance.tunnelMode === 'named'
      ? 'Could not copy the MCP URL. Try again when the connector is ready.'
      : 'Could not copy the MCP URL. Try again while the tunnel is online.');
  } finally {
    card.copying = false;
    renderCard(card);
    announce(card.feedback.textContent);
  }
}

async function stopInstance(card) {
  if (card.stopping || !stoppable.has(card.instance.status)) return;
  card.stopping = true;
  renderCard(card);
  message(card.feedback, '');
  announce(`Stopping the tunnel on port ${safeText(card.instance.port)}.`);
  try {
    await bridge.stop(card.instance.id);
  } catch (error) {
    message(card.feedback, errorMessage(error, 'Could not stop this tunnel.'));
    announce(card.feedback.textContent);
  } finally {
    card.stopping = false;
    renderCard(card);
  }
}

function focusInstance(id) {
  pendingInstanceFocus = id;
  const root = cards.get(id)?.root;
  if (!root?.isConnected) return;
  pendingInstanceFocus = undefined;
  root.focus({ preventScroll: true });
  root.scrollIntoView({ block: 'nearest' });
}

function applySnapshot(instances) {
  if (!Array.isArray(instances)) return;
  snapshotVersion++;
  const changes = [];
  const current = new Set();
  for (const instance of instances) {
    current.add(instance.id);
    let card = cards.get(instance.id);
    const prevStatus = card?.instance.status;
    const prevApprovals = card?.approvals.size ?? 0;
    if (!card) {
      card = makeCard(instance);
      cards.set(instance.id, card);
      instanceList.prepend(card.root);
    }
    card.instance = instance;
    renderCard(card);
    if (snapshotReceived && prevStatus !== instance.status) {
      const unverified = instance.tunnelMode === 'named' && instance.status === 'online' ? ' Public ingress has not been verified.' : '';
      changes.push(`Tunnel on port ${safeText(instance.port)}: ${statusLabel(instance)}.${unverified}`);
    }
    if (card.approvals.size > prevApprovals) changes.push(`New approval requests on port ${safeText(instance.port)}.`);
  }
  // Retain the last view if a finished instance drops out of the backend list.
  const retained = [];
  for (const [id, card] of cards) {
    if (current.has(id)) continue;
    retained.push([id, card]);
    const { status } = card.instance;
    if (stoppable.has(status) || status === 'stopping') changes.push(`Tunnel on port ${safeText(card.instance.port)} is no longer active.`);
    if (status === 'failed' || status === 'stopped') continue;
    card.instance = { ...card.instance, status: 'stopped', publicUrl: null, approvals: [] };
    renderCard(card);
  }
  for (const [id, card] of retained.slice(0, Math.max(0, retained.length - maxRetainedCards))) {
    if (card.root.contains(document.activeElement)) continue;
    card.root.remove();
    cards.delete(id);
  }
  snapshotReceived = true;
  message(syncFeedback, '');
  $('#empty-state').hidden = cards.size > 0;
  text($('#empty-title'), 'No tunnels yet');
  $('#empty-description').hidden = false;
  const active = instances.filter(({ status }) => stoppable.has(status) || status === 'stopping').length;
  const count = $('#instance-count');
  text(count, `${active} active / ${cards.size} total`);
  count.hidden = false;
  if (pendingInstanceFocus !== undefined) focusInstance(pendingInstanceFocus);
  if (changes.length) announce(changes.join(' '));
}

async function initialize() {
  if (!bridge) {
    message(syncFeedback, 'This dashboard needs the Bridge desktop app.');
    text($('#empty-title'), 'Tunnel instances unavailable');
    text(profilesEmpty, 'Saved profiles are available in the Bridge desktop app.');
    return;
  }
  void loadProfiles();
  try {
    const version = snapshotVersion;
    const unsubscribe = bridge.onChange(applySnapshot);
    window.addEventListener('pagehide', unsubscribe, { once: true });
    connected = true;
    updateLaunchControls();
    if (bridge.onFocusInstance) {
      const unsubscribeFocus = bridge.onFocusInstance(focusInstance);
      window.addEventListener('pagehide', unsubscribeFocus, { once: true });
    }
    const instances = await bridge.list();
    if (version === snapshotVersion) applySnapshot(instances);
  } catch (error) {
    if (!snapshotReceived) {
      message(syncFeedback, errorMessage(error, 'Could not load tunnel instances.'));
      text($('#empty-title'), 'Tunnel instances unavailable');
    }
  }
}

initialize();
