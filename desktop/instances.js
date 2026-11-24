'use strict';

const { fork, spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const repo = path.join(__dirname, '..');
const serverScript = path.join(repo, 'secure-folder-mcp', 'server.js');
const activeStatuses = new Set(['starting-server', 'starting-tunnel', 'online', 'stopping']);
const approvalModes = new Set(['review', 'default', 'auto', 'turbo']);
const tunnelUrlPattern = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;

function findCloudflared() {
  const executable = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const directories = [repo, ...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.bridge', 'bin')];
  for (const entry of directories) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, executable);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  throw new Error('cloudflared was not found. Install Cloudflare cloudflared and restart Bridge Desktop.');
}

function serverProcess({ folder, port, token }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['ELECTRON_RUN_AS_NODE', 'BRIDGE_HOST', 'BRIDGE_TOKEN', 'BRIDGE_AUTH_TOKEN'].includes(key.toUpperCase())) delete env[key];
  }
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', BRIDGE_HOST: '127.0.0.1', BRIDGE_TOKEN: token });
  return fork(serverScript, [folder, '--http', String(port), '--approval-mode', 'review'], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });
}

function tunnelProcess(binary, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['TUNNEL_TOKEN', 'TUNNEL_TOKEN_FILE', 'BRIDGE_TOKEN', 'BRIDGE_AUTH_TOKEN'].includes(key.toUpperCase())) delete env[key];
  }
  return spawn(binary, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function trackChild(child) {
  return { child, closed: new Promise(resolve => child.once('close', resolve)) };
}

async function stopChild(tracked, graceful) {
  if (!tracked) return;
  const { child, closed } = tracked;
  if (child.exitCode === null && child.signalCode === null) {
    if (graceful && child.connected) child.send({ type: 'shutdown' }, () => {});
    else child.kill();
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 3500);
  try { await closed; } finally { clearTimeout(timer); }
}

class InstanceManager {
  constructor({ onChange = () => {}, onApproval = () => {}, resolveTunnel = findCloudflared, startTunnel = tunnelProcess } = {}) {
    this.instances = new Map();
    this.onChange = onChange;
    this.onApproval = onApproval;
    this.resolveTunnel = resolveTunnel;
    this.startTunnel = startTunnel;
    this.closing = false;
  }

  list() {
    return [...this.instances.values()].map(({ id, folder, port, status, publicUrl, error, logs, approvals, approvalMode, profileName }) => ({
      id, folder, port, status, publicUrl, error, approvalMode, profileName, logs: [...logs], approvals: [...approvals.values()]
    }));
  }

  emit() { this.onChange(this.list()); }

  redact(instance, value) {
    return String(value ?? '').replaceAll(instance.token, '[REDACTED]')
      .replace(/([?&](?:token|apiKey|auth)=)[^&\s]+/gi, '$1[REDACTED]');
  }

  start({ folder, port, profileName } = {}) {
    if (this.closing) throw new Error('Bridge Desktop is shutting down.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port from 1 to 65535.');
    if ([...this.instances.values()].some(item => item.port === port && activeStatuses.has(item.status))) {
      throw new Error(`Port ${port} is already assigned to a Bridge Desktop instance.`);
    }
    try {
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error();
      folder = fs.realpathSync(folder);
      if (!fs.statSync(folder).isDirectory()) throw new Error();
    } catch {
      throw new Error('Choose an existing project folder.');
    }
    const binary = this.resolveTunnel();
    const instance = {
      id: randomUUID(), token: randomBytes(24).toString('hex'), folder, port, profileName,
      status: 'starting-server', publicUrl: null, error: null, logs: [], approvals: new Map(), approvalMode: 'review'
    };
    for (const [id, item] of this.instances) {
      if (this.instances.size < 25) break;
      if (!activeStatuses.has(item.status)) this.instances.delete(id);
    }
    this.instances.set(instance.id, instance);
    this.emit();
    try {
      instance.server = trackChild(serverProcess(instance));
      const { child } = instance.server;
      this.observe(instance, instance.server, 'MCP server');
      child.on('message', message => this.onServerMessage(instance, binary, message));
      instance.timer = setTimeout(() => this.fail(instance, 'MCP server did not start in time.'), 10000);
    } catch (error) {
      this.fail(instance, error.message);
    }
    return instance.id;
  }

  observe(instance, tracked, label, onLine = () => {}) {
    const { child } = tracked;
    let bindConflict = false;
    for (const stream of [child.stdout, child.stderr]) {
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', line => {
        if (instance.status === 'stopping') return;
        if (label === 'MCP server' && instance.status === 'starting-server' && /EADDRINUSE/.test(line)) bindConflict = true;
        if (line) {
          instance.logs.push(`${label}: ${this.redact(instance, line).slice(0, 600)}`);
          if (instance.logs.length > 40) instance.logs.shift();
          this.emit();
        }
        onLine(line);
      });
    }
    child.on('error', error => this.fail(instance, `${label}: ${error.message}`));
    child.once('close', (code, signal) => this.fail(instance, bindConflict
      ? `Port ${instance.port} is already in use. Choose another port.`
      : `${label} stopped (${signal || code}). See the instance log for details.`));
  }

  onServerMessage(instance, binary, message) {
    if (!message || !activeStatuses.has(instance.status) || instance.status === 'stopping') return;
    if (message.type === 'http-ready' && instance.status === 'starting-server' && message.port === instance.port) {
      clearTimeout(instance.timer);
      instance.status = 'starting-tunnel';
      this.emit();
      try {
        const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${instance.port}`];
        instance.tunnel = trackChild(this.startTunnel(binary, args));
        this.observe(instance, instance.tunnel, 'Tunnel', line => {
          const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0];
          if (instance.status !== 'starting-tunnel' || !url || !tunnelUrlPattern.test(url)) return;
          clearTimeout(instance.timer);
          instance.publicUrl = url;
          instance.status = 'online';
          this.emit();
        });
        instance.timer = setTimeout(() => this.fail(instance, 'Cloudflare did not return a quick tunnel URL in time.'), 45000);
      } catch (error) {
        this.fail(instance, error.message);
      }
    } else if (message.type === 'approval-mode') {
      const pending = instance.modeChange;
      if (!pending || message.requestId !== pending.id || message.mode !== pending.mode) return;
      instance.approvalMode = message.mode;
      pending.finish();
      this.emit();
    } else if (message.type === 'approval-request') {
      const { id, action, detail, reason } = message;
      if (instance.approvals.has(id)) return;
      instance.approvals.set(id, {
        id, action: this.redact(instance, action), detail: this.redact(instance, detail), reason: this.redact(instance, reason)
      });
      this.emit();
      this.onApproval({ instanceId: instance.id, requestId: id, port: instance.port });
    } else if (message.type === 'approval-cancel') {
      instance.approvals.delete(message.id);
      this.emit();
    } else if (message.type === 'project-changed') {
      instance.folder = this.redact(instance, message.path);
      this.emit();
    }
  }

  setApprovalMode({ instanceId, mode } = {}) {
    const instance = this.instances.get(instanceId);
    const child = instance?.server?.child;
    if (!approvalModes.has(mode)) throw new Error('Invalid approval mode.');
    if (instance?.status !== 'online' || !child?.connected) throw new Error('This instance is not online.');
    if (instance.modeChange) throw new Error('An approval mode change is already pending.');
    if (instance.approvalMode === mode) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = error => {
        if (instance.modeChange?.id !== id) return;
        clearTimeout(timer);
        instance.modeChange = null;
        if (error) reject(new Error(error));
        else resolve();
      };
      const failChange = () => {
        if (instance.modeChange?.id !== id) return;
        const error = 'The MCP server did not confirm the approval mode. This instance will stop for safety.';
        finish(error);
        this.fail(instance, error);
      };
      const timer = setTimeout(failChange, 3000);
      instance.modeChange = { id, mode, finish };
      try {
        child.send({ type: 'set-approval-mode', mode, requestId: id }, error => {
          if (error) failChange();
        });
      } catch {
        failChange();
      }
    });
  }

  answerApproval({ instanceId, requestId, approved } = {}) {
    const instance = this.instances.get(instanceId);
    const child = instance?.server?.child;
    if (typeof approved !== 'boolean' || !instance?.approvals.has(requestId) || !child?.connected) {
      throw new Error('This approval is no longer pending.');
    }
    return new Promise((resolve, reject) => {
      instance.approvals.delete(requestId);
      this.emit();
      child.send({ type: 'approval-response', id: requestId, approved }, error => {
        if (error) reject(new Error('Could not send the decision to the MCP server.'));
        else resolve();
      });
    });
  }

  urlForCopy(id) {
    const instance = this.instances.get(id);
    if (instance?.status !== 'online') throw new Error('This instance does not have an active URL.');
    return `${instance.publicUrl}/mcp?token=${instance.token}`;
  }

  fail(instance, message) {
    if (!activeStatuses.has(instance.status) || instance.status === 'stopping') return;
    instance.error = this.redact(instance, message);
    return this.stop(instance.id, 'failed');
  }

  stop(id, finalStatus = 'stopped') {
    const instance = this.instances.get(id);
    if (!instance || !activeStatuses.has(instance.status)) return Promise.resolve();
    if (instance.stopping) return instance.stopping;
    clearTimeout(instance.timer);
    instance.modeChange?.finish('This instance stopped before confirming the approval mode.');
    instance.status = 'stopping';
    instance.publicUrl = null;
    instance.approvals.clear();
    instance.stopping = Promise.all([stopChild(instance.tunnel, false), stopChild(instance.server, true)]).then(() => {
      instance.status = finalStatus;
      this.emit();
    });
    this.emit();
    return instance.stopping;
  }

  shutdown() {
    this.closing = true;
    return Promise.all([...this.instances.keys()].map(id => this.stop(id)));
  }
}

module.exports = { InstanceManager };
