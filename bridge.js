#!/usr/bin/env node

/**
 * =========================================================================
 *  BRIDGE — Universal Local-to-Web AI Coding Harness
 *  LN4 Volt Edition (Fluorescent Volt Green #D2FF00 + Charcoal Grays)
 *  Connects Local Projects to Google Gemini, Claude, ChatGPT & DeepSeek
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

// Lando Norris Signature LN4 Palette (#D2FF00 + Charcoal Grays)
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Volt Green (Lando Norris Signature #D2FF00 - RGB 210, 255, 0)
  volt: '\x1b[38;2;210;255;0m',
  voltBold: '\x1b[1;38;2;210;255;0m',
  bgVolt: '\x1b[48;2;210;255;0m\x1b[38;2;0;0;0m', // High-contrast black on volt green
  bgVoltDark: '\x1b[48;2;28;34;0m',
  
  // Sleek Charcoal & Asphalt Grays
  steel: '\x1b[38;2;65;68;82m',
  slate: '\x1b[38;2;142;146;164m',
  lightSlate: '\x1b[38;2;180;185;200m',
  white: '\x1b[38;2;240;242;248m',
  whiteBold: '\x1b[1;38;2;255;255;255m',
  darkDivider: '\x1b[38;2;44;47;58m',
  
  // Accents
  cyan: '\x1b[38;2;80;200;255m',
  cyanBold: '\x1b[1;38;2;80;200;255m',
  red: '\x1b[38;2;239;68;68m',
  redBold: '\x1b[1;38;2;239;68;68m',

  // Fallback compatibility
  neon: '\x1b[38;2;210;255;0m',
  neonBold: '\x1b[1;38;2;210;255;0m',
  bgNeon: '\x1b[48;2;210;255;0m\x1b[38;2;0;0;0m',
  coral: '\x1b[38;2;210;255;0m',
  coralBold: '\x1b[1;38;2;210;255;0m',
  bgCoral: '\x1b[48;2;210;255;0m\x1b[38;2;0;0;0m',
  bgCyan: '\x1b[48;2;12;35;60m',
  divider: '\x1b[38;2;44;47;58m',
  yellow: '\x1b[38;2;210;255;0m',
  gray: '\x1b[38;2;142;146;164m',
  brightCyan: '\x1b[38;2;80;200;255m',
  brightGreen: '\x1b[38;2;210;255;0m',
  green: '\x1b[38;2;210;255;0m'
};

const scriptDir = __dirname;
const serverScript = path.join(scriptDir, 'secure-folder-mcp', 'server.js');

// Bridge-specific configuration. This intentionally lives under ~/.bridge and
// never reads or writes cloudflared's own ~/.cloudflared files.
const bridgeHomeDir = path.join(os.homedir(), '.bridge');
const bridgeConfigPath = path.join(bridgeHomeDir, 'config.json');

function normalizePublicUrl(value) {
  let url = String(value || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  url = url.replace(/\/mcp$/i, '');
  return url;
}

function isValidPublicUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch (e) {
    return false;
  }
}

function readBridgeConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf8'));
    return {
      tunnelToken: typeof parsed.tunnelToken === 'string' ? parsed.tunnelToken.trim() : '',
      publicUrl: normalizePublicUrl(parsed.publicUrl),
      authToken: typeof parsed.authToken === 'string' && /^[a-f0-9]{32,}$/i.test(parsed.authToken) ? parsed.authToken : '',
      approvalMode: ['turbo', 'review', 'default', 'auto'].includes(parsed.approvalMode) ? parsed.approvalMode : 'default'
    };
  } catch (e) {
    return { tunnelToken: '', publicUrl: '', authToken: '', approvalMode: 'default' };
  }
}

function writeBridgeConfig(config) {
  fs.mkdirSync(bridgeHomeDir, { recursive: true, mode: 0o700 });
  // Merge with what is on disk so saving one field never drops another (e.g. the auth token).
  const existing = readBridgeConfig();
  const merged = { ...existing, ...config };
  const payload = JSON.stringify({
    tunnelToken: String(merged.tunnelToken || '').trim(),
    publicUrl: normalizePublicUrl(merged.publicUrl),
    authToken: String(merged.authToken || ''),
    approvalMode: merged.approvalMode || 'default'
  }, null, 2) + '\n';
  fs.writeFileSync(bridgeConfigPath, payload, { mode: 0o600 });
  try { fs.chmodSync(bridgeConfigPath, 0o600); } catch (e) {}
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    stdout.write(question);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);

    let value = '';
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch (e) {}
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };

    const onData = (chunk) => {
      // Strip bracketed-paste markers and any other terminal escape sequences.
      const text = String(chunk).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
      for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (ch === '\u0003') {
          finish(new Error('Setup cancelled.'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          finish();
          return;
        }
        if (code === 127 || ch === '\b') {
          if (value.length) value = value.slice(0, -1);
          continue;
        }
        if (code < 32) continue;
        value += ch;
      }
    };

    stdin.on('data', onData);
  });
}

async function runSetup() {
  if (!process.stdin.isTTY) {
    console.error('\n  ' + C.redBold + '● [ERROR]' + C.reset + ' `bridge setup` needs an interactive terminal.\n');
    process.exit(1);
  }

  const existing = readBridgeConfig();

  process.stdout.write(`\n  ${C.voltBold}● BRIDGE SETUP${C.reset}\n`);
  process.stdout.write(`  ${C.slate}Creates a fixed MCP URL using a named Cloudflare tunnel.${C.reset}\n`);
  process.stdout.write(`  ${C.slate}In Cloudflare Zero Trust, add a Public Hostname pointing to ${C.cyanBold}http://localhost:3000${C.reset}${C.slate}.${C.reset}\n`);
  process.stdout.write(`  ${C.slate}Bridge stores this token only in ${bridgeConfigPath}${C.reset}\n\n`);

  const tokenInput = await promptHidden(
    existing.tunnelToken
      ? '  Tunnel token (press Enter to keep the saved token): '
      : '  Tunnel token: '
  );
  const tunnelToken = tokenInput || existing.tunnelToken;

  if (!tunnelToken) {
    process.stdout.write(`\n  ${C.redBold}● [CANCELLED]${C.reset} ${C.white}No token was saved.${C.reset}\n\n`);
    return;
  }

  const urlInput = await promptLine(
    existing.publicUrl
      ? `  Public URL (press Enter to keep ${existing.publicUrl}): `
      : '  Public URL (e.g. https://mcp.example.com): '
  );
  const publicUrl = normalizePublicUrl(urlInput || existing.publicUrl);

  if (!isValidPublicUrl(publicUrl)) {
    process.stdout.write(`\n  ${C.redBold}● [ERROR]${C.reset} ${C.white}Public URL must be a valid https:// URL.${C.reset}\n\n`);
    return;
  }

  writeBridgeConfig({ tunnelToken, publicUrl });

  process.stdout.write(`\n  ${C.voltBold}✓ [SAVED]${C.reset} ${C.white}Bridge will use ${C.cyanBold}${publicUrl}/mcp${C.reset}${C.white}.${C.reset}\n`);
  process.stdout.write(`  ${C.slate}Start it with: ${C.white}bridge .${C.reset}\n\n`);
}

function getCloudflaredDownloadUrl() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
  } else if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64';
  } else if (platform === 'linux') {
    return arch === 'arm64'
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  }
  return null;
}

function downloadBinaryWithRedirects(url, destPath) {
  return new Promise((resolve, reject) => {
    function get(currentUrl) {
      https.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download binary: HTTP ${res.statusCode}`));
          return;
        }
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close(() => resolve(destPath));
        });
        fileStream.on('error', reject);
      }).on('error', reject);
    }
    get(url);
  });
}

async function ensureCloudflaredBinary() {
  const exeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  // 1. Local directory check
  const localPath = path.join(scriptDir, exeName);
  if (fs.existsSync(localPath)) return localPath;

  // 2. System PATH check
  try {
    const cmd = process.platform === 'win32' ? 'where.exe cloudflared' : 'which cloudflared';
    const found = execSync(cmd, { stdio: 'pipe' }).toString().trim().split(/\r?\n/)[0].trim();
    if (found && fs.existsSync(found)) return found;
  } catch (e) {}

  // 3. User cache directory (~/.bridge/bin/)
  const userBridgeDir = path.join(os.homedir(), '.bridge', 'bin');
  const cachedPath = path.join(userBridgeDir, exeName);
  if (fs.existsSync(cachedPath)) return cachedPath;

  // 4. Download on-demand (one-time setup for new machines)
  if (!fs.existsSync(userBridgeDir)) {
    fs.mkdirSync(userBridgeDir, { recursive: true });
  }

  const downloadUrl = getCloudflaredDownloadUrl();
  if (!downloadUrl) {
    throw new Error(`Unsupported platform: ${process.platform} (${process.arch})`);
  }

  process.stdout.write(`\n  ${C.voltBold}● [FIRST RUN]${C.reset} ${C.white}Installing Cloudflare tunnel binary for ${process.platform}-${process.arch}...${C.reset}\n`);
  await downloadBinaryWithRedirects(downloadUrl, cachedPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(cachedPath, 0o755);
  }
  process.stdout.write(`  ${C.voltBold}✓ [READY]${C.reset} ${C.white}Tunnel binary installed successfully!${C.reset}\n\n`);
  return cachedPath;
}

// ---- Adaptive layout helpers ----
// Use the real terminal size (no fake minimums: drawing 80 columns into a 60-column window
// makes every line wrap and the whole frame scroll). Frames are drawn one column narrower
// than the window so no terminal auto-wraps at the last column.
const getCols = () => Math.max(20, process.stdout.columns || 100);
const getRows = () => Math.max(8, process.stdout.rows || 30);
const getFrameWidth = () => Math.max(19, getCols() - 1);
// Layout tiers: the big ASCII emblem needs room; small windows get a one-line header.
const isCompact = () => getCols() < 82 || getRows() < 30;

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function visibleWidth(s) {
  return Array.from(stripAnsi(s)).length;
}

// Cut a styled line to `width` visible characters without breaking ANSI codes.
function fitLine(line, width) {
  line = String(line);
  if (visibleWidth(line) <= width) return line;
  let out = '';
  let count = 0;
  const re = /\x1b\[[0-9;?]*[A-Za-z]/y;
  for (let i = 0; i < line.length;) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m) { out += m[0]; i += m[0].length; continue; }
    const cp = line.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (count >= width - 1) { out += '…'; break; }
    out += ch;
    count++;
    i += ch.length;
  }
  return out + C.reset;
}

// Shorten the middle of a plain string (good for paths and URLs): "C:\Users\…\project".
function middleEllipsis(text, max) {
  text = String(text);
  if (max <= 1) return text.slice(0, Math.max(0, max));
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  return text.slice(0, head) + '…' + text.slice(text.length - (keep - head));
}

// Left text + right text on one line; drops the right part when there is no room.
function spreadLine(left, right, width) {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 2) return left + ' '.repeat(gap) + right;
  return left;
}

// Lay out "[K] Label" items over as many lines as the width needs.
function flowItems(items, width, indent = '  ', sep = '   ') {
  const lines = [];
  let current = indent;
  for (const item of items) {
    const candidate = current.trim() ? current + sep + item : current + item;
    if (visibleWidth(candidate) > width && current.trim()) {
      lines.push(current);
      current = indent + item;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

const centerPad = (text, width) => ' '.repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2)));

// Draw a full frame in place: every line clipped to the window, old content cleared per line,
// exactly `rows` lines (no scroll, no flicker from clearing the whole screen first).
function paintFrame(lines) {
  const rows = getRows();
  const width = getFrameWidth();
  const visible = lines.slice(0, rows).map(l => fitLine(l, width) + C.reset + '\x1b[K');
  process.stdout.write('\x1b[H' + visible.join('\n') + '\x1b[J');
}

const UI_WIDTH = 100;
const THIN_BAR = '─'.repeat(UI_WIDTH);
const THICK_BAR = '━'.repeat(UI_WIDTH);
const bar = THIN_BAR;
const thickBar = THICK_BAR;

const isLaunchFromBat = process.argv.includes('--launch');
const cliArgs = process.argv.slice(2);
let requestedPort = null;
let forceQuickTunnel = false;
const positionalArgs = [];
for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i];
  if (arg === '--port') {
    const value = cliArgs[++i];
    if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
      console.error('Invalid --port value. Use a port number from 1 to 65535.');
      process.exit(1);
    }
    requestedPort = Number(value);
  } else if (arg.startsWith('--port=')) {
    const value = arg.slice('--port='.length);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
      console.error('Invalid --port value. Use a port number from 1 to 65535.');
      process.exit(1);
    }
    requestedPort = Number(value);
  } else if (arg === '--quick-tunnel') {
    forceQuickTunnel = true;
  } else if (!arg.startsWith('--')) {
    positionalArgs.push(arg);
  }
}
const rawCliArgs = positionalArgs;
const subcommand = rawCliArgs[0] ? rawCliArgs[0].toLowerCase() : '';
const bridgeConfig = readBridgeConfig();
let activeProjectDir = rawCliArgs[0] && subcommand !== 'setup' ? path.resolve(rawCliArgs[0]) : null;
let mcpTunnelUrl = '';
// Version comes from package.json so the UI always shows the installed release.
const CURRENT_VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; } catch (e) { return '0.0.0'; }
})();
// Numeric semver compare: >0 if a is newer than b. Pre-release tags count as older.
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, '').split('-');
    return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre: !!pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d;
  }
  return (x.pre === y.pre) ? 0 : (x.pre ? -1 : 1);
}
// The auth token is saved in ~/.bridge/config.json so AI connectors keep working across
// restarts. `bridge rotate-token` replaces it (all connected clients must re-paste the URL).
function loadOrCreateAuthToken() {
  const fromEnv = process.env.BRIDGE_TOKEN || process.env.BRIDGE_AUTH_TOKEN;
  if (fromEnv) return fromEnv;
  if (bridgeConfig.authToken) return bridgeConfig.authToken;
  const fresh = crypto.randomBytes(24).toString('hex');
  try { writeBridgeConfig({ authToken: fresh }); } catch (e) {}
  return fresh;
}
const bridgeAuthToken = subcommand === 'setup' || subcommand === 'rotate-token' ? '' : loadOrCreateAuthToken();
const maskToken = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)}` : '');
// Port: named tunnels are configured for localhost:3000 in Cloudflare, quick tunnels can use any free port.
let bridgePort = 3000;
let updateAvailable = null;

function checkForUpdates() {
  try {
    const req = https.get('https://registry.npmjs.org/@markmayandi/bridge/latest', { timeout: 2500 }, (res) => {
      if (res.statusCode === 200) {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.version && compareVersions(data.version, CURRENT_VERSION) > 0) {
              updateAvailable = data.version;
              if (!isNavigatingFolders && !isEstablishingTunnel) renderDashboard();
            }
          } catch (e) {}
        });
      }
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  } catch (e) {}
}

let serverProcess = null;
let tunnelProcess = null;
let showLiveLogs = false;
let flashNotification = '';
let flashTimer = null;
let isNavigatingFolders = false;
let isEstablishingTunnel = false;
const recentLogs = [];

// Approval requests from the MCP server (deletes, sandbox switches). Answered with Y/N.
const approvalQueue = [];
let confirmingExit = false;
let choosingMode = false;

// Approval modes (how often the AI must ask before acting). Harmful commands are blocked in all of them.
const APPROVAL_MODES = [
  { id: 'turbo', key: '1', name: 'TURBO', short: 'never asks', desc: 'Never asks. Writes, commands and deletes run immediately (harmful commands still blocked).' },
  { id: 'review', key: '2', name: 'REVIEW', short: 'asks every change', desc: 'Asks before every change: each write, edit, command, job and delete.' },
  { id: 'default', key: '3', name: 'DEFAULT', short: 'asks for deletes', desc: 'Asks for deletes, destructive git, secret files and new project folders.' },
  { id: 'auto', key: '4', name: 'AUTO', short: 'asks if not undoable', desc: 'Bridge decides by risk: asks only for actions it cannot undo.' }
];
const modeFromFlag = (process.argv.find(a => a.startsWith('--mode=')) || '').split('=')[1];
let approvalMode = APPROVAL_MODES.some(m => m.id === modeFromFlag) ? modeFromFlag : (bridgeConfig.approvalMode || 'default');
const modeInfo = (id) => APPROVAL_MODES.find(m => m.id === id) || APPROVAL_MODES[2];

function setApprovalMode(id) {
  if (!APPROVAL_MODES.some(m => m.id === id)) return;
  approvalMode = id;
  try { writeBridgeConfig({ approvalMode: id }); } catch (e) {}
  try { if (serverProcess && serverProcess.connected) serverProcess.send({ type: 'set-approval-mode', mode: id }); } catch (e) {}
  const m = modeInfo(id);
  const color = id === 'turbo' ? C.redBold : C.voltBold;
  setFlash(`  ${color}● [MODE: ${m.name}]${C.reset} ${C.white}${m.desc}${C.reset}`, 6000);
}
let isShuttingDown = false;
let tunnelAlive = false;

// ---- MCP server supervisor: restart on crash with backoff, show real status ----
let serverStatus = 'starting'; // starting | online | restarting | failed
let serverStartedAt = 0;
let serverRestarts = 0;
let serverRestartTimer = null;

function pushLog(line) {
  recentLogs.push(`${C.slate}[${new Date().toLocaleTimeString()}]${C.reset} ${line}`);
  if (recentLogs.length > 200) recentLogs.shift();
}

function startServerProcess() {
  serverStatus = serverRestarts > 0 ? 'restarting' : 'starting';
  serverStartedAt = Date.now();
  let serverBindFailed = false;
  const child = spawn(process.execPath, [serverScript, activeProjectDir, '--http', String(bridgePort), '--token', bridgeAuthToken, '--approval-mode', approvalMode], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], // ipc channel carries delete/approval prompts
    windowsHide: true
  });
  serverProcess = child;
  child.on('message', handleServerMessage);

  child.stderr.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(l => l.trim());
    lines.forEach(l => {
      if (/listening on/i.test(l)) serverStatus = 'online';
      if (/EADDRINUSE|address already in use/i.test(l)) serverBindFailed = true;
      pushLog(l);
    });
    if (showLiveLogs || /listening on/i.test(chunk.toString())) renderDashboard();
  });
  child.stdout.on('data', () => {});

  child.on('exit', (code, signal) => {
    if (isShuttingDown || serverProcess !== child) return;
    if (serverBindFailed) {
      pushLog(`Port ${bridgePort} became unavailable before the MCP server could bind; stopping this Bridge instance.`);
      setFlash(`  ${C.redBold}● [PORT BUSY]${C.reset} ${C.white}Port ${bridgePort} is already in use. Stop Bridge and choose another with --port.${C.reset}`, 15000);
      cleanupAndExit();
      return;
    }
    // Pending approvals belonged to the dead process; drop them.
    approvalQueue.length = 0;
    // Reset the backoff if the server had been healthy for a minute.
    if (Date.now() - serverStartedAt > 60000) serverRestarts = 0;
    serverRestarts++;
    if (serverRestarts > 6) {
      serverStatus = 'failed';
      pushLog(`MCP server keeps crashing (exit ${code ?? signal}). Restart Bridge; check the logs above.`);
      setFlash(`  ${C.redBold}● [SERVER DOWN]${C.reset} ${C.white}MCP server crashed repeatedly. Press [L] for logs, restart Bridge.${C.reset}`, 15000);
      return;
    }
    const delay = Math.min(10000, 500 * 2 ** (serverRestarts - 1));
    serverStatus = 'restarting';
    pushLog(`MCP server exited (${code ?? signal}); restarting in ${Math.round(delay / 100) / 10}s...`);
    setFlash(`  ${C.redBold}● [SERVER RESTARTING]${C.reset} ${C.white}MCP server stopped unexpectedly. Restarting...${C.reset}`, Math.max(3000, delay));
    serverRestartTimer = setTimeout(() => {
      serverBindFailed = false;
      startServerProcess();
      renderDashboard();
    }, delay);
  });

  child.on('error', (err) => {
    pushLog(`Could not start MCP server: ${err.message}`);
  });
}

function answerApproval(approved) {
  const req = approvalQueue.shift();
  if (!req) return;
  try { serverProcess.send({ type: 'approval-response', id: req.id, approved }); } catch (e) {}
  const verdict = approved ? `${C.voltBold}● [APPROVED]` : `${C.redBold}● [DENIED]`;
  recentLogs.push(`${C.slate}[${new Date().toLocaleTimeString()}]${C.reset} ${approved ? 'APPROVED' : 'DENIED'}: ${req.action} ${req.detail}`);
  if (recentLogs.length > 50) recentLogs.shift();
  setFlash(`  ${verdict}${C.reset} ${C.white}${req.action}: ${req.detail.slice(0, 120)}${C.reset}`, 4000);
}

function handleServerMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'approval-request') {
    approvalQueue.push({
      id: msg.id,
      action: String(msg.action || 'Action'),
      detail: String(msg.detail || ''),
      reason: String(msg.reason || ''),
      receivedAt: Date.now()
    });
    process.stdout.write('\x07'); // terminal bell so the user notices
    if (!isNavigatingFolders && !isEstablishingTunnel) renderDashboard();
  } else if (msg.type === 'approval-mode' && msg.mode) {
    approvalMode = msg.mode;
  } else if (msg.type === 'project-changed' && msg.path) {
    activeProjectDir = String(msg.path);
    setFlash(`  ${C.voltBold}● [SWITCHED]${C.reset} ${C.white}AI switched project folder to: ${C.voltBold}${activeProjectDir}${C.reset}`, 5000);
  } else if (msg.type === 'approval-cancel') {
    const idx = approvalQueue.findIndex(r => r.id === msg.id);
    if (idx !== -1) {
      const [req] = approvalQueue.splice(idx, 1);
      setFlash(`  ${C.redBold}● [TIMED OUT]${C.reset} ${C.white}No answer, denied: ${req.detail.slice(0, 120)}${C.reset}`, 4000);
    }
  }
}

function setFlash(msg, durationMs = 3000) {
  flashNotification = msg;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashNotification = '';
    if (!isNavigatingFolders && !isEstablishingTunnel) renderDashboard();
  }, durationMs);
  if (!isNavigatingFolders && !isEstablishingTunnel) renderDashboard();
}

function copyToClipboard(text) {
  const candidates = process.platform === 'win32' ? [['clip', []]]
    : process.platform === 'darwin' ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [bin, binArgs] of candidates) {
    try {
      execSync(`${bin} ${binArgs.join(' ')}`, { input: text, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      return true;
    } catch (e) {}
  }
  return false;
}

function isPortAvailable(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, process.env.BRIDGE_HOST || '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

async function choosePort(useNamedTunnel, preferredPort = null) {
  if (preferredPort !== null) {
    if (useNamedTunnel && preferredPort !== 3000) return null;
    return await isPortAvailable(preferredPort) ? preferredPort : null;
  }
  if (await isPortAvailable(3000)) return 3000;
  if (useNamedTunnel) return null; // the named tunnel's ingress points at localhost:3000
  for (let p = 3001; p <= 3020; p++) {
    if (await isPortAvailable(p)) return p;
  }
  return null;
}

function switchProjectDirectory(newPath) {
  if (!newPath || !fs.existsSync(newPath)) {
    setFlash(`  ${C.redBold}● [ERROR]${C.reset} ${C.white}Invalid directory path.${C.reset}`);
    return;
  }

  const resolved = fs.realpathSync(path.resolve(newPath));
  activeProjectDir = resolved;

  // Notify running server
  const req = http.request({
    hostname: '127.0.0.1',
    port: bridgePort,
    path: '/api/set-directory',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bridgeAuthToken}`
    }
  }, (res) => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => {
      setFlash(`  ${C.voltBold}● [SWITCHED]${C.reset} ${C.white}Sandboxed project switched to: ${C.voltBold}${path.basename(resolved)}${C.reset}`);
    });
  });

  req.on('error', () => {
    setFlash(`  ${C.voltBold}● [SWITCHED]${C.reset} ${C.white}Project folder switched: ${C.voltBold}${path.basename(resolved)}${C.reset}`);
  });

  req.write(JSON.stringify({ path: resolved }));
  req.end();
}

function renderAsciiHeaderToOut(out, badgeText = '') {
  const barWidth = getFrameWidth();
  const thickBar = '━'.repeat(barWidth);
  const thinBar = '─'.repeat(barWidth);

  // Small window: one-line brand header instead of the 8-line emblem.
  if (isCompact()) {
    out.push(`${C.voltBold}${thickBar}${C.reset}`);
    const brand = `  ${C.voltBold}B R I D G E${C.reset}${badgeText ? '  ' + badgeText : ''}`;
    out.push(spreadLine(brand, `${C.steel}v${CURRENT_VERSION}${C.reset}`, barWidth));
    out.push(`${C.darkDivider}${thinBar}${C.reset}`);
    return;
  }

  const baseLines = [
    `${C.voltBold}██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗${C.reset}    ${C.steel}╔══════╗${C.reset}          ${C.cyan}╔══╗  ╔══╗${C.reset}`,
    `${C.voltBold}██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝${C.reset}    ${C.steel}║ ${C.white}>_ ${C.voltBold}█${C.steel} ║${C.reset}        ${C.cyan}╔═╝  ╚══╝  ╚═╗${C.reset}`,
    `${C.voltBold}██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗  ${C.reset}  ${C.voltBold}╔╩══════╩═╗${C.reset}     ${C.cyan}╔╝   ${C.voltBold}✦${C.cyanBold} LLM${C.cyan}    ╚╗${C.reset}`,
    `${C.voltBold}██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝  ${C.reset}  ${C.voltBold}║    ╚════╬═════╬════╝         ║${C.reset}`,
    `${C.voltBold}██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗${C.reset}  ${C.voltBold}╚╗    ╔═══╩═════╩═══╗         ╔╝${C.reset}`,
    `${C.voltBold}╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝${C.reset}   ${C.voltBold}╚════╝             ╚═════════╝${C.reset}`
  ];

  out.push(`${C.voltBold}${thickBar}${C.reset}`);

  // Cleanly center the iconic Bridge emblem inside the full-width frame
  const emblemWidth = 78;
  const leftPad = ' '.repeat(Math.max(1, Math.floor((barWidth - emblemWidth) / 2)));
  baseLines.forEach(line => out.push(leftPad + line));

  out.push(`${C.voltBold}${thickBar}${C.reset}`);

  if (badgeText) {
    const rightInfo = `${C.steel}v${CURRENT_VERSION} • HIGH-SPEED AI MCP HARNESS${C.reset}`;
    out.push(spreadLine(`  ${badgeText}`, rightInfo, barWidth));
    out.push(`${C.darkDivider}${thinBar}${C.reset}`);
  }
}

function renderAsciiHeader(badgeText = '') {
  const out = [];
  renderAsciiHeaderToOut(out, badgeText);
  console.log(out.map(l => fitLine(l, getFrameWidth())).join('\n'));
}

/**
 * =========================================================================
 *  CENTERED BRIDGE WIREFRAME ANIMATION (Detailed Suspension Cables & Towers)
 *  High-resolution catenary wires, faceted titanium towers & loading bar < 3s!
 * =========================================================================
 */
