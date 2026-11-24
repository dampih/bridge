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

function safeText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  // Public snapshots must already be scrubbed; also mask common credential forms here.
  return String(value)
    .replace(/\b((?:auth[_-]?token|access[_-]?token|tunnel[_-]?token|token)["']?\s*[:=]\s*["']?)[^\s&#"'<>]+/gi, '$1[redacted]')
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
  unavailable(folderButton, !connected || picking || starting);
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
  if (!connected || picking || starting) return;
  picking = true;
  updateLaunchControls();
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

function renderCard(card) {
  const { instance } = card;
  const state = card.stopping && stoppable.has(instance.status) ? 'stopping' : instance.status;
  const folder = safeText(instance.folder);
  const copyVisible = state === 'online' && Boolean(instance.publicUrl);
  const stopVisible = stoppable.has(state) || state === 'stopping';
  text(card.name, folderName(folder));
  text(card.folder, folder || 'Folder unavailable');
  text(card.port, safeText(instance.port));
  text(card.status, statuses.get(state) || 'Unknown');
  card.status.dataset.state = statuses.has(state) ? state : 'unknown';
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
    message(card.feedback, 'Could not copy the MCP URL. Try again while the tunnel is online.');
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
      changes.push(`Tunnel on port ${safeText(instance.port)}: ${statuses.get(instance.status) || 'Unknown'}.`);
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
  if (changes.length) announce(changes.join(' '));
}

async function initialize() {
  if (!bridge) {
    message(syncFeedback, 'This dashboard needs the Bridge desktop app.');
    text($('#empty-title'), 'Tunnel instances unavailable');
    return;
  }
  try {
    const version = snapshotVersion;
    const unsubscribe = bridge.onChange(applySnapshot);
    window.addEventListener('pagehide', () => unsubscribe(), { once: true });
    connected = true;
    updateLaunchControls();
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