const BRIDGE_WIRE_ASCII = [
  "                       \u001b[38;2;99;111;143m▄\u001b[0m\u001b[38;2;78;90;90m\u001b[48;2;80;102;82m▀\u001b[0m                   \u001b[38;2;53;97;119m\u001b[48;2;28;99;112m▀\u001b[0m\u001b[38;2;66;91;109m\u001b[48;2;92;112;135m▀\u001b[0m                      ",
  "                     \u001b[38;2;93;105;127m▄\u001b[0m\u001b[38;2;102;116;136m\u001b[48;2;120;139;159m▀\u001b[0m\u001b[38;2;105;121;149m\u001b[48;2;69;84;108m▀\u001b[0m\u001b[38;2;51;81;32m\u001b[48;2;47;80;17m▀\u001b[0m                   \u001b[38;2;0;90;102m\u001b[48;2;1;107;119m▀\u001b[0m\u001b[38;2;81;106;126m\u001b[48;2;38;63;77m▀\u001b[0m\u001b[38;2;109;123;150m\u001b[48;2;119;135;159m▀\u001b[0m\u001b[38;2;97;115;141m▄\u001b[0m                    ",
  "                     \u001b[38;2;102;118;139m\u001b[48;2;97;114;135m▀\u001b[0m\u001b[38;2;122;141;162m\u001b[48;2;93;112;129m▀\u001b[0m\u001b[38;2;33;49;72m\u001b[48;2;18;32;59m▀\u001b[0m\u001b[38;2;65;101;26m\u001b[48;2;87;124;31m▀\u001b[0m                   \u001b[38;2;8;138;151m\u001b[48;2;9;161;173m▀\u001b[0m\u001b[38;2;21;48;61m\u001b[48;2;21;46;60m▀\u001b[0m\u001b[38;2;95;109;129m\u001b[48;2;61;76;93m▀\u001b[0m\u001b[38;2;104;122;146m\u001b[48;2;92;111;136m▀\u001b[0m\u001b[38;2;56;81;117m▄\u001b[0m                   ",
  "                     \u001b[38;2;89;106;128m\u001b[48;2;79;97;120m▀\u001b[0m\u001b[38;2;66;85;98m\u001b[48;2;61;78;91m▀\u001b[0m\u001b[38;2;16;28;62m\u001b[48;2;23;35;67m▀\u001b[0m\u001b[38;2;110;147;35m\u001b[48;2;94;131;37m▀\u001b[0m\u001b[38;2;174;238;0m\u001b[48;2;156;221;0m▀\u001b[0m                 \u001b[38;2;0;210;223m▄\u001b[0m\u001b[38;2;6;180;190m\u001b[48;2;8;169;181m▀\u001b[0m\u001b[38;2;27;42;57m\u001b[48;2;33;40;57m▀\u001b[0m\u001b[38;2;41;58;73m\u001b[48;2;41;58;72m▀\u001b[0m\u001b[38;2;82;102;125m\u001b[48;2;77;97;119m▀\u001b[0m\u001b[38;2;63;92;124m\u001b[48;2;64;91;120m▀\u001b[0m                   ",
  "                    \u001b[38;2;78;94;102m\u001b[48;2;102;135;60m▀\u001b[0m\u001b[38;2;78;97;116m\u001b[48;2;80;100;112m▀\u001b[0m\u001b[38;2;52;67;80m\u001b[48;2;43;55;70m▀\u001b[0m\u001b[38;2;36;49;72m\u001b[48;2;42;57;76m▀\u001b[0m\u001b[38;2;61;94;40m\u001b[48;2;54;76;51m▀\u001b[0m\u001b[38;2;132;202;0m\u001b[48;2;119;190;0m▀\u001b[0m\u001b[38;2;149;205;5m▄\u001b[0m               \u001b[38;2;5;195;206m▄\u001b[0m\u001b[38;2;0;198;210m\u001b[48;2;0;180;192m▀\u001b[0m\u001b[38;2;8;124;142m\u001b[48;2;12;92;111m▀\u001b[0m\u001b[38;2;38;52;69m\u001b[48;2;42;68;85m▀\u001b[0m\u001b[38;2;38;53;67m\u001b[48;2;37;49;62m▀\u001b[0m\u001b[38;2;70;87;108m\u001b[48;2;63;72;91m▀\u001b[0m\u001b[38;2;60;95;120m\u001b[48;2;48;122;142m▀\u001b[0m                   ",
  "                   \u001b[38;2;181;234;0m▄\u001b[0m\u001b[38;2;125;162;48m\u001b[48;2;139;175;51m▀\u001b[0m\u001b[38;2;68;84;108m\u001b[48;2;51;64;103m▀\u001b[0m\u001b[38;2;37;49;58m\u001b[48;2;34;45;48m▀\u001b[0m\u001b[38;2;40;55;78m\u001b[48;2;29;41;77m▀\u001b[0m\u001b[38;2;74;99;47m\u001b[48;2;113;146;39m▀\u001b[0m\u001b[38;2;64;152;0m\u001b[48;2;171;227;0m▀\u001b[0m\u001b[38;2;138;202;3m\u001b[48;2;100;176;2m▀\u001b[0m\u001b[38;2;153;212;3m▄\u001b[0m             \u001b[38;2;0;203;215m▄\u001b[0m\u001b[38;2;1;194;205m\u001b[48;2;1;174;188m▀\u001b[0m\u001b[38;2;0;145;163m\u001b[48;2;0;113;141m▀\u001b[0m\u001b[38;2;16;113;130m\u001b[48;2;9;187;197m▀\u001b[0m\u001b[38;2;44;71;90m\u001b[48;2;43;55;71m▀\u001b[0m\u001b[38;2;33;47;58m\u001b[48;2;29;44;55m▀\u001b[0m\u001b[38;2;57;56;74m\u001b[48;2;49;49;65m▀\u001b[0m\u001b[38;2;49;133;152m\u001b[48;2;54;124;143m▀\u001b[0m\u001b[38;2;0;212;224m\u001b[48;2;1;216;227m▀\u001b[0m                  ",
  "                  \u001b[38;2;167;207;3m▄\u001b[0m\u001b[38;2;170;222;0m\u001b[48;2;148;202;0m▀\u001b[0m\u001b[38;2;100;134;63m\u001b[48;2;53;76;85m▀\u001b[0m\u001b[38;2;52;61;95m\u001b[48;2;56;67;86m▀\u001b[0m\u001b[38;2;26;35;40m\u001b[48;2;20;28;35m▀\u001b[0m\u001b[38;2;34;45;75m\u001b[48;2;40;52;71m▀\u001b[0m\u001b[38;2;78;109;36m\u001b[48;2;49;75;41m▀\u001b[0m\u001b[38;2;175;231;0m\u001b[48;2;118;187;0m▀\u001b[0m\u001b[38;2;19;81;9m\u001b[48;2;178;228;5m▀\u001b[0m\u001b[38;2;138;204;4m\u001b[48;2;39;113;2m▀\u001b[0m\u001b[38;2;150;204;3m\u001b[48;2;147;215;3m▀\u001b[0m           \u001b[38;2;1;201;210m▄\u001b[0m\u001b[38;2;1;194;204m\u001b[48;2;1;132;148m▀\u001b[0m\u001b[38;2;3;78;103m\u001b[48;2;2;204;214m▀\u001b[0m\u001b[38;2;0;224;233m\u001b[48;2;0;185;198m▀\u001b[0m\u001b[38;2;8;157;173m\u001b[48;2;10;86;107m▀\u001b[0m\u001b[38;2;41;48;64m\u001b[48;2;38;61;76m▀\u001b[0m\u001b[38;2;27;40;51m\u001b[48;2;25;35;45m▀\u001b[0m\u001b[38;2;39;47;62m\u001b[48;2;32;42;55m▀\u001b[0m\u001b[38;2;57;79;101m\u001b[48;2;58;64;86m▀\u001b[0m\u001b[38;2;5;190;203m\u001b[48;2;10;145;162m▀\u001b[0m\u001b[38;2;0;217;227m▄\u001b[0m                 ",
  "                 \u001b[38;2;170;211;4m▄\u001b[0m\u001b[38;2;166;215;2m\u001b[48;2;150;205;0m▀\u001b[0m\u001b[38;2;104;160;8m\u001b[48;2;38;77;42m▀\u001b[0m\u001b[38;2;56;71;98m\u001b[48;2;69;88;90m▀\u001b[0m\u001b[38;2;48;61;76m\u001b[48;2;37;48;67m▀\u001b[0m\u001b[38;2;17;25;32m\u001b[48;2;15;23;30m▀\u001b[0m\u001b[38;2;35;46;66m\u001b[48;2;32;42;61m▀\u001b[0m\u001b[38;2;66;90;37m\u001b[48;2;59;86;33m▀\u001b[0m \u001b[38;2;135;199;4m▀\u001b[0m\u001b[38;2;171;220;3m\u001b[48;2;143;207;3m▀\u001b[0m\u001b[38;2;69;143;3m\u001b[48;2;159;216;3m▀\u001b[0m\u001b[38;2;144;219;5m\u001b[48;2;75;157;3m▀\u001b[0m\u001b[38;2;126;217;12m▄\u001b[0m       \u001b[38;2;6;203;206m▄\u001b[0m\u001b[38;2;1;206;213m\u001b[48;2;2;153;162m▀\u001b[0m\u001b[38;2;1;151;162m\u001b[48;2;0;182;192m▀\u001b[0m\u001b[38;2;0;183;193m\u001b[48;2;1;204;214m▀\u001b[0m\u001b[38;2;1;201;214m\u001b[48;2;0;88;108m▀\u001b[0m \u001b[38;2;10;116;136m\u001b[48;2;9;110;129m▀\u001b[0m\u001b[38;2;34;55;71m\u001b[48;2;31;50;64m▀\u001b[0m\u001b[38;2;23;31;43m\u001b[48;2;21;29;41m▀\u001b[0m\u001b[38;2;26;35;46m\u001b[48;2;21;29;39m▀\u001b[0m\u001b[38;2;56;75;96m\u001b[48;2;54;74;94m▀\u001b[0m\u001b[38;2;30;70;93m\u001b[48;2;43;72;96m▀\u001b[0m\u001b[38;2;0;208;221m\u001b[48;2;0;182;202m▀\u001b[0m\u001b[38;2;6;186;199m\u001b[48;2;1;204;217m▀\u001b[0m                ",
  "                \u001b[38;2;172;215;2m▄\u001b[0m\u001b[38;2;162;211;4m\u001b[48;2;110;168;3m▀\u001b[0m\u001b[38;2;78;148;0m\u001b[48;2;180;229;0m▀\u001b[0m\u001b[38;2;148;184;25m\u001b[48;2;123;161;36m▀\u001b[0m\u001b[38;2;60;77;89m\u001b[48;2;42;55;90m▀\u001b[0m\u001b[38;2;33;43;58m\u001b[48;2;31;41;50m▀\u001b[0m\u001b[38;2;15;23;30m\u001b[48;2;14;23;29m▀\u001b[0m\u001b[38;2;28;38;56m\u001b[48;2;25;35;52m▀\u001b[0m\u001b[38;2;57;85;32m\u001b[48;2;56;82;29m▀\u001b[0m   \u001b[38;2;137;205;3m▀\u001b[0m\u001b[38;2;151;219;2m\u001b[48;2;107;182;2m▀\u001b[0m\u001b[38;2;81;162;9m\u001b[48;2;129;210;5m▀\u001b[0m\u001b[38;2;96;206;40m\u001b[48;2;88;180;22m▀\u001b[0m\u001b[38;2;91;219;71m\u001b[48;2;70;187;60m▀\u001b[0m\u001b[38;2;61;194;88m▄\u001b[0m\u001b[38;2;56;192;124m▄\u001b[0m\u001b[38;2;43;199;174m▄\u001b[0m\u001b[38;2;23;183;167m▄\u001b[0m\u001b[38;2;19;190;186m\u001b[48;2;6;168;168m▀\u001b[0m\u001b[38;2;5;156;162m\u001b[48;2;1;191;197m▀\u001b[0m\u001b[38;2;1;191;200m\u001b[48;2;1;170;180m▀\u001b[0m\u001b[38;2;1;194;205m▀\u001b[0m\u001b[38;2;0;79;100m▀\u001b[0m  \u001b[38;2;8;106;126m\u001b[48;2;6;104;124m▀\u001b[0m\u001b[38;2;27;47;59m\u001b[48;2;24;42;54m▀\u001b[0m\u001b[38;2;20;29;40m\u001b[48;2;20;29;39m▀\u001b[0m\u001b[38;2;17;27;37m\u001b[48;2;14;23;32m▀\u001b[0m\u001b[38;2;51;51;70m\u001b[48;2;47;54;72m▀\u001b[0m\u001b[38;2;32;135;151m\u001b[48;2;37;89;107m▀\u001b[0m\u001b[38;2;0;183;210m\u001b[48;2;2;210;220m▀\u001b[0m\u001b[38;2;1;189;204m\u001b[48;2;0;120;150m▀\u001b[0m\u001b[38;2;0;201;215m\u001b[48;2;1;204;218m▀\u001b[0m               ",
  "              \u001b[38;2;180;209;5m▄\u001b[0m\u001b[38;2;176;211;3m\u001b[48;2;156;198;4m▀\u001b[0m\u001b[38;2;142;191;4m\u001b[48;2;119;161;2m▀\u001b[0m\u001b[38;2;141;180;5m\u001b[48;2;165;204;4m▀\u001b[0m\u001b[38;2;162;213;0m▀\u001b[0m\u001b[38;2;30;54;74m\u001b[48;2;45;56;84m▀\u001b[0m\u001b[38;2;55;69;87m\u001b[48;2;51;67;81m▀\u001b[0m\u001b[38;2;24;34;44m\u001b[48;2;20;30;40m▀\u001b[0m\u001b[38;2;14;23;30m\u001b[48;2;15;24;31m▀\u001b[0m\u001b[38;2;22;32;48m\u001b[48;2;20;29;45m▀\u001b[0m\u001b[38;2;53;80;28m\u001b[48;2;50;77;27m▀\u001b[0m   \u001b[38;2;146;207;4m▄\u001b[0m\u001b[38;2;138;215;21m▄\u001b[0m\u001b[38;2;5;65;0m\u001b[48;2;121;211;37m▀\u001b[0m\u001b[38;2;86;172;19m\u001b[48;2;90;185;53m▀\u001b[0m\u001b[38;2;80;176;53m\u001b[48;2;77;180;67m▀\u001b[0m\u001b[38;2;74;218;110m\u001b[48;2;49;143;71m▀\u001b[0m\u001b[38;2;55;213;140m\u001b[48;2;4;62;25m▀\u001b[0m\u001b[38;2;40;210;170m\u001b[48;2;11;99;67m▀\u001b[0m\u001b[38;2;18;183;169m\u001b[48;2;21;157;144m▀\u001b[0m\u001b[38;2;3;160;161m\u001b[48;2;10;170;168m▀\u001b[0m\u001b[38;2;0;76;85m\u001b[48;2;3;196;201m▀\u001b[0m\u001b[38;2;4;207;214m▄\u001b[0m\u001b[38;2;0;204;213m▄\u001b[0m   \u001b[38;2;6;107;126m\u001b[48;2;6;97;119m▀\u001b[0m\u001b[38;2;21;38;50m\u001b[48;2;18;36;48m▀\u001b[0m\u001b[38;2;18;27;38m\u001b[48;2;17;26;37m▀\u001b[0m\u001b[38;2;12;20;29m\u001b[48;2;11;20;29m▀\u001b[0m\u001b[38;2;43;60;75m\u001b[48;2;39;51;67m▀\u001b[0m\u001b[38;2;45;44;63m\u001b[48;2;42;61;80m▀\u001b[0m\u001b[38;2;5;154;174m▀\u001b[0m\u001b[38;2;0;205;219m\u001b[48;2;0;190;206m▀\u001b[0m\u001b[38;2;2;152;176m\u001b[48;2;1;186;203m▀\u001b[0m\u001b[38;2;1;207;218m\u001b[48;2;0;172;193m▀\u001b[0m\u001b[38;2;1;203;216m▄\u001b[0m             ",
  "            \u001b[38;2;176;206;3m▄\u001b[0m\u001b[38;2;178;208;3m\u001b[48;2;154;193;3m▀\u001b[0m\u001b[38;2;160;198;3m\u001b[48;2;132;168;3m▀\u001b[0m\u001b[38;2;122;166;2m\u001b[48;2;158;193;4m▀\u001b[0m\u001b[38;2;169;204;2m\u001b[48;2;122;164;4m▀\u001b[0m\u001b[38;2;68;112;0m\u001b[48;2;169;219;0m▀\u001b[0m\u001b[38;2;148;202;11m▄\u001b[0m\u001b[38;2;49;64;72m\u001b[48;2;53;68;67m▀\u001b[0m\u001b[38;2;45;59;77m\u001b[48;2;40;52;72m▀\u001b[0m\u001b[38;2;18;28;37m\u001b[48;2;17;27;35m▀\u001b[0m\u001b[38;2;16;27;32m\u001b[48;2;17;28;34m▀\u001b[0m\u001b[38;2;12;20;44m\u001b[48;2;10;18;44m▀\u001b[0m\u001b[38;2;76;101;25m\u001b[48;2;79;106;26m▀\u001b[0m\u001b[38;2;168;216;1m\u001b[48;2;154;218;1m▀\u001b[0m\u001b[38;2;140;194;3m\u001b[48;2;141;210;3m▀\u001b[0m\u001b[38;2;129;190;3m\u001b[48;2;138;212;2m▀\u001b[0m\u001b[38;2;115;182;5m\u001b[48;2;128;210;3m▀\u001b[0m\u001b[38;2;99;178;12m\u001b[48;2;117;209;8m▀\u001b[0m\u001b[38;2;83;171;21m\u001b[48;2;107;218;25m▀\u001b[0m\u001b[38;2;69;171;39m\u001b[48;2;90;216;50m▀\u001b[0m\u001b[38;2;47;169;63m\u001b[48;2;68;217;81m▀\u001b[0m\u001b[38;2;39;191;98m\u001b[48;2;46;209;104m▀\u001b[0m\u001b[38;2;30;227;156m\u001b[48;2;25;205;135m▀\u001b[0m\u001b[38;2;10;212;175m\u001b[48;2;11;206;168m▀\u001b[0m\u001b[38;2;0;180;167m\u001b[48;2;2;213;198m▀\u001b[0m\u001b[38;2;1;165;168m\u001b[48;2;1;216;219m▀\u001b[0m\u001b[38;2;2;159;165m\u001b[48;2;0;214;221m▀\u001b[0m\u001b[38;2;2;162;172m\u001b[48;2;1;208;215m▀\u001b[0m\u001b[38;2;2;171;184m\u001b[48;2;1;200;209m▀\u001b[0m\u001b[38;2;1;176;190m\u001b[48;2;1;204;215m▀\u001b[0m\u001b[38;2;1;181;195m\u001b[48;2;1;202;215m▀\u001b[0m\u001b[38;2;1;204;215m\u001b[48;2;1;205;221m▀\u001b[0m\u001b[38;2;4;148;163m\u001b[48;2;5;153;170m▀\u001b[0m\u001b[38;2;17;25;36m\u001b[48;2;19;25;36m▀\u001b[0m\u001b[38;2;16;28;38m\u001b[48;2;17;29;39m▀\u001b[0m\u001b[38;2;11;20;29m\u001b[48;2;12;22;31m▀\u001b[0m\u001b[38;2;35;48;62m\u001b[48;2;32;47;61m▀\u001b[0m\u001b[38;2;45;61;79m\u001b[48;2;44;48;64m▀\u001b[0m\u001b[38;2;44;62;83m\u001b[48;2;20;134;148m▀\u001b[0m\u001b[38;2;0;221;230m▄\u001b[0m\u001b[38;2;2;183;198m\u001b[48;2;5;171;185m▀\u001b[0m\u001b[38;2;1;175;196m\u001b[48;2;2;181;199m▀\u001b[0m\u001b[38;2;1;178;198m\u001b[48;2;0;172;191m▀\u001b[0m\u001b[38;2;1;202;215m\u001b[48;2;1;175;194m▀\u001b[0m\u001b[38;2;2;199;214m▄\u001b[0m           ",
  "         \u001b[38;2;129;192;0m▄\u001b[0m\u001b[38;2;143;196;2m▄\u001b[0m\u001b[38;2;172;209;2m\u001b[48;2;147;194;3m▀\u001b[0m\u001b[38;2;145;184;3m\u001b[48;2;114;158;3m▀\u001b[0m\u001b[38;2;132;167;2m\u001b[48;2;118;160;2m▀\u001b[0m\u001b[38;2;158;189;7m\u001b[48;2;107;148;1m▀\u001b[0m\u001b[38;2;130;179;4m\u001b[48;2;116;163;1m▀\u001b[0m\u001b[38;2;140;192;2m\u001b[48;2;119;165;3m▀\u001b[0m\u001b[38;2;155;218;0m\u001b[48;2;127;174;0m▀\u001b[0m\u001b[38;2;124;178;16m\u001b[48;2;74;102;42m▀\u001b[0m\u001b[38;2;41;52;70m\u001b[48;2;42;53;72m▀\u001b[0m\u001b[38;2;40;52;66m\u001b[48;2;35;47;61m▀\u001b[0m\u001b[38;2;15;26;35m\u001b[48;2;15;26;35m▀\u001b[0m\u001b[38;2;19;30;37m\u001b[48;2;19;31;39m▀\u001b[0m\u001b[38;2;13;22;46m\u001b[48;2;23;33;49m▀\u001b[0m\u001b[38;2;74;101;27m\u001b[48;2;43;72;34m▀\u001b[0m\u001b[38;2;156;211;0m▀\u001b[0m\u001b[38;2;133;195;3m▀\u001b[0m\u001b[38;2;121;185;2m▀\u001b[0m\u001b[38;2;99;166;3m▀\u001b[0m\u001b[38;2;62;140;5m▀\u001b[0m          \u001b[38;2;0;136;159m▀\u001b[0m\u001b[38;2;0;160;177m▀\u001b[0m\u001b[38;2;2;175;190m▀\u001b[0m\u001b[38;2;0;195;208m▀\u001b[0m\u001b[38;2;6;145;161m\u001b[48;2;10;78;98m▀\u001b[0m\u001b[38;2;22;31;42m\u001b[48;2;25;45;56m▀\u001b[0m\u001b[38;2;18;30;40m\u001b[48;2;20;31;41m▀\u001b[0m\u001b[38;2;13;24;33m\u001b[48;2;16;27;37m▀\u001b[0m\u001b[38;2;28;43;56m\u001b[48;2;26;39;51m▀\u001b[0m\u001b[38;2;43;45;61m\u001b[48;2;42;52;69m▀\u001b[0m\u001b[38;2;25;107;123m\u001b[48;2;32;68;86m▀\u001b[0m\u001b[38;2;1;205;224m\u001b[48;2;0;175;189m▀\u001b[0m\u001b[38;2;3;189;204m\u001b[48;2;1;165;183m▀\u001b[0m\u001b[38;2;1;157;175m\u001b[48;2;2;164;180m▀\u001b[0m\u001b[38;2;3;181;196m\u001b[48;2;2;149;170m▀\u001b[0m\u001b[38;2;1;169;186m\u001b[48;2;2;162;182m▀\u001b[0m\u001b[38;2;1;172;192m\u001b[48;2;2;149;173m▀\u001b[0m\u001b[38;2;1;196;212m\u001b[48;2;2;179;200m▀\u001b[0m\u001b[38;2;2;195;210m▄\u001b[0m\u001b[38;2;0;210;220m▄\u001b[0m        ",
  "    \u001b[38;2;34;113;22m▄\u001b[0m\u001b[38;2;46;123;33m▄\u001b[0m\u001b[38;2;55;134;38m▄\u001b[0m\u001b[38;2;79;161;27m\u001b[48;2;64;140;32m▀\u001b[0m\u001b[38;2;88;156;15m\u001b[48;2;57;115;21m▀\u001b[0m\u001b[38;2;103;160;5m▀\u001b[0m\u001b[38;2;90;143;2m▀\u001b[0m\u001b[38;2;79;122;1m▀\u001b[0m\u001b[38;2;92;132;0m▀\u001b[0m     \u001b[38;2;26;34;69m\u001b[48;2;36;47;59m▀\u001b[0m\u001b[38;2;44;56;72m\u001b[48;2;42;54;69m▀\u001b[0m\u001b[38;2;34;48;61m\u001b[48;2;29;39;53m▀\u001b[0m\u001b[38;2;16;27;36m\u001b[48;2;20;31;41m▀\u001b[0m\u001b[38;2;21;33;42m\u001b[48;2;23;35;43m▀\u001b[0m\u001b[38;2;24;35;52m\u001b[48;2;28;39;56m▀\u001b[0m\u001b[38;2;44;75;36m\u001b[48;2;42;73;38m▀\u001b[0m                   \u001b[38;2;11;92;111m\u001b[48;2;13;86;107m▀\u001b[0m\u001b[38;2;27;46;58m\u001b[48;2;30;48;62m▀\u001b[0m\u001b[38;2;23;34;44m\u001b[48;2;25;38;47m▀\u001b[0m\u001b[38;2;18;30;40m\u001b[48;2;23;35;44m▀\u001b[0m\u001b[38;2;26;38;50m\u001b[48;2;25;34;47m▀\u001b[0m\u001b[38;2;42;56;73m\u001b[48;2;37;48;63m▀\u001b[0m\u001b[38;2;33;43;61m\u001b[48;2;35;49;65m▀\u001b[0m\u001b[38;2;25;55;75m▄\u001b[0m   \u001b[38;2;0;131;154m▀\u001b[0m\u001b[38;2;2;141;161m▀\u001b[0m\u001b[38;2;1;125;147m▀\u001b[0m\u001b[38;2;2;141;163m▀\u001b[0m\u001b[38;2;2;159;176m\u001b[48;2;0;63;86m▀\u001b[0m\u001b[38;2;5;163;179m\u001b[48;2;5;124;144m▀\u001b[0m\u001b[38;2;34;171;191m\u001b[48;2;25;138;157m▀\u001b[0m\u001b[38;2;25;127;147m▄\u001b[0m\u001b[38;2;6;117;137m▄\u001b[0m    ",
  " \u001b[38;2;4;30;0m▄\u001b[0m\u001b[38;2;12;60;4m\u001b[48;2;5;45;0m▀\u001b[0m\u001b[38;2;19;75;7m▀\u001b[0m\u001b[38;2;24;85;17m▀\u001b[0m\u001b[38;2;34;93;25m▀\u001b[0m            \u001b[38;2;34;45;61m\u001b[48;2;33;44;59m▀\u001b[0m\u001b[38;2;35;47;60m\u001b[48;2;21;28;38m▀\u001b[0m\u001b[38;2;5;6;12m\u001b[48;2;0;2;5m▀\u001b[0m\u001b[38;2;22;31;42m\u001b[48;2;10;14;21m▀\u001b[0m\u001b[38;2;25;38;48m\u001b[48;2;29;40;52m▀\u001b[0m\u001b[38;2;30;40;59m\u001b[48;2;33;43;62m▀\u001b[0m\u001b[38;2;38;73;42m\u001b[48;2;40;75;44m▀\u001b[0m                   \u001b[38;2;14;85;106m\u001b[48;2;15;80;102m▀\u001b[0m\u001b[38;2;33;51;66m\u001b[48;2;35;52;69m▀\u001b[0m\u001b[38;2;27;39;50m\u001b[48;2;32;45;58m▀\u001b[0m\u001b[38;2;28;40;52m\u001b[48;2;18;26;36m▀\u001b[0m\u001b[38;2;7;9;17m\u001b[48;2;0;2;6m▀\u001b[0m\u001b[38;2;19;25;35m\u001b[48;2;7;12;18m▀\u001b[0m\u001b[38;2;39;52;69m\u001b[48;2;33;46;61m▀\u001b[0m\u001b[38;2;24;37;55m\u001b[48;2;25;38;53m▀\u001b[0m          \u001b[38;2;5;79;102m▀\u001b[0m\u001b[38;2;2;89;109m▀\u001b[0m\u001b[38;2;2;81;102m▀\u001b[0m\u001b[38;2;0;72;91m\u001b[48;2;0;58;74m▀\u001b[0m\u001b[38;2;0;44;62m▄\u001b[0m\u001b[38;2;0;17;40m▄\u001b[0m",
  "                 \u001b[38;2;19;34;44m\u001b[48;2;26;38;49m▀\u001b[0m\u001b[38;2;30;40;53m\u001b[48;2;22;30;41m▀\u001b[0m\u001b[38;2;8;13;19m\u001b[48;2;5;10;16m▀\u001b[0m\u001b[38;2;5;10;15m\u001b[48;2;8;15;22m▀\u001b[0m\u001b[38;2;3;7;11m\u001b[48;2;8;15;21m▀\u001b[0m\u001b[38;2;19;27;36m\u001b[48;2;5;11;15m▀\u001b[0m\u001b[38;2;38;49;68m\u001b[48;2;33;42;59m▀\u001b[0m\u001b[38;2;37;73;44m\u001b[48;2;38;75;50m▀\u001b[0m                   \u001b[38;2;16;77;97m\u001b[48;2;20;77;97m▀\u001b[0m\u001b[38;2;40;57;74m\u001b[48;2;43;60;78m▀\u001b[0m\u001b[38;2;30;40;54m\u001b[48;2;12;18;26m▀\u001b[0m\u001b[38;2;4;9;14m\u001b[48;2;5;10;16m▀\u001b[0m\u001b[38;2;6;11;17m\u001b[48;2;9;16;22m▀\u001b[0m\u001b[38;2;3;7;12m\u001b[48;2;6;13;18m▀\u001b[0m\u001b[38;2;22;32;43m\u001b[48;2;12;19;27m▀\u001b[0m\u001b[38;2;27;40;54m\u001b[48;2;23;34;47m▀\u001b[0m                ",
  "                 \u001b[38;2;22;32;42m\u001b[48;2;12;21;30m▀\u001b[0m\u001b[38;2;13;21;29m\u001b[48;2;10;19;27m▀\u001b[0m\u001b[38;2;8;16;23m\u001b[48;2;12;22;30m▀\u001b[0m\u001b[38;2;12;21;28m\u001b[48;2;14;23;32m▀\u001b[0m\u001b[38;2;12;21;28m\u001b[48;2;13;23;31m▀\u001b[0m\u001b[38;2;7;15;20m\u001b[48;2;12;21;28m▀\u001b[0m\u001b[38;2;15;19;32m\u001b[48;2;7;11;21m▀\u001b[0m\u001b[38;2;36;72;52m\u001b[48;2;17;42;28m▀\u001b[0m                   \u001b[38;2;25;83;105m\u001b[48;2;15;57;73m▀\u001b[0m\u001b[38;2;27;41;54m\u001b[48;2;9;18;26m▀\u001b[0m\u001b[38;2;5;10;15m\u001b[48;2;9;16;23m▀\u001b[0m\u001b[38;2;11;19;26m\u001b[48;2;12;21;29m▀\u001b[0m\u001b[38;2;11;20;27m\u001b[48;2;13;23;31m▀\u001b[0m\u001b[38;2;11;20;27m\u001b[48;2;13;22;30m▀\u001b[0m\u001b[38;2;9;16;22m\u001b[48;2;10;18;25m▀\u001b[0m\u001b[38;2;17;25;35m\u001b[48;2;10;18;26m▀\u001b[0m                "
];

async function playInitialLoadingAnimation(durationMs = 2200) {
  // Enter alternate buffer and hide cursor - NO frames ever enter scrollback!
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  const startTime = Date.now();
  const logoWidth = 68;

  while (true) {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(1.0, elapsed / durationMs);

    const cols = getFrameWidth();
    const rows = getRows();
    const thickBar = '━'.repeat(cols);
    const thinBar = '─'.repeat(cols);
    // The bridge artwork is 68x16; only draw it when it fits with the text around it.
    const showArt = cols >= logoWidth + 2 && rows >= BRIDGE_WIRE_ASCII.length + 12;

    const out = [];
    out.push(`${C.voltBold}${thickBar}${C.reset}`);
    const topHeader = `  ${C.voltBold}${cols >= 60 ? 'BRIDGE // UNIVERSAL LOCAL-TO-WEB AI HARNESS' : 'BRIDGE'}${C.reset}`;
    out.push(spreadLine(topHeader, `${C.steel}v${CURRENT_VERSION}  ${C.reset}`, cols));
    out.push(`${C.darkDivider}${thinBar}${C.reset}`);

    const body = [];
    if (showArt) {
      const padLeft = ' '.repeat(Math.max(0, Math.floor((cols - logoWidth) / 2)));
      for (const line of BRIDGE_WIRE_ASCII) body.push(padLeft + line);
      body.push('');
    }
    const titleText = `${C.voltBold}${cols >= 30 ? 'B   R   I   D   G   E' : 'BRIDGE'}${C.reset}`;
    body.push(centerPad(titleText, cols) + titleText);

    const leftEndpoint = cols >= 60 ? '[LOCAL WORKSPACE]' : '[LOCAL]';
    const rightEndpoint = cols >= 60 ? '[CLOUD AI MODEL]' : '[CLOUD AI]';
    const trackWidth = Math.min(cols - 4, Math.max(20, Math.floor(cols * 0.6)));
    const dashCount = Math.max(1, Math.floor((trackWidth - leftEndpoint.length - rightEndpoint.length - 3) / 2));
    const subTitle = `${C.steel}${leftEndpoint} ${C.voltBold}${'─'.repeat(dashCount)}━${'─'.repeat(dashCount)}${C.cyanBold} ${rightEndpoint}${C.reset}`;
    body.push(centerPad(subTitle, cols) + subTitle);
    body.push('');

    const barLen = Math.max(8, Math.min(76, Math.floor(cols * 0.58), cols - 10));
    const pct = Math.min(100, Math.round(progress * 100));
    const filled = Math.min(barLen, Math.round(progress * barLen));
    const barLine = `[${C.voltBold}${'█'.repeat(filled)}${C.steel}${'░'.repeat(barLen - filled)}${C.reset}]  ${C.voltBold}${pct}%${C.reset}`;
    body.push(centerPad(barLine, cols) + barLine);

    const statusMsg = progress >= 1.0 ? 'BRIDGE READY' : 'STARTING BRIDGE...';
    body.push(centerPad(statusMsg, cols) + `${C.whiteBold}${statusMsg}${C.reset}`);

    // Center the body vertically between the header and the pinned bottom bar.
    const free = rows - out.length - 1 - body.length;
    const topMargin = Math.max(0, Math.floor(free / 2));
    for (let i = 0; i < topMargin; i++) out.push('');
    out.push(...body);
    while (out.length < rows - 1) out.push('');
    out.push(`${C.voltBold}${thickBar}${C.reset}`);

    paintFrame(out);

    if (progress >= 1.0) break;
    await new Promise(r => setTimeout(r, 35));
  }

  await new Promise(r => setTimeout(r, 120));
}

async function playTunnelCreationAnimation(getTunnelUrlFn, minDurationMs = 2500, maxDurationMs = 20000) {
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');

  const startTime = Date.now();
  let frame = 0;

  const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const stages = [
    'Mounting Bridge & local project sandbox...',
    'Connecting to Cloudflare edge...',
    'Allocating public HTTPS tunnel for MCP...',
    'Finalizing SSE streaming...'
  ];

  // Packet track scales with the window: "[LOCAL PC] ═══▶═══ ( ∞ ) ═══════ [CLOUD AI]"
  function buildTrack(width, step, done) {
    const left = width >= 50 ? '[LOCAL PC] ' : '[PC] ';
    const right = width >= 50 ? ' [CLOUD AI]' : ' [AI]';
    const inner = Math.max(9, width - left.length - right.length - 4);
    const half = Math.floor((inner - 5) / 2);
    const chars = ('═'.repeat(half) + ' ( ∞ ) ' + '═'.repeat(inner - 5 - half - 2)).split('');
    if (!done) {
      const span = chars.length;
      const pos = step % (span * 2);
      const idx = pos < span ? pos : span * 2 - pos - 1;
      if (chars[idx] === '═') chars[idx] = pos < span ? '▶' : '◀';
    }
    return left + chars.join('') + right;
  }

  function drawFrame(badge, statusLine, pct, url) {
    const cols = getFrameWidth();
    const rows = getRows();
    const thickBar = '━'.repeat(cols);
    const thinBar = '─'.repeat(cols);
    const barLen = Math.max(8, Math.min(76, Math.floor(cols * 0.58), cols - 6));
    const filled = Math.round((pct / 100) * barLen);

    const out = [];
    renderAsciiHeaderToOut(out, badge);
    out.push(`  ${C.cyanBold}${buildTrack(cols - 2, frame, pct >= 100)}${C.reset}`);
    out.push(`${C.darkDivider}${thinBar}${C.reset}`);
    out.push(statusLine);
    out.push(`  [${C.voltBold}${'█'.repeat(filled)}${C.steel}${'░'.repeat(barLen - filled)}${C.reset}]`);
    if (url) out.push(`  ${C.voltBold}● MCP URL: ${C.cyanBold}${middleEllipsis(url, Math.max(10, cols - 14))}${C.reset}`);
    else out.push(`  ${C.slate}● ${stages[Math.min(stages.length - 1, Math.floor((frame / 6) % stages.length))]}${C.reset}`);
    while (out.length < rows - 1) out.push('');
    out.push(`${C.voltBold}${thickBar}${C.reset}`);
    paintFrame(out);
  }

  while (true) {
    const elapsed = Date.now() - startTime;
    const url = getTunnelUrlFn();
    if ((url && elapsed >= minDurationMs) || elapsed >= maxDurationMs) break;

    let progress = Math.min(0.92, (elapsed / (minDurationMs + 800)));
    if (url) progress = 0.98;
    const pct = Math.round(progress * 100);
    const spinner = spinners[frame % spinners.length];
    drawFrame(`${C.bgVolt} ESTABLISHING TUNNEL ${C.reset}`,
      `  ${C.voltBold}${spinner}${C.reset} ${C.whiteBold}CREATING CLOUDFLARE TUNNEL${C.reset}  ${C.voltBold}${String(pct).padStart(3, ' ')}%${C.reset}`, pct, null);
    frame++;
    await new Promise(r => setTimeout(r, 60));
  }

  // Final frame: only claim success when a URL really exists.
  const finalUrl = getTunnelUrlFn();
  if (finalUrl) {
    drawFrame(`${C.bgVolt} TUNNEL ACTIVE ${C.reset}`,
      `  ${C.voltBold}✓${C.reset} ${C.whiteBold}CLOUDFLARE TUNNEL CONNECTED${C.reset}  ${C.voltBold}100%${C.reset}`, 100, `${finalUrl}/mcp`);
  } else {
    drawFrame(`${C.redBold} TUNNEL PENDING ${C.reset}`,
      `  ${C.redBold}!${C.reset} ${C.whiteBold}Tunnel not ready yet — it keeps trying in the background.${C.reset}`, 92, null);
  }
  await new Promise(r => setTimeout(r, finalUrl ? 400 : 1500));
}

function selectDirectoryInteractive(startDir) {
  return new Promise((resolve) => {
    isNavigatingFolders = true;
    let currentDir = startDir && fs.existsSync(startDir) ? path.resolve(startDir) : process.cwd();
    let selectedIndex = 0;
    let isTypingPath = false;
    let typedPath = '';
    let errorMessage = '';

    // Switch to Alternate Screen Buffer & hide cursor (locks viewport, ZERO scrollback!)
    process.stdout.write('\x1b[?1049h\x1b[?25l');

    function getItems() {
      const items = [
        { type: 'select_current', name: `[USE CURRENT FOLDER: ${path.basename(currentDir) || currentDir}]`, fullPath: currentDir }
      ];

      const parentDir = path.dirname(currentDir);
      if (parentDir && parentDir !== currentDir) {
        items.push({ type: 'parent', name: '.. (Parent Directory)', fullPath: parentDir });
      }

      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        const dirs = entries
          .filter(e => {
            try {
              return e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules';
            } catch (err) {
              return false;
            }
          })
          .map(e => ({ type: 'dir', name: `${e.name}/`, fullPath: path.join(currentDir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));

        items.push(...dirs);
      } catch (err) {
        errorMessage = 'Access denied or unable to read directory.';
      }

      return items;
    }

    let items = getItems();

    function renderNav() {
      const rows = getRows();
      const barWidth = getFrameWidth();
      const thickBar = '━'.repeat(barWidth);
      const thinBar = '─'.repeat(barWidth);

      const out = [];
      renderAsciiHeaderToOut(out, `${C.bgVolt} DIRECTORY NAVIGATOR ${C.reset}`);

      // Current folder (middle-shortened to fit) with the item counter on the right.
      const counter = `${C.steel}[${items.length} items]${C.reset}`;
      const label = barWidth >= 50 ? 'Current Folder: ' : '';
      const room = Math.max(8, barWidth - 2 - label.length - (barWidth >= 40 ? visibleWidth(counter) + 2 : 0));
      const folderLeft = `  ${C.slate}${label}${C.reset}${C.voltBold}${middleEllipsis(currentDir, room)}${C.reset}`;
      out.push(barWidth >= 40 ? spreadLine(folderLeft, counter, barWidth) : folderLeft);
      out.push(`${C.darkDivider}${thinBar}${C.reset}`);

      if (errorMessage) {
        out.push(`  ${C.redBold}● [NOTE] ${errorMessage}${C.reset}`);
        errorMessage = '';
        out.push(`${C.darkDivider}${thinBar}${C.reset}`);
      }

      if (isTypingPath) {
        out.push('');
        out.push(`  ${C.voltBold}Type or Paste Directory Path:${C.reset}`);
        // Show the end of a long typed path so the cursor stays visible.
        const maxTyped = Math.max(5, barWidth - 6);
        const shown = typedPath.length > maxTyped ? '…' + typedPath.slice(-(maxTyped - 1)) : typedPath;
        out.push(`  > ${C.whiteBold}${shown}${C.reset}_`);
        out.push('');
        out.push(...flowItems([`${C.voltBold}[Enter]${C.reset} Confirm`, `${C.voltBold}[Esc]${C.reset} Back`], barWidth));
        while (out.length < rows - 1) out.push('');
        out.push(`${C.voltBold}${thickBar}${C.reset}`);
      } else {
        const helpItems = [
          `${C.voltBold}[↑/↓]${C.reset} ${C.white}Navigate${C.reset}`,
          `${C.voltBold}[Enter]${C.reset} ${C.white}Open${C.reset}`,
          `${C.voltBold}[Space]${C.reset} ${C.white}Select${C.reset}`,
          `${C.voltBold}[T]${C.reset} ${C.white}Type Path${C.reset}`,
          `${C.voltBold}[Backspace]${C.reset} ${C.white}Up${C.reset}`,
          `${C.voltBold}[Esc]${C.reset} ${C.white}Cancel${C.reset}`,
          `${C.voltBold}[${selectedIndex + 1}/${items.length}]${C.reset}`
        ];
        const helpLines = flowItems(helpItems, barWidth);
        // Rows left for the list = window - header/folder - divider - help - bottom bar.
        const maxVisible = Math.max(1, rows - out.length - helpLines.length - 2);
        let startIdx = 0;
        if (selectedIndex >= maxVisible) startIdx = selectedIndex - maxVisible + 1;
        const visibleItems = items.slice(startIdx, startIdx + maxVisible);
        const itemWidth = Math.max(4, barWidth - 7);

        visibleItems.forEach((item, relIdx) => {
          const actualIdx = startIdx + relIdx;
          const name = middleEllipsis(item.name, itemWidth);
          if (actualIdx === selectedIndex) {
            out.push(`  ${C.bgVolt} ► ${name.padEnd(itemWidth)}${C.reset}`);
          } else {
            const color = item.type === 'select_current' ? C.voltBold : (item.type === 'parent' ? C.steel : C.white);
            out.push(`     ${color}${name}${C.reset}`);
          }
        });
        for (let i = visibleItems.length; i < maxVisible; i++) out.push('');

        out.push(`${C.darkDivider}${thinBar}${C.reset}`);
        out.push(...helpLines);
        out.push(`${C.voltBold}${thickBar}${C.reset}`);
      }

      paintFrame(out);
    }

    renderNav();

    function onResize() {
      renderNav();
    }
    process.stdout.on('resize', onResize);

    function onNavKey(str, key) {
      try {
        if (!key) return;

        if (isTypingPath) {
          if (key.name === 'return') {
            isTypingPath = false;
            if (typedPath && fs.existsSync(typedPath) && fs.statSync(typedPath).isDirectory()) {
              cleanup();
              resolve(fs.realpathSync(path.resolve(typedPath)));
              return;
            } else {
              errorMessage = `Directory "${typedPath}" does not exist.`;
              typedPath = '';
              renderNav();
              return;
            }
          } else if (key.name === 'escape') {
            isTypingPath = false;
            typedPath = '';
            renderNav();
            return;
          } else if (key.name === 'backspace') {
            typedPath = typedPath.slice(0, -1);
            renderNav();
            return;
          } else if (str && !key.ctrl && !key.meta) {
            typedPath += str;
            renderNav();
            return;
          }
          return;
        }

        // Navigation Mode
        if (key.name === 'up') {
          selectedIndex = Math.max(0, selectedIndex - 1);
          renderNav();
        } else if (key.name === 'down') {
          selectedIndex = Math.min(items.length - 1, selectedIndex + 1);
          renderNav();
        } else if (key.name === 't') {
          isTypingPath = true;
          typedPath = '';
          renderNav();
        } else if (key.name === 'backspace') {
          const parentDir = path.dirname(currentDir);
          if (parentDir && parentDir !== currentDir) {
            currentDir = parentDir;
            items = getItems();
            selectedIndex = 0;
            renderNav();
          }
        } else if (key.name === 'space') {
          const sel = items[selectedIndex];
          if (sel) {
            cleanup();
            resolve(sel.fullPath);
          }
        } else if (key.name === 'return') {
          const sel = items[selectedIndex];
          if (!sel) return;

          if (sel.type === 'select_current') {
            cleanup();
            resolve(sel.fullPath);
          } else if (sel.type === 'parent' || sel.type === 'dir') {
            currentDir = sel.fullPath;
            items = getItems();
            selectedIndex = 0;
            renderNav();
          }
        } else if (key.ctrl && key.name === 'c') {
          cleanup();
          cleanupAndExit();
          return;
        } else if (key.name === 'escape') {
          cleanup();
          resolve(currentDir);
        }
      } catch (err) {
        errorMessage = 'Navigation error: ' + err.message;
        renderNav();
      }
    }

    function cleanup() {
      process.stdout.removeListener('resize', onResize);
      process.stdin.removeListener('keypress', onNavKey);
      isNavigatingFolders = false;
    }

    process.stdin.on('keypress', onNavKey);
  });
}

// Wrap plain text into lines of at most `width` characters (breaks long words too).
function wrapPlain(text, width, maxLines) {
  const lines = [];
  let rest = String(text);
  while (rest.length > 0 && lines.length < maxLines) {
    if (rest.length <= width) { lines.push(rest); rest = ''; break; }
    let cut = rest.lastIndexOf(' ', width);
    if (cut < width * 0.5) cut = width;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  if (rest.length > 0 && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.slice(0, Math.max(0, width - 1)) + '…';
  }
  return lines;
}

function renderDashboard() {
  if (isNavigatingFolders || isEstablishingTunnel || isShuttingDown) return;

  const rows = getRows();
  const barWidth = getFrameWidth();
  const thickBar = '━'.repeat(barWidth);
  const thinBar = '─'.repeat(barWidth);
  const wide = barWidth >= 70;
  const divider = `${C.darkDivider}${thinBar}${C.reset}`;

  // Label column: highlighted badges on wide windows, plain short labels on narrow ones.
  const label = (text) => wide
    ? `  ${C.bgVolt} ${text.padEnd(7)} ${C.reset}  `
    : `  ${C.voltBold}${text.slice(0, 7).padEnd(7)}${C.reset} `;
  const labelWidth = visibleWidth(label('PROJECT'));
  const valueWidth = Math.max(6, barWidth - labelWidth);

  // ---- Status badge reflects the real state of the server and tunnel ----
  let badge;
  if (serverStatus === 'failed') badge = `${C.redBold}● STATUS: SERVER DOWN${C.reset}`;
  else if (serverStatus === 'restarting') badge = `${C.redBold}● STATUS: RESTARTING${C.reset}`;
  else if (serverStatus !== 'online' || !mcpTunnelUrl || !tunnelAlive) badge = `${C.slate}● STATUS: CONNECTING${C.reset}`;
  else badge = `${C.voltBold}● STATUS: ONLINE${C.reset}`;

  const header = [];
  renderAsciiHeaderToOut(header, badge);

  // ---- Critical prompts: always shown right under the header, never clipped ----
  const critical = [];
  if (choosingMode) {
    critical.push(`  ${C.voltBold}● APPROVAL MODE${C.reset} ${C.white}${wide ? 'How often should the AI ask before acting?' : 'Choose:'}${C.reset}`);
    if (rows < 16) {
      // Short window: options flow on one or two lines.
      const opts = APPROVAL_MODES.map(m => `${C.voltBold}[${m.key}]${C.reset} ${m.id === approvalMode ? C.whiteBold + '►' : ''}${m.id === 'turbo' ? C.redBold : C.voltBold}${m.name}${C.reset}`);
      critical.push(...flowItems(opts, barWidth, '  ', '  '));
    } else for (const m of APPROVAL_MODES) {
      const current = m.id === approvalMode;
      const marker = current ? `${C.voltBold}►${C.reset}` : ' ';
      const nameColor = m.id === 'turbo' ? C.redBold : C.voltBold;
      const text = wide ? m.desc : m.short;
      critical.push(`  ${marker} ${C.voltBold}[${m.key}]${C.reset} ${nameColor}${m.name.padEnd(7)}${C.reset} ${C.slate}${text}${current ? ' (current)' : ''}${C.reset}`);
    }
    critical.push(`    ${C.slate}[Esc] Cancel${C.reset}`);
    critical.push(divider);
  } else if (confirmingExit) {
    critical.push(`  ${C.redBold}● STOP BRIDGE?${C.reset} ${C.white}${wide ? 'This closes the MCP server and the tunnel. Connected AI chats lose access.' : 'Closes server + tunnel.'}${C.reset}`);
    critical.push(`    ${C.redBold}[Y]${C.reset} ${C.white}Yes, stop${C.reset}    ${C.voltBold}[N]${C.reset} ${C.white}No, keep running${C.reset}`);
    critical.push(divider);
  } else if (approvalQueue.length > 0) {
    const req = approvalQueue[0];
    const more = approvalQueue.length > 1 ? ` ${C.slate}(+${approvalQueue.length - 1} waiting)${C.reset}` : '';
    critical.push(`  ${C.redBold}● PERMISSION NEEDED${C.reset} ${C.whiteBold}${req.action}${C.reset}${more}`);
    // Show the whole command (wrapped), so the user can judge exactly what will run.
    wrapPlain(req.detail, Math.max(6, barWidth - 4), 6).forEach(l => critical.push(`    ${C.cyanBold}${l}${C.reset}`));
    if (req.reason) wrapPlain(`Reason: it ${req.reason}`, Math.max(6, barWidth - 4), 2).forEach(l => critical.push(`    ${C.slate}${l}${C.reset}`));
    const left = Math.max(0, 90 - Math.floor((Date.now() - req.receivedAt) / 1000));
    critical.push(`    ${C.voltBold}[Y]${C.reset} ${C.white}Allow${C.reset}    ${C.redBold}[N]${C.reset} ${C.white}Deny${C.reset}    ${C.slate}(auto-deny in ${left}s)${C.reset}`);
    critical.push(divider);
  }

  // ---- Status lines (listed by priority; low-priority lines drop first on short windows) ----
  const info = [];
  const project = activeProjectDir ? middleEllipsis(activeProjectDir, valueWidth) : '(None selected)';
  info.push({ p: 1, line: `${label('PROJECT')}${C.whiteBold}${project}${C.reset}` });
  if (mcpTunnelUrl) {
    const shown = `${mcpTunnelUrl}/mcp?token=${maskToken(bridgeAuthToken)}`;
    info.push({ p: 1, line: `${label('MCP URL')}${C.cyanBold}${middleEllipsis(shown, valueWidth)}${C.reset}` });
  } else {
    info.push({ p: 1, line: `${label('MCP URL')}${C.slate}Establishing secure tunnel...${C.reset}` });
  }
  const serverText = serverStatus === 'online' ? `${C.voltBold}RUNNING${C.reset} ${C.slate}on 127.0.0.1:${bridgePort}${C.reset}`
    : serverStatus === 'failed' ? `${C.redBold}DOWN${C.reset} ${C.slate}(press [L] for logs)${C.reset}`
    : `${C.slate}${serverStatus.toUpperCase()}...${C.reset}`;
  info.push({ p: 2, line: `${label('SERVER')}${serverText}` });
  const mode = modeInfo(approvalMode);
  info.push({ p: 1, line: `${label('MODE')}${mode.id === 'turbo' ? C.redBold : C.voltBold}${mode.name}${C.reset} ${C.slate}(${wide ? mode.desc : mode.short} • [M] change)${C.reset}` });
  info.push({ p: 3, line: `${label('SAFETY')}${C.voltBold}SANDBOXED${C.reset} ${C.slate}${wide ? '(files jailed to project • harmful commands always blocked)' : '(harmful cmds blocked)'}${C.reset}` });
  info.push({ p: 4, line: `${label('AUTH')}${C.voltBold}BEARER TOKEN${C.reset} ${C.slate}${wide ? '(saved; [T] copy • \`bridge rotate-token\` to replace)' : '([T] copy)'}${C.reset}` });
  if (updateAvailable) {
    info.push({ p: 5, line: `${label('UPDATE')}${C.voltBold}v${updateAvailable} available${C.reset} ${C.white}npm i -g @markmayandi/bridge@latest${C.reset}` });
  }

  // Flash messages wrap (up to 3 lines) instead of being cut, so a URL shown for manual copy stays whole.
  let flash = [];
  if (flashNotification) {
    const flashText = `  ${String(flashNotification).replace(/^\s+/, '')}`;
    flash = visibleWidth(flashText) <= barWidth
      ? [flashText]
      : wrapPlain(stripAnsi(flashText).trim(), Math.max(6, barWidth - 2), 3).map(l => `  ${C.white}${l}${C.reset}`);
    flash.push(divider);
  }

  const keyItems = [
    `${C.voltBold}[C]${C.reset} ${C.white}Copy MCP URL${C.reset}`,
    `${C.voltBold}[T]${C.reset} ${C.white}Copy Token${C.reset}`,
    `${C.voltBold}[D]${C.reset} ${C.white}Switch Folder${C.reset}`,
    `${C.voltBold}[L]${C.reset} ${C.white}Logs ${showLiveLogs ? C.voltBold + 'ON' : C.slate + 'OFF'}${C.reset}`,
    `${C.voltBold}[M]${C.reset} ${C.white}Mode ${modeInfo(approvalMode).name}${C.reset}`,
    `${C.voltBold}[Q]${C.reset} ${C.white}Exit${C.reset}`
  ];
  const keys = flowItems(keyItems, barWidth, '  ', wide ? '    ' : '  ');

  const compat = barWidth >= 126
    ? `  ${C.voltBold}COMPATIBILITY:${C.reset} ${C.whiteBold}Supports every chat-based LLM that provides custom MCP connectors${C.reset} ${C.slate}(Gemini, Claude, ChatGPT, DeepSeek, etc.)${C.reset}`
    : barWidth >= 96
      ? `  ${C.voltBold}COMPATIBILITY:${C.reset} ${C.whiteBold}Every chat-based LLM with custom MCP${C.reset} ${C.slate}• Gemini • Claude • ChatGPT • DeepSeek${C.reset}`
      : `  ${C.voltBold}WORKS WITH:${C.reset} ${C.whiteBold}any chat LLM with custom MCP${C.reset}`;

  // ---- Fit everything to the window height ----
  // Fixed parts: header + critical + info + divider + flash + keys + bar, plus optional footer (bar + compat).
  let footer = [`${C.voltBold}${thickBar}${C.reset}`, compat];
  let infoLines = info.slice();
  let infoDivider = [divider];
  let keyBar = [`${C.voltBold}${thickBar}${C.reset}`];
  const used = () => header.length + critical.length + infoLines.length + infoDivider.length + flash.length + keys.length + keyBar.length + footer.length;
  // Drop the least important parts first; the prompt and the key help always survive.
  if (used() > rows) footer = [];
  while (used() > rows && infoLines.length > 1) {
    const worst = infoLines.reduce((acc, it, i) => (it.p >= infoLines[acc].p ? i : acc), 0);
    infoLines.splice(worst, 1);
  }
  if (used() > rows && flash.length) flash = [];
  if (used() > rows) keyBar = [];
  if (used() > rows && header.length > 1) header.splice(0, header.length, header[1]); // keep only the brand line
  if (used() > rows && (critical.length || confirmingExit || choosingMode)) { infoLines = []; infoDivider = []; }
  if (used() > rows && critical.length) {
    // One-line key help so the prompt's own keys stay visible.
    keys.splice(0, keys.length, `  ${C.voltBold}[Q]${C.reset} Exit`);
  }
  if (used() > rows && critical.length) critical.pop(); // trailing divider
  // Tiny window with a command prompt: shorten the wrapped command, keep the title and the [Y]/[N] line.
  // (The mode picker's option lines are never removed.)
  while (used() > rows && !choosingMode && critical.length > 2) critical.splice(critical.length - 2, 1);

  const out = [...header, ...critical, ...infoLines.map(i => i.line), ...infoDivider, ...flash, ...keys, ...keyBar];
  const middle = Math.max(0, rows - out.length - footer.length);

  if (middle > 0) {
    if (showLiveLogs) {
      out.push(`  ${C.voltBold}LIVE HARNESS TRAFFIC & ACTIVITY LOGS:${C.reset}`);
      const slots = middle - 1;
      const logsToShow = slots > 0 ? recentLogs.slice(-slots) : [];
      if (slots > 0 && logsToShow.length === 0) out.push(`  ${C.slate}(Waiting for AI requests...)${C.reset}`);
      logsToShow.forEach(log => out.push(`  ${log}`));
    } else if (middle >= 3) {
      out.push(`  ${C.voltBold}UNIVERSAL AI MCP HARNESS:${C.reset}`);
      out.push(`  ${C.steel}●${C.reset} ${C.whiteBold}${wide ? 'Built for every chat-based LLM that provides custom MCP connectors.' : 'For any chat LLM with custom MCP.'}${C.reset}`);
      out.push(`  ${C.steel}●${C.reset} ${C.slate}${wide ? "Copy your MCP URL ([C]) and paste it into your AI model's custom MCP tools." : 'Copy URL with [C], paste in your AI.'}${C.reset}`);
    }
    while (out.length < rows - footer.length) out.push('');
  }
  out.push(...footer);

  paintFrame(out);
}

// Keep the approval countdown live while a prompt is open.
setInterval(() => {
  if (approvalQueue.length > 0 && !isNavigatingFolders && !isEstablishingTunnel) renderDashboard();
}, 1000).unref();

async function startBridge() {
  // Check for updates in background (non-blocking)
  checkForUpdates();

  // Enter Alternate Screen Buffer & hide cursor immediately (locks viewport, zero scrollback!)
  process.stdout.write('\x1b[?1049h\x1b[?25l');

  // Ensure readline keypress setup
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // Step 1: Initial Centered Bridge Crossing Animation (Enabled by default on CLI and bat launch!)
  const skipAnimation = process.argv.includes('--no-animation') || process.argv.includes('--fast');
  if (!skipAnimation) {
    await playInitialLoadingAnimation(1800);
  }

  // Step 2: In-CLI Directory Navigator (if no folder was passed)
  if (!activeProjectDir || !fs.existsSync(activeProjectDir)) {
    const picked = await selectDirectoryInteractive(process.cwd());
    if (picked && fs.existsSync(picked)) {
      activeProjectDir = fs.realpathSync(path.resolve(picked));
    } else {
      activeProjectDir = fs.realpathSync(process.cwd());
      setFlash(`  ${C.voltBold}● [DEFAULT]${C.reset} ${C.white}Using current folder. Press ${C.voltBold}[D]${C.white} anytime to browse.${C.reset}`, 5000);
    }
  }

  // Step 3: Pick the port without stopping another Bridge instance or application.
  const useNamedTunnel = Boolean(bridgeConfig.tunnelToken) && !forceQuickTunnel;
  const port = await choosePort(useNamedTunnel, requestedPort);
  if (!port) {
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    const targetPort = requestedPort || 3000;
    console.error('\n' + C.redBold + '● [PORT BUSY] ' + C.reset + `Port ${targetPort} is unavailable; Bridge will not stop its current owner.`);
    console.error(C.slate + (useNamedTunnel && requestedPort && requestedPort !== 3000
      ? 'Your named tunnel ingress points to localhost:3000. Use --port 3000 or switch to a quick tunnel.'
      : useNamedTunnel
        ? 'Your named tunnel points to localhost:3000. Stop that program, then start Bridge again.'
        : requestedPort
          ? 'Choose another port with --port <PORT>.'
          : 'No free port found between 3000 and 3020.') + C.reset + '\n');
    process.exit(1);
  }
  bridgePort = port;

  // Step 4: Start MCP Server in background (supervised: restarted automatically if it crashes)
  startServerProcess();

  // Step 5: Start Cloudflare Tunnel (token mode uses a fixed public URL)
  isEstablishingTunnel = true;
  const activeCloudflaredBin = await ensureCloudflaredBinary();

  // Do not let an unrelated TUNNEL_TOKEN from the machine leak into Bridge's
  // tunnel. Bridge uses only the token saved by `bridge setup`.
  const tunnelEnv = { ...process.env };
  delete tunnelEnv.TUNNEL_TOKEN;
  delete tunnelEnv.TUNNEL_TOKEN_FILE;

  if (useNamedTunnel) {
    tunnelEnv.TUNNEL_TOKEN = bridgeConfig.tunnelToken;
    mcpTunnelUrl = bridgeConfig.publicUrl;
    tunnelProcess = spawn(activeCloudflaredBin, ['tunnel', '--no-autoupdate', 'run'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: tunnelEnv
    });
    copyToClipboard(`${mcpTunnelUrl}/mcp?token=${bridgeAuthToken}`);
    setFlash(`  ${C.voltBold}● [COPIED]${C.reset} ${C.white}Authenticated fixed MCP URL loaded into your clipboard! (Ctrl + V to paste)${C.reset}`);
  } else {
    tunnelProcess = spawn(activeCloudflaredBin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${bridgePort}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: tunnelEnv
    });
  }

  tunnelAlive = true;

  const extractUrl = (text) => {
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !mcpTunnelUrl) {
      mcpTunnelUrl = match[0];
      const fullUrl = `${mcpTunnelUrl}/mcp?token=${bridgeAuthToken}`;
      copyToClipboard(fullUrl);
      setFlash(`  ${C.voltBold}● [COPIED]${C.reset} ${C.white}Authenticated MCP URL loaded into your clipboard! (Ctrl + V to paste)${C.reset}`);
      if (!isNavigatingFolders && !isEstablishingTunnel) renderDashboard();
    }
  };

  const appendTunnelLog = (text) => {
    text.split('\n').filter(l => l.trim()).forEach(l => {
      recentLogs.push(`${C.slate}[${new Date().toLocaleTimeString()}] cloudflared ${l}${C.reset}`);
      if (recentLogs.length > 50) recentLogs.shift();
    });
    if (showLiveLogs && !isNavigatingFolders && !isEstablishingTunnel) renderDashboard();
  };

  if (useNamedTunnel) {
    tunnelProcess.stderr.on('data', chunk => appendTunnelLog(chunk.toString()));
  } else {
    tunnelProcess.stdout.on('data', chunk => extractUrl(chunk.toString()));
    tunnelProcess.stderr.on('data', chunk => extractUrl(chunk.toString()));
  }

  tunnelProcess.on('error', (err) => {
    setFlash(`  ${C.redBold}● [TUNNEL]${C.reset} ${C.white}Could not start cloudflared: ${err.message}${C.reset}`, 8000);
  });

  tunnelProcess.on('exit', (code, signal) => {
    tunnelAlive = false;
    if (isShuttingDown) return;
    if (code !== 0 && !isNavigatingFolders) {
      setFlash(`  ${C.redBold}● [TUNNEL]${C.reset} ${C.white}cloudflared exited (${code ?? signal}). Check the token and public hostname.${C.reset}`, 8000);
    } else {
      renderDashboard();
    }
  });

  // Step 6: Full Quantum Tunnel Creation Animation (directly replaces the tunnel creation wait time!)
  await playTunnelCreationAnimation(() => mcpTunnelUrl, 2500, 20000);
  isEstablishingTunnel = false;

  // Step 7: Smooth Load of Live Dashboard
  renderDashboard();

  // Dynamic window resize listener for main dashboard
  process.stdout.on('resize', () => {
    if (!isNavigatingFolders && !isEstablishingTunnel) {
      renderDashboard();
    }
  });

  // Step 8: Dashboard Keypress Listener
  process.stdin.on('keypress', async (str, key) => {
    try {
      if (isNavigatingFolders || isEstablishingTunnel || !key) return;

      const keyName = (key.name || str || '').toLowerCase();

      // Exit confirmation: Q (or Ctrl+C) asks first; Y stops the server, N/Esc cancels.
      // A second Ctrl+C while asking exits immediately (emergency stop).
      if (confirmingExit) {
        if (keyName === 'y' || (key.ctrl && key.name === 'c')) {
          cleanupAndExit();
        } else if (keyName === 'n' || key.name === 'escape' || keyName === 'q') {
          confirmingExit = false;
          setFlash(`  ${C.voltBold}● [CANCELLED]${C.reset} ${C.white}Bridge keeps running.${C.reset}`, 2500);
        }
        return;
      }

      // Mode picker: 1-4 choose, Esc/M cancels.
      if (choosingMode) {
        const picked = APPROVAL_MODES.find(m => m.key === keyName || m.key === str);
        if (picked) {
          choosingMode = false;
          setApprovalMode(picked.id);
        } else if (key.name === 'escape' || keyName === 'm') {
          choosingMode = false;
          renderDashboard();
        } else if ((key.ctrl && key.name === 'c') || keyName === 'q') {
          choosingMode = false;
          confirmingExit = true;
          renderDashboard();
        }
        return;
      }

      if ((key.ctrl && key.name === 'c') || keyName === 'q') {
        confirmingExit = true;
        renderDashboard();
        return;
      }

      if (approvalQueue.length > 0 && (keyName === 'y' || keyName === 'n')) {
        answerApproval(keyName === 'y');
        return;
      }

      if (keyName === 'c') {
        if (mcpTunnelUrl) {
          const fullUrl = `${mcpTunnelUrl}/mcp?token=${bridgeAuthToken}`;
          if (copyToClipboard(fullUrl)) {
            setFlash(`  ${C.voltBold}● [COPIED]${C.reset} ${C.white}Authenticated MCP URL copied to clipboard (token ${maskToken(bridgeAuthToken)}).${C.reset}`);
          } else {
            // No clipboard tool available: show the full URL once so it can be copied by hand.
            setFlash(`  ${C.redBold}● [NO CLIPBOARD]${C.reset} ${C.white}Copy manually: ${C.cyanBold}${fullUrl}${C.reset}`, 15000);
          }
        } else {
          setFlash(`  ${C.slate}● [WAIT]${C.reset} ${C.white}Tunnel is still establishing... please wait.${C.reset}`);
        }
      } else if (keyName === 't') {
        if (copyToClipboard(bridgeAuthToken)) {
          setFlash(`  ${C.voltBold}● [COPIED]${C.reset} ${C.white}Bearer auth token copied to clipboard (${maskToken(bridgeAuthToken)}).${C.reset}`);
        } else {
          setFlash(`  ${C.redBold}● [NO CLIPBOARD]${C.reset} ${C.white}Token: ${bridgeAuthToken}${C.reset}`, 15000);
        }
      } else if (keyName === 'd') {
        // Launch In-CLI Directory Navigator
        const picked = await selectDirectoryInteractive(activeProjectDir);
        if (picked) {
          switchProjectDirectory(picked);
        }
        renderDashboard();
      } else if (keyName === 'l') {
        showLiveLogs = !showLiveLogs;
        renderDashboard();
      } else if (keyName === 'm') {
        choosingMode = true;
        renderDashboard();
      }
    } catch (err) {
      // Prevent any crash from closing the CLI
      setFlash(`  ${C.redBold}● [NOTE]${C.reset} ${C.white}${err.message}${C.reset}`);
    }
  });

  renderDashboard();
}

// Kill a child and everything it started (the server's background jobs, cloudflared children).
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) {
    try { child.kill(); } catch (err) {}
  }
}

function cleanupAndExit() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  process.stdout.write('\x1b[?1049l\x1b[?25h');
  process.stdout.write('\n\n' + C.voltBold + 'Stopping Bridge and releasing ports...' + C.reset + '\n');
  if (serverProcess) {
    // Ask the server to stop its background jobs, then make sure the whole tree is gone.
    try { serverProcess.send({ type: 'shutdown' }); } catch (e) {}
    killTree(serverProcess);
  }
  killTree(tunnelProcess);
  console.log(C.voltBold + '● [STOPPED] Bridge stopped cleanly. Goodbye!\n' + C.reset);
  process.exit(0);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

process.on('uncaughtException', (err) => {
  process.stdout.write('\x1b[?1049l\x1b[?25h');
  console.error('\n' + C.redBold + '● [UNCAUGHT ERROR] ' + C.reset + err.message + '\n' + (err.stack || ''));
});

process.on('unhandledRejection', (reason) => {
  process.stdout.write('\x1b[?1049l\x1b[?25h');
  console.error('\n' + C.redBold + '● [UNHANDLED REJECTION] ' + C.reset + reason);
});

if (subcommand === 'rotate-token') {
  const fresh = crypto.randomBytes(24).toString('hex');
  writeBridgeConfig({ authToken: fresh });
  console.log('\n' + C.voltBold + '● [ROTATED] ' + C.reset + 'New Bridge auth token saved. Restart Bridge and paste the new MCP URL ([C]) into every AI connector.\n');
  process.exit(0);
} else if (subcommand === 'setup') {
  runSetup().catch((err) => {
    console.error('\n' + C.redBold + '● [SETUP ERROR] ' + C.reset + err.message);
    process.exit(1);
  });
} else if (bridgeConfig.tunnelToken && !isValidPublicUrl(bridgeConfig.publicUrl)) {
  console.error('\n' + C.redBold + '● [CONFIG ERROR] ' + C.reset + 'A tunnel token is saved but the public URL is missing or invalid.');
  console.error(C.slate + 'Run `bridge setup` to add the fixed https:// URL.' + C.reset + '\n');
  process.exit(1);
} else {
  startBridge();
}
