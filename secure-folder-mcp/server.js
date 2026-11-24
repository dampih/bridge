#!/usr/bin/env node

/**
 * Complete DeepSeek-Harness Powered Secure MCP Server
 * 
 * 100% Complete Implementation of DeepSeek Harness (dsh) Core Tools:
 * - Subprocess Shell Execution (dsh-tool-bash, dsh-tool-pwsh)
 * - Background Job Management (dsh-tool-jobs, dsh-jobs-local)
 * - Git Tracking, Diffs & Status (dsh-base, dsh-tool-worktree)
 * - Workspace Dependency Analyzer (dsh-tool-workspace-dependencies)
 * - Web Documentation Fetcher (dsh-tool-web)
 * - Atomic Write & Revert History (dsh-atomic-write, dsh-tool-str-replace-editor)
 * - Plan & Goal Checklist Mode (dsh-plan-mode, dsh-tool-goal, dsh-tool-todo)
 * - Sandboxed Filesystem Suite (dsh-tool-fs)
 * - Dynamic Project Selection & Strict Folder Jailing
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
// Report the installed Bridge release (root package.json), not a hardcoded string.
const BRIDGE_VERSION = (() => {
  for (const p of [path.join(__dirname, '..', 'package.json'), path.join(__dirname, 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pkg.name === '@markmayandi/bridge' && pkg.version) return pkg.version;
    } catch (e) {}
  }
  return '0.0.0';
})();
const { exec, spawn, execSync } = require('child_process');

// ==========================================
// 1. State & CLI Parsing
// ==========================================

const args = process.argv.slice(2);

let rootDir = null;
let isReadOnly = false;
let allowEnvFiles = false;
let httpPort = null;
let authToken = process.env.BRIDGE_TOKEN || process.env.BRIDGE_AUTH_TOKEN || null;
let noAuth = false;
let disableShell = false;
let approvalModeFromCli = null;
let currentPlan = []; // dsh-plan-mode
const fileBackups = new Map(); // dsh-atomic-write: path -> [previous_contents]
const backgroundJobs = new Map(); // dsh-tool-jobs: jobId -> { proc, cmd, startTime, logs }
let nextJobId = 1;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--read-only') {
    isReadOnly = true;
  } else if (arg === '--allow-env') {
    allowEnvFiles = true;
  } else if (arg === '--http') {
    httpPort = parseInt(args[++i], 10) || 3000;
  } else if (arg === '--token') {
    authToken = args[++i] || null;
  } else if (arg === '--no-auth') {
    noAuth = true;
  } else if (arg.startsWith('--approval-mode=')) {
    approvalModeFromCli = arg.split('=')[1];
  } else if (arg === '--approval-mode') {
    approvalModeFromCli = args[++i];
  } else if (arg === '--disable-shell') {
    disableShell = true;
  } else if (!arg.startsWith('-') && !rootDir) {
    rootDir = arg;
  }
}

if (httpPort) {
  if (noAuth) {
    authToken = null;
    logInfo('Warning: Running HTTP server with authentication disabled (--no-auth).');
  } else if (!authToken) {
    authToken = crypto.randomBytes(24).toString('hex');
    logInfo(`Security: Generated session Bearer auth token: ${authToken}`);
  } else {
    logInfo('Security: Bearer authentication enabled with configured token.');
  }
  if (disableShell) {
    logInfo('Security: Remote shell execution disabled (--disable-shell).');
  }
}

if (!rootDir) {
  rootDir = process.cwd();
}

try {
  rootDir = fs.realpathSync(path.resolve(rootDir));
} catch (e) {
  rootDir = process.cwd();
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.vscode', '.idea',
  'dist', 'build', 'out', 'target', '.next', '.nuxt',
  'coverage', '.venv', 'venv', '__pycache__', '.pytest_cache'
]);

const SENSITIVE_PATTERNS = [
  /^\.env($|\..+)/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /credentials\.json$/i
];

// ==========================================
// Command Safety Policy
// ==========================================
// Every shell command (execute_command, bash, pwsh, background jobs) is classified:
//   block   -> refused outright (system damage, disk wipes, privilege/security changes,
//              remote code piping, hidden/encoded payloads)
//   confirm -> deletes / irreversible discards; waits for the human to press Y in the
//              Bridge dashboard (denied automatically if nobody answers)
//   allow   -> runs immediately (builds, tests, git, installs, scripts...)
// This is a best-effort guard against model mistakes, not an OS sandbox: a model can
// still write a script file and run it. Keep the project folder under git.

// Matches the start of a command segment (start of string, or after ; & | && || ( or a newline).
const SEG = String.raw`(?:^|[;&|(\n]\s*|\$\(\s*)`;

const BLOCKED_COMMANDS = [
  { re: new RegExp(SEG + String.raw`format(\.com)?\s+[a-z]:`, 'i'), why: 'formats a disk' },
  { re: /\bformat-volume\b|\bclear-disk\b|\binitialize-disk\b|\bremove-partition\b/i, why: 'modifies disks/partitions' },
  { re: new RegExp(SEG + String.raw`(diskpart|fdisk|mkfs(\.\w+)?|parted|wipefs)\b`, 'i'), why: 'modifies disks/partitions' },
  { re: /\bdd\s+[^|;&]*\bof=\/dev\//i, why: 'writes raw to a device' },
  { re: new RegExp(SEG + String.raw`(sudo\s+)?(shutdown|reboot|halt|poweroff)\b`, 'i'), why: 'shuts down or restarts the machine' },
  { re: /\b(restart|stop)-computer\b/i, why: 'shuts down or restarts the machine' },
  { re: new RegExp(SEG + String.raw`(sudo|su|runas|doas)\b`, 'i'), why: 'elevates privileges' },
  { re: /-verb\s+runas\b/i, why: 'elevates privileges' },
  { re: new RegExp(SEG + String.raw`(reg(\.exe)?\s+(add|delete|import|load|restore)|regedit)\b`, 'i'), why: 'edits the Windows registry' },
  { re: /\b(new|set|remove)-itemproperty\b[^|;&]*\bHK(LM|CU|CR|U)\b|\bHK(LM|CU):\\/i, why: 'edits the Windows registry' },
  { re: new RegExp(SEG + String.raw`(bcdedit|bootrec|vssadmin|wbadmin|cipher\s+\/w|takeown|icacls|cacls|attrib\s+[^|;&]*[+-][shr]\s+[a-z]:\\)`, 'i'), why: 'changes boot, backup, ownership or system file settings' },
  { re: new RegExp(SEG + String.raw`(net\s+(user|localgroup)|net1\s+user)\b`, 'i'), why: 'manages user accounts' },
  { re: /\b(set-mppreference|add-mppreference|disable-windowsoptionalfeature|set-executionpolicy|netsh\s+(advfirewall|firewall))\b/i, why: 'changes security settings' },
  { re: new RegExp(SEG + String.raw`(schtasks\s+\/create|crontab\s+-[er]?)\b`, 'i'), why: 'creates persistent scheduled tasks' },
  { re: /\b(sc(\.exe)?\s+(create|delete|config)|new-service|remove-service)\b/i, why: 'manages system services' },
  { re: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(sh|bash|zsh|python\d*|node|iex|invoke-expression|pwsh|powershell)\b/i, why: 'pipes downloaded code into a shell' },
  { re: /\b(iex|invoke-expression)\b[^\n]*\b(downloadstring|iwr|irm|invoke-webrequest|invoke-restmethod|net\.webclient)\b/i, why: 'runs downloaded code' },
  { re: /\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-(e|ec|enc|encodedcommand)\s+[a-z0-9+\/=]{8,}/i, why: 'runs a hidden (encoded) PowerShell payload' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/i, why: 'opens permissions on the filesystem root' },
  { re: /[a-z]:\\(windows|program files( \(x86\))?|programdata)\\?/i, why: 'touches Windows system folders', onlyIfMutating: true },
  { re: /(^|\s)\/(etc|bin|sbin|usr|boot|sys|proc|var|lib)(\/|\s|$)/i, why: 'touches system folders', onlyIfMutating: true }
];

// Deleting files, or discarding work in a way git cannot undo -> ask the human.
const DELETE_COMMANDS = [
  { kind: 'delete-shell', re: new RegExp(SEG + String.raw`(rm|rmdir|rd|del|erase|unlink|shred|ri)\b`, 'i'), why: 'deletes files or folders' },
  { kind: 'delete-shell', re: /\b(remove-item|clear-content|clear-item)\b/i, why: 'deletes files or folders' },
  { kind: 'delete-other', re: /\bfind\b[^|;&]*\s-(delete|exec\s+rm)\b/i, why: 'deletes files found by find' },
  { kind: 'git-destructive', re: /\bgit\s+(rm\b|clean\b|reset\s+[^|;&]*--hard|checkout\s+[^|;&]*--\s|restore\b|stash\s+(drop|clear)\b|branch\s+[^|;&]*-D\b|push\s+[^|;&]*(--force|-f\b|--delete|:))/i, why: 'discards git work or deletes branches' },
  { kind: 'delete-other', re: /\b(rmtree|os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree|rimraf|del-cli)\b|\.(rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\s*\(/i, why: 'deletes files from an inline script' },
  // Secrets: file tools refuse these names, so shell access to them needs the user's OK too.
  { kind: 'secret', re: /(^|[\s"'\\/=:])\.env(\.[\w.-]+)?(\s|["']|$)|\bid_(rsa|ed25519|ecdsa|dsa)\b|(^|[\s"'\\/])[\w.-]+\.(pem|key|pfx|p12)(\s|["']|$)|\bcredentials\.json\b|\.ssh[\\/]|\.aws[\\/]credentials|\.npmrc\b|\.git-credentials\b/i, why: 'reads or touches a secrets/credentials file' },
  { kind: 'secret', re: /\b(printenv|Get-ChildItem\s+env:|gci\s+env:|ls\s+env:|dir\s+env:)|^\s*(set|env)\s*$/i, why: 'prints all environment variables (may contain secrets)' }
];

const MUTATING_HINT = /\b(rm|del|erase|rd|rmdir|remove-item|move|move-item|mv|copy|copy-item|cp|xcopy|robocopy|set-content|add-content|out-file|new-item|ren|rename|rename-item|mkdir|md|icacls|attrib|takeown|chmod|chown|tee)\b|>/i;

function classifyCommand(cmd) {
  const normalized = String(cmd).replace(/\^/g, ''); // strip cmd.exe caret escapes (r^m -> rm)
  const mutating = MUTATING_HINT.test(normalized);
  for (const rule of BLOCKED_COMMANDS) {
    if (rule.onlyIfMutating && !mutating) continue;
    if (rule.re.test(normalized)) return { level: 'block', reason: rule.why };
  }
  // Collect every sensitive category the command touches (a command can delete AND read secrets).
  const hits = DELETE_COMMANDS.filter(rule => rule.re.test(normalized));
  if (hits.length) {
    return { level: 'confirm', reason: hits[0].why, kinds: [...new Set(hits.map(h => h.kind))] };
  }
  return { level: 'allow', reason: null, kinds: [] };
}

// ==========================================
// Approval Modes (chosen by the user in the Bridge dashboard)
// ==========================================
//   turbo   - never asks. Harmful commands are still blocked.
//   review  - asks before EVERY change: writes, edits, commands, jobs, deletes, folder switches.
//   default - asks for deletes, destructive git, secret files and new project folders.
//   auto    - Bridge decides by risk: asks only for things it cannot undo. delete_file is
//             recoverable (Bridge trash), and deleting build/cache folders is allowed;
//             shell deletes of other files, destructive git, secrets and new folders still ask.
const APPROVAL_MODES = ['turbo', 'review', 'default', 'auto'];
let approvalMode = APPROVAL_MODES.includes(approvalModeFromCli) ? approvalModeFromCli : 'default';

// Folders/files that build tools recreate, so deleting them loses nothing.
const REGENERABLE_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.cache', '.parcel-cache', '.turbo', '.next', '.nuxt',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'target', 'bin', 'obj', '.gradle',
  'tmp', 'temp', '.nyc_output', '.svelte-kit', '.angular', '.expo', 'logs'
]);
const REGENERABLE_PATTERNS = [/\.pyc$/i, /\.pyo$/i, /\.log$/i, /\.tsbuildinfo$/i, /^\*\.(pyc|log|tmp)$/i];

// True when every target of every plain delete (rm/del/rmdir/Remove-Item) in the command is a
// project-relative build/cache path. Anything else (absolute paths, "..", source files) is not.
function isRegenerableDelete(cmd) {
  const segments = String(cmd).replace(/\^/g, '').split(/&&|\|\||[;&|\n]/);
  let sawDelete = false;
  for (const seg of segments) {
    const words = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (!words.length) continue;
    const verb = words[0].toLowerCase();
    if (!['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri'].includes(verb)) continue;
    sawDelete = true;
    const targets = words.slice(1)
      .filter(w => !/^-/.test(w) && !/^\/[a-z]$/i.test(w)) // flags: -rf, -Recurse, /s /q
      .map(w => w.replace(/^["']|["']$/g, ''));
    if (targets.length === 0) return false;
    for (const t of targets) {
      if (path.isAbsolute(t) || /^[a-z]:/i.test(t) || t.split(/[\\/]/).includes('..') || t.startsWith('~')) return false;
      const parts = t.split(/[\\/]/).filter(p => p && p !== '.');
      const last = parts[parts.length - 1] || '';
      const ok = parts.some(p => REGENERABLE_NAMES.has(p.toLowerCase())) || REGENERABLE_PATTERNS.some(re => re.test(last));
      if (!ok) return false;
    }
  }
  return sawDelete;
}

// One decision point for every action that may need the user.
//   kind: write | command | job | delete-tool | delete-shell | delete-other | git-destructive | secret | folder-switch
function needsApproval(kind, meta = {}) {
  switch (approvalMode) {
    case 'turbo':
      return false;
    case 'review':
      return true;
    case 'auto':
      if (kind === 'write' || kind === 'command' || kind === 'job') return false;
      if (kind === 'delete-tool') return false; // goes to the Bridge trash, recoverable
      if (kind === 'delete-shell') return !meta.regenerable;
      return true; // delete-other, git-destructive, secret, folder-switch
    case 'default':
    default:
      return !(kind === 'write' || kind === 'command' || kind === 'job');
  }
}

async function gate(ctx, kind, action, detail, reason, meta) {
  if (ctx && ctx.approved) return; // already approved once for this tool call
  if (!needsApproval(kind, meta)) return;
  const approved = await requestHumanApproval(action, detail, reason);
  if (!approved) {
    throw new Error(`Permission denied: the user did not approve this (${action}: ${detail}). Do not retry the same action; ask the user or choose another approach.`);
  }
  if (ctx) ctx.approved = true;
  logInfo(`Approved by user [${approvalMode}]: ${action} ${detail}`);
}

// ==========================================
// Human Approval (via Bridge dashboard over IPC)
// ==========================================
const APPROVAL_TIMEOUT_MS = 90000; // stay under Cloudflare's ~100s limit for JSON clients
const pendingApprovals = new Map();
let nextApprovalId = 1;

if (typeof process.on === 'function') {
  process.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') { stopAllJobs(); process.exit(0); }
    if (msg && msg.type === 'set-approval-mode') {
      if (setApprovalMode(msg.mode)) { try { process.send({ type: 'approval-mode', mode: approvalMode, requestId: msg.requestId }); } catch (e) {} }
      return;
    }
    if (!msg || msg.type !== 'approval-response') return;
    const pending = pendingApprovals.get(msg.id);
    if (!pending) return;
    pendingApprovals.delete(msg.id);
    clearTimeout(pending.timer);
    pending.resolve(Boolean(msg.approved));
  });
}

function requestHumanApproval(action, detail, reason) {
  if (typeof process.send !== 'function' || !process.connected) {
    return Promise.resolve(false); // no dashboard attached -> never auto-approve
  }
  const id = nextApprovalId++;
  const askedAt = Date.now();
  appendRequestLog(`[APPROVAL] ${new Date().toISOString()} waiting for user: ${action}: ${String(detail).slice(0, 200)}\n`);
  return new Promise((resolveRaw) => {
    const resolve = (ok) => {
      appendRequestLog(`[APPROVAL] ${new Date().toISOString()} ${ok ? 'approved' : 'denied/timed out'} after ${fmtDuration(Date.now() - askedAt)}: ${action}\n`);
      resolveRaw(ok);
    };
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      try { process.send({ type: 'approval-cancel', id }); } catch (e) {}
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(id, { resolve, timer });
    try {
      process.send({ type: 'approval-request', id, action, detail, reason });
    } catch (e) {
      clearTimeout(timer);
      pendingApprovals.delete(id);
      resolve(false);
    }
  });
}

// Folders the user has approved (or picked) as sandbox roots during this session.
const approvedSandboxFolders = new Set([rootDir.toLowerCase()]);

function getForbiddenSandboxReason(dir) {
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root.toLowerCase() === (resolved.endsWith(path.sep) ? resolved : resolved + path.sep).toLowerCase()) {
    return 'it is a whole drive';
  }
  const lower = resolved.toLowerCase();
  if (lower === path.resolve(os.homedir()).toLowerCase()) return 'it is your entire user folder';
  if (path.resolve(os.homedir(), '..').toLowerCase() === lower) return 'it contains every user folder';
  const systemDirs = process.platform === 'win32'
    ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.ProgramData || 'C:\\ProgramData']
    : ['/etc', '/bin', '/sbin', '/usr', '/boot', '/sys', '/proc', '/var', '/lib', '/System', '/Library'];
  for (const sys of systemDirs) {
    const s = path.resolve(sys).toLowerCase();
    if (lower === s || lower.startsWith(s + path.sep)) return 'it is a system folder';
  }
  const sshDir = path.join(os.homedir(), '.ssh').toLowerCase();
  if (lower === sshDir || lower.startsWith(sshDir + path.sep)) return 'it holds SSH keys';
  return null;
}

// Tell the Bridge dashboard the active project changed so its PROJECT line stays accurate.
function notifyProjectChanged() {
  if (typeof process.send === 'function' && process.connected) {
    try { process.send({ type: 'project-changed', path: rootDir }); } catch (e) {}
  }
}

// Run the policy for a command; throws if blocked or denied.
async function enforceCommandPolicy(cmd, ctx, isJob) {
  const verdict = classifyCommand(cmd);
  // Harmful commands are refused in every mode, including turbo.
  if (verdict.level === 'block') {
    logInfo(`Policy BLOCKED command (${verdict.reason}): ${cmd}`);
    throw new Error(`Security Violation: Command blocked by Bridge safety policy because it ${verdict.reason}. Command: ${cmd}`);
  }
  const action = isJob ? 'Start background job' : 'Run command';
  if (verdict.level === 'confirm') {
    const regenerable = verdict.kinds.length === 1 && verdict.kinds[0] === 'delete-shell' && isRegenerableDelete(cmd);
    // Ask if ANY category needs it in the current mode.
    for (const kind of verdict.kinds) {
      if (needsApproval(kind, { regenerable })) {
        await gate(ctx, kind, action, cmd, verdict.reason, { regenerable });
        return;
      }
    }
    return;
  }
  await gate(ctx, isJob ? 'job' : 'command', action, cmd, isJob ? 'starts a long-running process' : 'runs a shell command');
}

function setApprovalMode(mode) {
  if (!APPROVAL_MODES.includes(mode)) return false;
  approvalMode = mode;
  logInfo(`Approval mode set to: ${mode}`);
  return true;
}

// Logs live in ~/.bridge/logs (never inside the user's project) and never contain the token.
const LOG_DIR = path.join(os.homedir(), '.bridge', 'logs');
const REQUEST_LOG = path.join(LOG_DIR, 'server_requests.log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
let logWritesSinceCheck = 0;
function appendRequestLog(line) {
  let safe = line.replace(/([?&](token|apiKey|auth)=)[^&\s]+/gi, '$1[REDACTED]');
  if (authToken) safe = safe.replaceAll(authToken, '[REDACTED]');
  try {
    // Rotate: keep one previous file so the log never fills the disk.
    if (++logWritesSinceCheck >= 200) {
      logWritesSinceCheck = 0;
      if (fs.existsSync(REQUEST_LOG) && fs.statSync(REQUEST_LOG).size > MAX_LOG_BYTES) {
        fs.renameSync(REQUEST_LOG, REQUEST_LOG + '.1');
      }
    }
    fs.appendFileSync(REQUEST_LOG, safe);
  } catch (e) {}
  process.stderr.write(safe);
}

// Short client label for connection logs, e.g. "Google-Gemini/1.0" or "node".
function clientLabel(req) {
  const ua = String(req.headers['user-agent'] || 'unknown');
  return ua.length > 60 ? ua.slice(0, 57) + '...' : ua;
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function logInfo(msg) {
  process.stderr.write(`[DSH-MCP] ${msg}\n`);
}

// ==========================================
// 2. Security Sandbox Validation
// ==========================================

function validateAndResolve(requestedPath, allowNonExistent = false) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new Error('Path parameter must be a non-empty string.');
  }

  if (requestedPath.includes('\0')) {
    throw new Error('Security Violation: Null byte detected.');
  }

  const resolved = path.resolve(rootDir, requestedPath);
  const rel = path.relative(rootDir, resolved);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Security Violation: Path "${requestedPath}" escapes the sandboxed project folder (${rootDir}).`);
  }

  const baseName = path.basename(resolved);
  if (!allowEnvFiles) {
    for (const pat of SENSITIVE_PATTERNS) {
      if (pat.test(baseName)) {
        throw new Error(`Security Violation: Access to sensitive file "${baseName}" is blocked by security policy.`);
      }
    }
  }

  const exists = fs.existsSync(resolved);
  if (!exists && !allowNonExistent) {
    throw new Error(`File or directory does not exist: "${requestedPath}"`);
  }

  // Resolve links (symlinks / junctions) on the path itself, or for a new file on its
  // nearest existing parent folder, so a link inside the project cannot point outside it.
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch (e) {
    throw new Error(`Security Violation: Could not verify path "${requestedPath}".`);
  }
  if (!isInsideRoot(real)) {
    throw new Error(`Security Violation: Path "${requestedPath}" resolves outside the sandboxed project folder (${real}).`);
  }
  if (exists && isSensitiveName(path.basename(real))) {
    throw new Error(`Security Violation: Access to sensitive file "${path.basename(real)}" is blocked by security policy.`);
  }

  return resolved;
}

function isInsideRoot(absPath) {
  const rel = path.relative(rootDir, absPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isSensitiveName(baseName) {
  if (allowEnvFiles) return false;
  return SENSITIVE_PATTERNS.some(pat => pat.test(baseName));
}

// Writes are refused inside version-control metadata: a file in .git/hooks runs on the next git command.
function assertWritable(resolved) {
  const rel = path.relative(rootDir, resolved).split(path.sep);
  if (rel.some(part => part.toLowerCase() === '.git')) {
    throw new Error('Security Violation: Writing inside the .git folder is blocked (hooks/config there can execute code). Use git commands instead.');
  }
}

// Crash-safe write: write a temp file next to the target, then rename over it.
function atomicWriteFile(resolved, content) {
  assertWritable(resolved);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.bridge-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, resolved);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (err) {}
    throw e;
  }
}

// Background jobs: kill the whole process tree (a shell wrapper's children keep running
// and holding ports otherwise), cap how many run, and stop them all when the server exits.
const MAX_RUNNING_JOBS = 8;
function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null || !proc.pid) return true;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch (e) { proc.kill('SIGTERM'); }
    }
    return true;
  } catch (e) {
    try { proc.kill(); return true; } catch (err) { return false; }
  }
}
function pruneFinishedJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of backgroundJobs) {
    if (job.record.status !== 'running' && job.record.endTime && job.record.endTime < cutoff) backgroundJobs.delete(id);
  }
}
let shuttingDown = false;
function stopAllJobs() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const job of backgroundJobs.values()) killProcessTree(job.proc);
}
process.on('exit', stopAllJobs);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { stopAllJobs(); process.exit(0); });
}
// When the Bridge dashboard goes away (IPC closes), stop jobs and exit instead of lingering.
process.on('disconnect', () => { stopAllJobs(); process.exit(0); });

function isPrivateAddress(ip) {
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublicHttpsUrl(urlString) {
  const u = new URL(urlString);
  if (u.protocol !== 'https:') throw new Error('Only https:// URLs are allowed (redirect to a non-HTTPS URL refused).');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error(`Refusing to fetch local host "${host}".`);
  const { lookup } = require('dns').promises;
  const addrs = await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error(`Refusing to fetch "${host}": it resolves to a private/local address (${a.address}).`);
  }
}

// Deleted items go to ~/.bridge/trash/<timestamp>/<project-relative path> (recoverable).
const TRASH_DIR = path.join(os.homedir(), '.bridge', 'trash');
function moveToTrash(resolved) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(TRASH_DIR, stamp, path.basename(rootDir), path.relative(rootDir, resolved));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(resolved, dest);
  } catch (e) {
    // Different drive (EXDEV) or locked rename: copy, then remove the original.
    fs.cpSync(resolved, dest, { recursive: true, errorOnExist: false });
    fs.rmSync(resolved, { recursive: true, force: false });
  }
  return dest;
}

// Undo history: at most MAX_SNAPSHOTS per file and MAX_SNAPSHOT_BYTES in total.
const MAX_SNAPSHOTS = 20;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
let snapshotBytes = 0;
function saveSnapshot(resolved, content) {
  if (typeof content !== 'string') return;
  if (!fileBackups.has(resolved)) fileBackups.set(resolved, []);
  const list = fileBackups.get(resolved);
  list.push(content);
  snapshotBytes += content.length;
  while (list.length > MAX_SNAPSHOTS) snapshotBytes -= list.shift().length;
  // Evict oldest snapshots across files when over the total budget.
  if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
    for (const snaps of fileBackups.values()) {
      while (snaps.length > 1 && snapshotBytes > MAX_SNAPSHOT_BYTES) snapshotBytes -= snaps.shift().length;
      if (snapshotBytes <= MAX_SNAPSHOT_BYTES) break;
    }
  }
}
function popSnapshot(resolved) {
  const list = fileBackups.get(resolved);
  if (!list || list.length === 0) return null;
  const content = list.pop();
  snapshotBytes -= content.length;
  return content;
}

// Read limits keep one huge file from exhausting memory or flooding the model's context.
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
function readTextFileLimited(resolved, size) {
  if (size <= MAX_READ_BYTES) return { text: fs.readFileSync(resolved, 'utf-8'), truncated: false };
  const fd = fs.openSync(resolved, 'r');
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
    return { text: buf.slice(0, n).toString('utf-8'), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

// String.replace treats "$&", "$1", "$'" in a plain replacement string as special codes;
// a function replacer inserts the text literally.
function literalReplace(content, target, replacement, all) {
  if (all) return content.split(target).join(replacement);
  return content.replace(target, () => replacement);
}

function isBinaryFile(filePath) {
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
    '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.woff', '.woff2', '.ttf', '.mp3', '.mp4'
  ]);
  const ext = path.extname(filePath).toLowerCase();
  if (binaryExtensions.has(ext)) return true;

  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1024);
    const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
  } catch (e) {}
  return false;
}

function openWindowsFolderPicker() {
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = "Select the Project Folder to Sandbox for the LLM:"
    $d.ShowNewFolderButton = $true
    if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $d.SelectedPath
    }
  `.replace(/\r?\n/g, ' ');

  try {
    const output = execSync(`powershell -NoProfile -NonInteractive -Command "${psScript}"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return output || null;
  } catch (e) {
    return null;
  }
}

// ==========================================
// 3. Complete Bridge Tool Definitions
// ==========================================

const tools = [
  // --- 1. Subprocess Execution (dsh-tool-bash, dsh-tool-pwsh) ---
  {
    name: 'bash',
    description: 'Bridge Bash: Runs a command in Bash/Shell inside the project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute.'
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds.'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'pwsh',
    description: 'Bridge PowerShell: Runs a PowerShell command inside the project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The PowerShell command to execute.'
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds.'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'execute_command',
    description: 'Bridge Shell: Executes a terminal command (pytest, npm test, python script.py, etc.) strictly inside the project root directory. Captures exit code, stdout, and stderr for testing and verification.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute inside the project directory.'
        },
        timeout_seconds: {
          type: 'number',
          description: 'Maximum runtime in seconds (default: 30, max: 60).',
          default: 30
        }
      },
      required: ['command']
    }
  },

  // --- 2. Background Jobs (dsh-tool-jobs, dsh-jobs-local) ---
  {
    name: 'jobs',
    description: 'Bridge Background Jobs: Manage long-running background tasks (start, status, logs, stop, list).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'logs', 'stop', 'list'],
          description: 'Action to perform.'
        },
        command: {
          type: 'string',
          description: 'Command to run when action="start".'
        },
        job_id: {
          type: 'number',
          description: 'Job ID for status, logs, or stop.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'manage_background_job',
    description: 'Bridge Background Job Runner: Starts long-running processes (e.g., "npm run dev", local servers, file watchers), checks their logs, or stops them.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'logs', 'stop', 'list'],
          description: 'Job action to perform.'
        },
        command: {
          type: 'string',
          description: 'Command to run in background when action="start".'
        },
        job_id: {
          type: 'number',
          description: 'Job ID for status, logs, or stop actions.'
        }
      },
      required: ['action']
    }
  },

  // --- 3. Git Tracking & Diffs (dsh-base, dsh-tool-worktree) ---
  {
    name: 'git_diff',
    description: 'Inspects uncommitted changes in the repository (git diff). Allows reviewing exact modifications.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Optional file path relative to root to inspect diff for.'
        }
      }
    }
  },
  {
    name: 'git_status',
    description: 'Returns the current git status (modified, staged, and untracked files).',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },

  // --- 4. Workspace Dependencies (dsh-tool-workspace-dependencies) ---
  {
    name: 'inspect_dependencies',
    description: 'Bridge Dependency Analyzer: Inspects project manifests (package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod, pom.xml) to identify the project tech stack, frameworks, and installed libraries.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },

  // --- 5. Atomic Edit & Revert (dsh-atomic-write, dsh-tool-str-replace-editor) ---
  {
    name: 'edit',
    description: 'Bridge Edit: Atomically updates a specific code snippet inside an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path of the file relative to project root.'
        },
        old_string: {
          type: 'string',
          description: 'Exact code snippet to replace.'
        },
        new_string: {
          type: 'string',
          description: 'New code snippet.'
        },
        replace_all: {
          type: 'boolean',
          description: 'Whether to replace all occurrences (default: false).'
        }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  {
    name: 'read',
    description: 'Bridge Read: Reads a UTF-8 text file and returns line-numbered content.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path of the file relative to project root.'
        },
        offset: {
          type: 'number',
          description: '1-based line number to start reading from (default: 1).'
        },
        limit: {
          type: 'number',
          description: 'Number of lines to read.'
        }
      },
      required: ['file_path']
    }
  },
  {
    name: 'write',
    description: 'Bridge Write: Creates or overwrites a file inside the project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path of the file relative to project root.'
        },
        content: {
          type: 'string',
          description: 'Full text content to write.'
        }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'str_replace_editor',
    description: 'Bridge Standalone Editor: View, create, replace string, or insert lines into files.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['view', 'create', 'str_replace', 'insert'],
          description: 'Action to perform.'
        },
        path: {
          type: 'string',
          description: 'Path of the file.'
        },
        old_str: {
          type: 'string',
          description: 'Existing string for str_replace.'
        },
        new_str: {
          type: 'string',
          description: 'New string for str_replace or insert.'
        },
        file_text: {
          type: 'string',
          description: 'Content for create.'
        },
        insert_line: {
          type: 'number',
          description: '0-based line number for insert.'
        },
        view_range: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional [start_line, end_line] for view.'
        }
      },
      required: ['command', 'path']
    }
  },
  {
    name: 'edit_file',
    description: 'Bridge Surgical Editor: Atomically replaces a specific text snippet inside an existing file. Automatically creates an undo snapshot before modifying.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file relative to the project root.'
        },
        target: {
          type: 'string',
          description: 'Exact existing code snippet to replace (must match whitespace exactly).'
        },
        replacement: {
          type: 'string',
          description: 'New code snippet to replace the target with.'
        }
      },
      required: ['path', 'target', 'replacement']
    }
  },
  {
    name: 'revert_file',
    description: 'Bridge Atomic Undo: Reverts a file to its previous state prior to the last edit or write operation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file to revert relative to the project root.'
        }
      },
      required: ['path']
    }
  },

  // --- 6. Web Documentation Fetcher (dsh-tool-web) ---
  {
    name: 'fetch_web_documentation',
    description: 'Bridge Web Fetcher: Retrieves external documentation or library API references from an HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The HTTPS URL of the documentation or webpage to retrieve.'
        }
      },
      required: ['url']
    }
  },

  // --- 7. Plan & Goal Mode (dsh-plan-mode, dsh-tool-goal, dsh-tool-todo) ---
  {
    name: 'plan_mode',
    description: 'Bridge Plan Mode: Collaborative milestone planning and checklist tracking (get, set, complete_step).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'complete_step'],
          description: 'Action: "get" to view plan, "set" to update plan items, "complete_step" to check off a milestone.'
        },
        plan_items: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of milestones/steps when action is "set".'
        },
        step_index: {
          type: 'number',
          description: '1-based index of the step to mark completed when action is "complete_step".'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'manage_plan',
    description: 'Bridge Plan Mode: Creates or updates a living checklist of milestones and goals for the current task.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'complete_step'],
          description: 'Action: "get" to view plan, "set" to update plan items, "complete_step" to check off a milestone.'
        },
        plan_items: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of milestones/steps when action is "set".'
        },
        step_index: {
          type: 'number',
          description: '1-based index of the step to mark completed when action is "complete_step".'
        }
      },
      required: ['action']
    }
  },

  // --- 8. Core Filesystem Suite (dsh-tool-fs) ---
  {
    name: 'select_project_folder',
    description: 'Changes the active sandboxed project folder. Use this when the user asks you to work in a different folder (pass folder_path), then continue the task there; all tools then operate inside that folder. The user approves a new folder once in the Bridge dashboard (later switches to it are instant). Drive roots, the home folder itself and system folders are refused. Omit folder_path to open a native folder picker on the user\'s machine.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_path: {
          type: 'string',
          description: 'Absolute path to project directory, or "browse" to open folder dialog.'
        }
      }
    }
  },
  {
    name: 'get_current_project',
    description: 'Returns information about the currently active project folder, detected dependencies, and sandbox boundaries.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_directory',
    description: 'Lists files and folders inside the active project directory in a clean tree structure.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Sub-path inside the project directory to list. Default: "."',
          default: '.'
        },
        depth: {
          type: 'number',
          description: 'Folder recursion depth limit (1 to 4). Default: 2',
          default: 2
        }
      }
    }
  },
  {
    name: 'read_file',
    description: 'Reads the content of a file in the project folder with optional line ranges.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file relative to the project root.'
        },
        start_line: {
          type: 'number',
          description: 'Optional 1-based start line number.'
        },
        end_line: {
          type: 'number',
          description: 'Optional 1-based end line number.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'read_files',
    description: 'Reads multiple files in a single batch request. Highly efficient and eliminates tunnel bandwidth bottlenecks.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of relative file paths to read.'
        }
      },
      required: ['paths']
    }
  },
  {
    name: 'write_files',
    description: 'Creates or updates multiple files in a single batch request. Highly efficient and prevents permission/network stalls.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path.' },
              content: { type: 'string', description: 'Full text content.' }
            },
            required: ['path', 'content']
          },
          description: 'Array of { path, content } objects to write.'
        }
      },
      required: ['files']
    }
  },
  {
    name: 'write_file',
    description: 'Creates or completely overwrites a file inside the active project folder. Automatically saves a revert snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file relative to the project root.'
        },
        content: {
          type: 'string',
          description: 'Full text content to write to the file.'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'search_files',
    description: 'Searches for text or regex patterns across all code files inside the project folder.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text string or regex pattern to search for.'
        },
        path: {
          type: 'string',
          description: 'Sub-directory to search within (default: root ".").'
        },
        file_extension: {
          type: 'string',
          description: 'Optional extension filter (e.g. ".py", ".js", ".html").'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_file_info',
    description: 'Inspects metadata (file size, total line count, modified date) of a file or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to inspect relative to the project root.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'delete_file',
    description: 'Bridge Delete: Deletes a file (or a folder with recursive: true) inside the project. The user must approve every delete in the Bridge dashboard; if denied, do not retry. Deleted text files can be restored with revert_file. Prefer this over rm/del shell commands.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or folder path relative to the project root.'
        },
        recursive: {
          type: 'boolean',
          description: 'Required to delete a folder and everything inside it.',
          default: false
        }
      },
      required: ['path']
    }
  }
];

// MCP tool annotations: clients (ChatGPT, Gemini, Claude) can use readOnlyHint
// to skip per-call confirmation for tools that never modify the workspace.
// Tools that write files or run commands stay unannotated so clients keep asking.
const READ_ONLY_TOOLS = new Set([
  'git_diff',
  'git_status',
  'inspect_dependencies',
  'read',
  'get_current_project',
  'list_directory',
  'read_file',
  'read_files',
  'search_files',
  'get_file_info'
]);
for (const tool of tools) {
  if (READ_ONLY_TOOLS.has(tool.name)) {
    tool.annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
}
if (tools.some(t => t.name === 'fetch_web_documentation')) {
  tools.find(t => t.name === 'fetch_web_documentation').annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
}
// Writes/edits are non-destructive: every overwrite is snapshotted and undoable with revert_file.
const SAFE_WRITE_TOOLS = new Set([
  'edit', 'edit_file', 'str_replace_editor', 'write', 'write_file', 'write_files', 'revert_file', 'plan_mode', 'manage_plan'
]);
// Shell tools: Bridge itself blocks harmful commands and asks the user before deletes.
const GUARDED_SHELL_TOOLS = new Set(['bash', 'pwsh', 'execute_command', 'jobs', 'manage_background_job']);
for (const tool of tools) {
  if (SAFE_WRITE_TOOLS.has(tool.name)) {
    tool.annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  } else if (GUARDED_SHELL_TOOLS.has(tool.name)) {
    tool.annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  } else if (tool.name === 'delete_file') {
    tool.annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
}

const prompts = [
  {
    name: 'bridge_instructions',
    description: 'Bridge autonomous software engineering instructions.',
    arguments: []
  }
];

function getHarnessInstructions() {
  return `You are operating as an autonomous software engineering agent running inside the Bridge local coding harness environment.

ACTIVE WORKSPACE:
Directory: "${rootDir}"

FULL CAPABILITY SUITE:
- Subprocess Execution (execute_command, pwsh, bash): Run linters, unit tests (pytest, npm test), and build tools.
- Background Services (manage_background_job, jobs): Run local servers in background and inspect logs.
- Dependency Analyzer (inspect_dependencies): Check package.json / requirements.txt to know the tech stack.
- Git Tracking (git_status, git_diff): Inspect and verify all changes.
- Atomic Undo (revert_file): Roll back changes if an edit introduced a bug.
- Web Docs (fetch_web_documentation): Query external API docs when needed.
- Plan Checklist (manage_plan, plan_mode): Track multi-step tasks.
- Surgical Editor (edit_file, read_file, read_files, write_file, write_files, str_replace_editor): Fast, token-efficient code manipulation.

RULES:
1. Always run tests using execute_command to verify changes.
2. Check git_diff before declaring a task finished.
3. You are strictly confined to "${rootDir}". All execution runs within this directory.
4. High Efficiency: When reading multiple files, use "read_files" with an array of paths to retrieve them all in a single fast call.
5. Batch Operations: When creating or modifying multiple files, use "write_files" with an array of { path, content } objects to execute them atomically in one call.
6. Approvals: The user's current approval mode is "${approvalMode}". ${{
    turbo: 'Actions run without asking (harmful commands are still blocked).',
    review: 'The user approves every change (writes, edits, commands, deletes) on their machine; batch related writes with write_files to reduce prompts.',
    default: 'Deletes, destructive git commands, secret files and new project folders wait for the user to approve them on their machine.',
    auto: 'Bridge asks the user only for actions it cannot undo (shell deletes of source files, destructive git, secret files, new folders). delete_file and deleting build/cache folders run without asking.'
  }[approvalMode]} Prefer "delete_file" for deletes (recoverable from the Bridge trash). If something is denied, do not retry it; continue another way or ask the user.
7. Safety Policy: Commands that damage the system (disk formatting, shutdown, registry or security changes, privilege elevation, piping downloads into a shell, encoded payloads) are blocked. Do not try to work around a blocked command.
8. pwsh runs PowerShell, execute_command runs the default system shell (cmd.exe on Windows).`;
}

// ==========================================
// 4. Tool Execution Handlers
// ==========================================

async function handleToolCall(name, args) {
  args = args || {};
  const ctx = { approved: false }; // one approval covers the whole tool call

  switch (name) {
    // --- 1. Subprocess Execution (dsh-tool-bash, dsh-tool-pwsh) ---
    case 'pwsh':
    case 'bash':
    case 'execute_command': {
      if (isReadOnly) throw new Error('Server running in read-only mode.');
      if (disableShell) throw new Error('Security Violation: Shell execution is disabled on this server.');
      const cmd = args.command;
      if (!cmd || typeof cmd !== 'string') throw new Error('Command must be a non-empty string.');

      await enforceCommandPolicy(cmd, ctx, false);

      const timeoutMs = Math.min(Math.max(5, (args.timeout_seconds || 60)) * 1000, 180000);

      // The pwsh tool must actually run PowerShell (exec defaults to cmd.exe on Windows).
      const execOptions = {
        cwd: rootDir,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
        windowsHide: true
      };
      if (name === 'pwsh') {
        execOptions.shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
      }

      return new Promise((resolve) => {
        exec(cmd, execOptions, (error, stdout, stderr) => {
          const exitCode = error ? (error.code !== undefined ? error.code : 1) : 0;
          let output = '';
          if (stdout && stdout.trim()) output += `STDOUT:\n${stdout.trim()}\n`;
          if (stderr && stderr.trim()) output += `STDERR:\n${stderr.trim()}\n`;
          if (!output) output = '(Command exited with no output)';

          resolve(`[Bridge Execution]\nCommand: ${cmd}\nExit Code: ${exitCode}\nDirectory: ${rootDir}\n\n${output.trim()}`);
        });
      });
    }

    // --- 2. Background Jobs (dsh-tool-jobs) ---
    case 'jobs':
    case 'manage_background_job': {
      const action = args.action;
      if (action === 'start') {
        if (isReadOnly) throw new Error('Server running in read-only mode.');
        if (disableShell) throw new Error('Security Violation: Shell execution is disabled on this server.');
        const cmd = args.command;
        if (!cmd || typeof cmd !== 'string') throw new Error('Must specify command to start background job.');

        // Background jobs go through the same safety policy as execute_command.
        await enforceCommandPolicy(cmd, ctx, true);

        const running = Array.from(backgroundJobs.values()).filter(j => j.record.status === 'running').length;
        if (running >= MAX_RUNNING_JOBS) {
          throw new Error(`Too many background jobs running (${running}). Stop one with action="stop" first.`);
        }
        pruneFinishedJobs();

        const jobId = nextJobId++;
        const proc = spawn(cmd, {
          cwd: rootDir,
          shell: true,
          windowsHide: true,
          detached: process.platform !== 'win32' // own process group on Unix so stop kills children too
        });

        const jobRecord = {
          id: jobId,
          command: cmd,
          startTime: new Date().toISOString(),
          status: 'running',
          logs: []
        };

        proc.stdout.on('data', d => {
          jobRecord.logs.push(d.toString().slice(-8000));
          if (jobRecord.logs.length > 50) jobRecord.logs.shift();
        });
        proc.stderr.on('data', d => {
          jobRecord.logs.push(d.toString().slice(-8000));
          if (jobRecord.logs.length > 50) jobRecord.logs.shift();
        });
        proc.on('exit', code => {
          if (jobRecord.status === 'running') jobRecord.status = `exited with code ${code}`;
          jobRecord.endTime = Date.now();
        });
        proc.on('error', err => {
          // Without this handler a failed spawn would crash the whole server.
          jobRecord.status = `failed to start: ${err.message}`;
          jobRecord.endTime = Date.now();
        });

        backgroundJobs.set(jobId, { proc, record: jobRecord });
        return `Started background job #${jobId}: "${cmd}" (PID: ${proc.pid})`;
      } else if (action === 'list') {
        if (backgroundJobs.size === 0) return 'No background jobs currently running.';
        const list = Array.from(backgroundJobs.values()).map(j => `#${j.record.id} [${j.record.status}] "${j.record.command}" (Started: ${j.record.startTime})`);
        return `Active Background Jobs:\n${list.join('\n')}`;
      } else if (action === 'logs') {
        const jobId = args.job_id;
        const job = backgroundJobs.get(jobId);
        if (!job) throw new Error(`Job #${jobId} not found.`);
        return `Recent logs for Job #${jobId} ("${job.record.command}"):\n\n${job.record.logs.join('') || '(No output recorded yet)'}`;
      } else if (action === 'stop') {
        const jobId = args.job_id;
        const job = backgroundJobs.get(jobId);
        if (!job) throw new Error(`Job #${jobId} not found.`);
        const ok = killProcessTree(job.proc);
        job.record.status = ok ? 'stopped' : job.record.status;
        return ok ? `Job #${jobId} and its child processes were stopped.` : `Could not stop job #${jobId}.`;
      } else {
        const jobId = args.job_id;
        const job = backgroundJobs.get(jobId);
        if (!job) throw new Error(`Job #${jobId} not found.`);
        return JSON.stringify(job.record, null, 2);
      }
    }

    // --- 3. Git Tools ---
    case 'git_diff': {
      let cmd = 'git diff';
      if (args.file_path) {
        const resolved = validateAndResolve(args.file_path);
        const rel = path.relative(rootDir, resolved);
        cmd = `git diff -- "${rel}"`;
      }
      return new Promise((resolve) => {
        exec(cmd, { cwd: rootDir, timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          if (error && !stdout) {
            resolve(`Git diff unavailable: ${stderr || error.message}`);
          } else {
            const out = stdout.trim();
            resolve(out.length > 200000
              ? out.slice(0, 200000) + `\n\n[Diff truncated: ${out.length} characters total. Pass file_path to see one file.]`
              : (out || 'No uncommitted changes detected (clean working tree).'));
          }
        });
      });
    }

    case 'git_status': {
      return new Promise((resolve) => {
        exec('git status --short --branch', { cwd: rootDir, timeout: 10000 }, (error, stdout, stderr) => {
          if (error && !stdout) {
            resolve(`Git status unavailable (not a git repository): ${stderr || error.message}`);
          } else {
            resolve(stdout.trim() || 'Git working tree clean.');
          }
        });
      });
    }

    // --- 4. Dependency Inspector ---
    case 'inspect_dependencies': {
      const summary = { project_root: rootDir, detected_manifests: {} };

      // Node.js
      const pkgPath = path.join(rootDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          summary.detected_manifests['Node.js (package.json)'] = {
            name: pkg.name,
            version: pkg.version,
            scripts: pkg.scripts,
            dependencies: pkg.dependencies,
            devDependencies: pkg.devDependencies
          };
        } catch (e) {}
      }

      // Python requirements
      const reqPath = path.join(rootDir, 'requirements.txt');
      if (fs.existsSync(reqPath)) {
        try {
          const reqs = fs.readFileSync(reqPath, 'utf-8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
          summary.detected_manifests['Python (requirements.txt)'] = reqs;
        } catch (e) {}
      }

      // Python pyproject
      const pyproject = path.join(rootDir, 'pyproject.toml');
      if (fs.existsSync(pyproject)) {
        summary.detected_manifests['Python (pyproject.toml)'] = 'Present';
      }

      // Rust Cargo.toml
      const cargo = path.join(rootDir, 'Cargo.toml');
      if (fs.existsSync(cargo)) {
        summary.detected_manifests['Rust (Cargo.toml)'] = 'Present';
      }

      // Go go.mod
      const gomod = path.join(rootDir, 'go.mod');
      if (fs.existsSync(gomod)) {
        summary.detected_manifests['Go (go.mod)'] = 'Present';
      }

      return JSON.stringify(summary, null, 2);
    }

    // --- 5. Atomic Edit & Revert (dsh-tool-fs / dsh-tool-str-replace-editor) ---
    case 'edit':
    case 'edit_file': {
      if (isReadOnly) throw new Error('Server running in read-only mode.');
      const filePath = args.file_path || args.path;
      if (!filePath) throw new Error('file_path or path parameter is required.');
      const resolved = validateAndResolve(filePath);
      if (isBinaryFile(resolved)) throw new Error(`Cannot edit binary file "${filePath}".`);

      const content = fs.readFileSync(resolved, 'utf-8');
      const target = args.old_string !== undefined ? args.old_string : (args.old_str !== undefined ? args.old_str : args.target);
      const replacement = args.new_string !== undefined ? args.new_string : (args.new_str !== undefined ? args.new_str : (args.replacement !== undefined ? args.replacement : ''));
      const replaceAll = args.replace_all || false;

      if (!target) throw new Error('old_string or target parameter is required.');
      if (!content.includes(target)) {
        throw new Error(`Target snippet not found in "${filePath}". Check whitespace and indentation.`);
      }

      assertWritable(resolved);
      await gate(ctx, 'write', 'Edit file', path.relative(rootDir, resolved), 'changes a file (undo with revert_file)');
      const updated = literalReplace(content, target, replacement, replaceAll);
      saveSnapshot(resolved, content);
      atomicWriteFile(resolved, updated);
      return replaceAll
        ? `The file ${filePath} has been updated. All occurrences were successfully replaced.`
        : `The file ${filePath} has been updated successfully. (Snapshot saved. Can revert with revert_file).`;
    }

    case 'str_replace_editor': {
      if (isReadOnly && args.command !== 'view') throw new Error('Server running in read-only mode.');
      const cmd = args.command;
      const filePath = args.path || args.file_path;
      if (!filePath) throw new Error('path parameter is required.');

      if (cmd === 'view') {
        const resolved = validateAndResolve(filePath);
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(resolved);
          return `Directory listing for ${filePath}:\n` + entries.slice(0, 50).join('\n');
        }
        const { text: content, truncated } = readTextFileLimited(resolved, stat.size);
        if (truncated) return `[File is ${stat.size} bytes; too large to view at once. Use read_file with offset/limit.]`;
        const lines = content.split(/\r?\n/);
        let start = 1;
        let end = lines.length;
        if (Array.isArray(args.view_range) && args.view_range.length === 2) {
          start = Math.max(1, args.view_range[0]);
          end = Math.min(lines.length, args.view_range[1]);
        }
        return lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(4, ' ')} | ${l}`).join('\n');
      } else if (cmd === 'create') {
        const resolved = validateAndResolve(filePath, true);
        assertWritable(resolved);
        await gate(ctx, 'write', 'Create file', path.relative(rootDir, resolved), 'creates or overwrites a file');
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          saveSnapshot(resolved, fs.readFileSync(resolved, 'utf-8'));
        }
        atomicWriteFile(resolved, args.file_text || '');
        return `File created successfully at: ${filePath}`;
      } else if (cmd === 'str_replace') {
        const resolved = validateAndResolve(filePath);
        if (isBinaryFile(resolved)) throw new Error(`Cannot edit binary file "${filePath}".`);
        const content = fs.readFileSync(resolved, 'utf-8');
        const oldStr = args.old_str;
        const newStr = args.new_str || '';
        if (!oldStr) throw new Error('old_str is required.');
        if (!content.includes(oldStr)) throw new Error(`old_str not found in ${filePath}`);
        assertWritable(resolved);
        await gate(ctx, 'write', 'Edit file', path.relative(rootDir, resolved), 'changes a file (undo with revert_file)');
        saveSnapshot(resolved, content);
        atomicWriteFile(resolved, literalReplace(content, oldStr, newStr, false));
        return `The file ${filePath} has been updated successfully.`;
      } else if (cmd === 'insert') {
        const resolved = validateAndResolve(filePath);
        if (isBinaryFile(resolved)) throw new Error(`Cannot edit binary file "${filePath}".`);
        const content = fs.readFileSync(resolved, 'utf-8');
        const eol = content.includes('\r\n') ? '\r\n' : '\n'; // keep the file's own line endings
        const lines = content.split(/\r?\n/);
        const lineNum = Math.max(0, Math.min(lines.length, args.insert_line || 0));
        lines.splice(lineNum, 0, ...String(args.new_str || '').split(/\r?\n/));
        assertWritable(resolved);
        await gate(ctx, 'write', 'Insert into file', path.relative(rootDir, resolved), 'changes a file (undo with revert_file)');
        saveSnapshot(resolved, content);
        atomicWriteFile(resolved, lines.join(eol));
        return `Inserted content into ${filePath} at line ${lineNum}.`;
      } else {
        throw new Error(`Unknown str_replace_editor command: ${cmd}`);
      }
    }

    case 'revert_file': {
      if (isReadOnly) throw new Error('Server running in read-only mode.');
      const resolved = validateAndResolve(args.path, true); // also restores files removed by delete_file
      if (!(fileBackups.get(resolved) || []).length) {
        throw new Error(`No undo snapshots available for "${args.path}".`);
      }
      await gate(ctx, 'write', 'Revert file', path.relative(rootDir, resolved), 'restores an earlier version of a file');
      const previous = popSnapshot(resolved);
      if (previous === null) {
        throw new Error(`No undo snapshots available for "${args.path}".`);
      }

      atomicWriteFile(resolved, previous);
      const remaining = (fileBackups.get(resolved) || []).length;
      return `Successfully reverted "${args.path}" to previous snapshot. (${remaining} snapshots remaining).`;
    }

    // --- 6. Web Documentation Fetcher ---
    case 'fetch_web_documentation': {
      const targetUrl = args.url;
      if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.startsWith('https://')) {
        throw new Error('URL must start with https://');
      }

      try {
        // Follow redirects by hand so every hop is checked: public HTTPS hosts only, never
        // localhost / LAN / cloud-metadata addresses (stops the model probing the user's network).
        let current = targetUrl;
        let response = null;
        for (let hop = 0; hop <= 5; hop++) {
          await assertPublicHttpsUrl(current);
          response = await fetch(current, {
            headers: { 'User-Agent': 'Bridge-MCP-Agent/1.0' },
            redirect: 'manual',
            signal: AbortSignal.timeout(20000)
          });
          if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            current = new URL(response.headers.get('location'), current).toString();
            continue;
          }
          break;
        }
        if (response.status >= 300 && response.status < 400) throw new Error('Too many redirects.');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > 5 * 1024 * 1024) throw new Error(`Page too large (${declared} bytes).`);
        const text = (await response.text()).slice(0, 5 * 1024 * 1024);
        const clean = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                          .replace(/<[^>]+>/g, ' ')
                          .replace(/\s+/g, ' ')
                          .trim();
        return clean.slice(0, 15000);
      } catch (err) {
        throw new Error(`Failed to fetch URL: ${err.message}`);
      }
    }

    // --- 7. Plan Mode (dsh-plan-mode) ---
    case 'plan_mode':
    case 'manage_plan': {
      const action = args.action;
      if (action === 'set') {
        if (!Array.isArray(args.plan_items)) throw new Error('plan_items must be an array of strings.');
        currentPlan = args.plan_items.map((item, idx) => ({ id: idx + 1, task: item, completed: false }));
        return `Plan initialized with ${currentPlan.length} milestones:\n` + currentPlan.map(p => `[ ] ${p.id}. ${p.task}`).join('\n');
      } else if (action === 'complete_step') {
        const idx = args.step_index;
        if (!idx || idx < 1 || idx > currentPlan.length) throw new Error(`Invalid step_index: ${idx}`);
        currentPlan[idx - 1].completed = true;
        return `Marked milestone #${idx} as completed.\nCurrent Plan Status:\n` + currentPlan.map(p => `[${p.completed ? 'x' : ' '}] ${p.id}. ${p.task}`).join('\n');
      } else {
        if (currentPlan.length === 0) return 'No active plan. Use action="set" with plan_items to initialize a plan.';
        return 'Current Plan Status:\n' + currentPlan.map(p => `[${p.completed ? 'x' : ' '}] ${p.id}. ${p.task}`).join('\n');
      }
    }

    // --- 8. Core Filesystem Tools ---
    case 'select_project_folder': {
      let targetPath = args.folder_path;
      if (!targetPath || targetPath === 'browse' || targetPath === 'picker') {
        logInfo('Opening native Windows FolderBrowserDialog...');
        targetPath = openWindowsFolderPicker();
        if (!targetPath) {
          return `Folder selection cancelled. Active project remains: "${rootDir}".`;
        }
      }

      const resolved = path.resolve(targetPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`Target path "${targetPath}" is not a valid directory.`);
      }

      const realTarget = fs.realpathSync(resolved);

      // Never sandbox a whole drive, the home folder itself, or system folders.
      const forbiddenReason = getForbiddenSandboxReason(realTarget);
      if (forbiddenReason) {
        throw new Error(`Security Violation: "${realTarget}" cannot be used as a project folder (${forbiddenReason}). Choose a specific project folder.`);
      }

      // The model may switch folders when the user asks it to, but the server cannot tell a
      // real user request from a prompt injection, so a path typed by the model needs one Y
      // in the Bridge dashboard. Folders approved once (or picked by the user) are remembered
      // for this session and switch instantly afterwards.
      const pickedByUser = !args.folder_path || args.folder_path === 'browse' || args.folder_path === 'picker';
      if (!pickedByUser && !approvedSandboxFolders.has(realTarget.toLowerCase())) {
        await gate(ctx, 'folder-switch', 'Switch project folder', realTarget, 'lets the AI read, write and run commands in this folder');
      }

      const previousRoot = rootDir;
      rootDir = realTarget;
      approvedSandboxFolders.add(rootDir.toLowerCase());
      approvedSandboxFolders.add(previousRoot.toLowerCase()); // switching back needs no new approval
      currentPlan = [];
      // Undo history is keyed by absolute path, so it stays valid across folder switches.
      notifyProjectChanged();
      logInfo(`Switched project to: ${rootDir}`);
      return `✓ Project folder successfully set to: "${rootDir}".\nBridge now strictly sandboxed to this folder.`;
    }

    case 'get_current_project': {
      let fileCount = 0;
      let dirCount = 0;
      try {
        const entries = fs.readdirSync(rootDir);
        for (const e of entries) {
          if (IGNORED_DIRS.has(e)) continue;
          try {
            const s = fs.statSync(path.join(rootDir, e));
            if (s.isDirectory()) dirCount++;
            else fileCount++;
          } catch (err) {}
        }
      } catch (e) {}

      return JSON.stringify({
        active_project_path: rootDir,
        harness: 'Bridge',
        modules: [
          'dsh-tool-bash (execute_command)',
          'dsh-tool-jobs (manage_background_job)',
          'dsh-base (git_diff, git_status)',
          'dsh-tool-workspace-dependencies (inspect_dependencies)',
          'dsh-atomic-write (edit_file, revert_file)',
          'dsh-tool-web (fetch_web_documentation)',
          'dsh-plan-mode (manage_plan)',
          'dsh-tool-fs (read_file, write_file, search_files, list_directory)'
        ],
        top_level_files: fileCount,
        top_level_directories: dirCount,
        boundary: 'Strictly jailed to this directory alone'
      }, null, 2);
    }

    case 'list_directory': {
      const targetRel = args.path || '.';
      const maxDepth = Math.min(Math.max(1, args.depth || 2), 4);
      const resolved = validateAndResolve(targetRel);

      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) throw new Error(`"${targetRel}" is a file.`);

      const results = [];
      function walk(currentDir, currentDepth) {
        if (currentDepth > maxDepth) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
          if (results.length >= 2000) return;

          const fullEntryPath = path.join(currentDir, entry.name);
          const relPath = path.relative(rootDir, fullEntryPath).replace(/\\/g, '/');

          if (entry.isSymbolicLink()) {
            results.push({ type: 'link', path: relPath });
            continue;
          }
          if (entry.isDirectory()) {
            let inside = false;
            try { inside = isInsideRoot(fs.realpathSync(fullEntryPath)); } catch (e) {}
            if (!inside) { results.push({ type: 'link', path: relPath }); continue; }
            results.push({ type: 'dir', path: relPath });
            walk(fullEntryPath, currentDepth + 1);
          } else {
            let size = 0;
            try { size = fs.statSync(fullEntryPath).size; } catch (e) {}
            results.push({ type: 'file', path: relPath, size });
          }
        }
      }

      walk(resolved, 1);
      if (results.length === 0) return `Directory "${targetRel}" is empty.`;

      const formatted = results.map(item => item.type === 'dir' ? `[DIR]  ${item.path}/`
        : item.type === 'link' ? `[LINK] ${item.path} (link; not followed)`
        : `[FILE] ${item.path} (${item.size} bytes)`).join('\n');
      return `Workspace: "${rootDir}"\n\n${formatted}`;
    }

    case 'read':
    case 'read_file': {
      const filePath = args.file_path || args.path;
      if (!filePath) throw new Error('file_path or path parameter is required.');
      const resolved = validateAndResolve(filePath);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) throw new Error(`"${filePath}" is a directory.`);
      if (isBinaryFile(resolved)) return `[Binary file (${stat.size} bytes) cannot be displayed as text.]`;

      const { text: content, truncated } = readTextFileLimited(resolved, stat.size);
      const lines = content.split(/\r?\n/);
      if (truncated) lines.pop(); // last line may be cut mid-way
      const totalLines = lines.length;

      let startLine = 1;
      if (args.offset !== undefined) startLine = Math.max(1, parseInt(args.offset, 10));
      else if (args.start_line !== undefined) startLine = Math.max(1, parseInt(args.start_line, 10));

      let endLine = totalLines;
      if (args.limit !== undefined) endLine = Math.min(totalLines, startLine + parseInt(args.limit, 10) - 1);
      else if (args.end_line !== undefined) endLine = Math.min(totalLines, parseInt(args.end_line, 10));

      const slice = lines.slice(startLine - 1, endLine);
      const outputLines = slice.map((line, idx) => `${String(startLine + idx).padStart(4, ' ')} | ${line}`);

      const note = truncated ? `\n\n[Only the first ${MAX_READ_BYTES / (1024 * 1024)} MB of this ${stat.size}-byte file can be read.]` : '';
      return `File: ${filePath} (Lines ${startLine}-${endLine} of ${totalLines}${truncated ? '+' : ''}):\n\n${outputLines.join('\n')}${note}`;
    }

    case 'read_files':
    case 'read_multiple_files': {
      const filePaths = Array.isArray(args.paths) ? args.paths : (args.files || []);
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        throw new Error('paths parameter must be a non-empty array of file paths.');
      }

      const results = [];
      let budget = MAX_READ_BYTES * 2; // total bytes returned by one batch read
      for (const fp of filePaths) {
        try {
          const resolved = validateAndResolve(fp);
          const stat = fs.statSync(resolved);
          if (!stat.isDirectory() && stat.size > budget) {
            results.push(`=== FILE: ${fp} ===\n[Skipped: ${stat.size} bytes exceeds the remaining batch limit. Read it alone with read_file.]\n=== END: ${fp} ===`);
            continue;
          }
          if (stat.isDirectory()) {
            results.push(`=== FILE: ${fp} ===\n[Error: "${fp}" is a directory]\n=== END: ${fp} ===`);
            continue;
          }
          if (isBinaryFile(resolved)) {
            results.push(`=== FILE: ${fp} ===\n[Binary file (${stat.size} bytes) omitted]\n=== END: ${fp} ===`);
            continue;
          }
          const content = fs.readFileSync(resolved, 'utf-8');
          budget -= stat.size;
          results.push(`=== FILE: ${fp} (${stat.size} bytes) ===\n${content}\n=== END: ${fp} ===`);
        } catch (err) {
          results.push(`=== FILE: ${fp} ===\n[Error: ${err.message}]\n=== END: ${fp} ===`);
        }
      }

      return results.join('\n\n');
    }

    case 'write':
    case 'write_file': {
      if (isReadOnly) throw new Error('Server running in read-only mode.');
      const filePath = args.file_path || args.path;
      if (!filePath) throw new Error('file_path or path parameter is required.');
      const resolved = validateAndResolve(filePath, true);
      assertWritable(resolved);

      await gate(ctx, 'write', 'Write file', path.relative(rootDir, resolved), 'creates or overwrites a file (undo with revert_file)');

      // Save undo snapshot if file exists
      const existedBefore = fs.existsSync(resolved);
      if (existedBefore) {
        if (fs.statSync(resolved).isDirectory()) throw new Error(`"${filePath}" is a directory.`);
        saveSnapshot(resolved, fs.readFileSync(resolved, 'utf-8'));
      }

      atomicWriteFile(resolved, args.content !== undefined ? String(args.content) : '');
      const stat = fs.statSync(resolved);
      return `<path>${filePath}</path>\n<type>file</type>\n<content>\n${existedBefore ? 'Updated' : 'Created'} file (${stat.size} bytes)\n</content>`;
    }

    case 'write_files':
    case 'write_multiple_files': {
      if (isReadOnly) throw new Error('Server running in read-only mode.');
      const files = Array.isArray(args.files) ? args.files : [];
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error('files parameter must be a non-empty array of objects with { path, content }.');
      }

      // Validate every path before writing anything, so one bad path cannot leave a half-applied batch.
      const plan = files.map((item, idx) => {
        const filePath = item && (item.path || item.file_path);
        if (!filePath) throw new Error(`files[${idx}] is missing a path. Nothing was written.`);
        let resolved;
        try {
          resolved = validateAndResolve(filePath, true);
          assertWritable(resolved);
          if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) throw new Error('is a directory');
        } catch (err) {
          throw new Error(`files[${idx}] "${filePath}": ${err.message} Nothing was written.`);
        }
        return { filePath, resolved, content: item.content !== undefined ? String(item.content) : '' };
      });

      await gate(ctx, 'write', `Write ${plan.length} file${plan.length === 1 ? '' : 's'}`,
        plan.map(p => path.relative(rootDir, p.resolved)).join(', '), 'creates or overwrites files (undo with revert_file)');

      // Apply; if a write fails midway, roll back the files already written in this batch.
      const applied = [];
      try {
        for (const p of plan) {
          const before = fs.existsSync(p.resolved) ? fs.readFileSync(p.resolved, 'utf-8') : null;
          atomicWriteFile(p.resolved, p.content);
          applied.push({ ...p, before });
        }
      } catch (err) {
        for (const a of applied.reverse()) {
          try {
            if (a.before === null) fs.rmSync(a.resolved, { force: true });
            else atomicWriteFile(a.resolved, a.before);
          } catch (e) {}
        }
        throw new Error(`Batch write failed at "${plan[applied.length].filePath}": ${err.message}. All files in this batch were rolled back.`);
      }

      const results = applied.map(a => {
        if (a.before !== null) saveSnapshot(a.resolved, a.before);
        return `- ${a.filePath} (${Buffer.byteLength(a.content)} bytes)`;
      });
      return `Successfully wrote ${results.length} files:\n${results.join('\n')}`;
    }

    case 'delete_file': {
      if (isReadOnly) throw new Error('Server running in read-only mode.');
      const filePath = args.path || args.file_path;
      if (!filePath) throw new Error('path parameter is required.');
      const resolved = validateAndResolve(filePath);
      if (resolved === rootDir) throw new Error('Refusing to delete the project root.');
      const stat = fs.statSync(resolved);
      const isDir = stat.isDirectory();
      if (isDir && !args.recursive) {
        throw new Error(`"${filePath}" is a directory. Pass recursive: true to delete it and everything inside.`);
      }

      await gate(ctx, 'delete-tool',
        isDir ? 'Delete folder' : 'Delete file',
        path.relative(rootDir, resolved) + (isDir ? path.sep + ' (recursive)' : ''),
        isDir ? 'deletes a folder and its contents (kept in the Bridge trash)' : 'deletes a file (kept in the Bridge trash)');

      assertWritable(resolved);
      // Keep a text snapshot so revert_file can bring a deleted file back.
      if (!isDir && !isBinaryFile(resolved) && stat.size <= MAX_READ_BYTES) {
        saveSnapshot(resolved, fs.readFileSync(resolved, 'utf-8'));
      }
      // Move to Bridge's trash instead of erasing, so any delete (binary, folders) can be recovered.
      const trashPath = moveToTrash(resolved);
      logInfo(`Deleted with user approval: ${resolved} -> ${trashPath}`);
      return isDir
        ? `Deleted folder "${filePath}" (approved by user). A copy is kept in the Bridge trash: ${trashPath}`
        : `Deleted file "${filePath}" (approved by user). Use revert_file to restore it; a copy is also in the Bridge trash: ${trashPath}`;
    }

    case 'search_files': {
      const targetRel = args.path || '.';
      const query = args.query;
      const extFilter = args.file_extension ? args.file_extension.toLowerCase() : null;
      const resolved = validateAndResolve(targetRel);

      const matches = [];
      const MAX_MATCHES = 40;

      if (!query || typeof query !== 'string') throw new Error('query parameter is required.');
      let filesScanned = 0;
      const MAX_FILES_SCANNED = 5000;

      function searchDir(currentDir, depth) {
        if (matches.length >= MAX_MATCHES || depth > 25) return;
        let entries;
        try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (e) { return; }

        for (const entry of entries) {
          if (matches.length >= MAX_MATCHES || filesScanned >= MAX_FILES_SCANNED) break;
          if (entry.name.startsWith('.')) continue;
          // Never follow links: a link inside the project could point at files outside it.
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            // Junctions on Windows report as directories; check the real target stays inside.
            try { if (!isInsideRoot(fs.realpathSync(fullPath))) continue; } catch (e) { continue; }
            searchDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            if (extFilter && !entry.name.toLowerCase().endsWith(extFilter)) continue;
            if (isSensitiveName(entry.name)) continue; // same secret-file rules as read_file
            try {
              if (fs.statSync(fullPath).size > MAX_SEARCH_FILE_BYTES) continue;
            } catch (e) { continue; }
            if (isBinaryFile(fullPath)) continue;
            filesScanned++;

            try {
              const fileContent = fs.readFileSync(fullPath, 'utf-8');
              const lines = fileContent.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (matches.length >= MAX_MATCHES) break;
                if (lines[i].includes(query)) {
                  const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
                  matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
                }
              }
            } catch (e) {}
          }
        }
      }

      if (!fs.statSync(resolved).isDirectory()) throw new Error(`"${targetRel}" is not a directory.`);
      searchDir(resolved, 0);
      if (matches.length === 0) return `No matches found for "${query}".`;
      return `Search results for "${query}":\n\n${matches.join('\n')}`;
    }

    case 'get_file_info': {
      const resolved = validateAndResolve(args.path);
      const stat = fs.statSync(resolved);
      return JSON.stringify({
        path: args.path,
        is_directory: stat.isDirectory(),
        size_bytes: stat.size,
        modified: stat.mtime
      }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ==========================================
// 5. JSON-RPC Protocol Processor (Shared)
// ==========================================

async function processJsonRpcMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    const requestedVersion = (params && params.protocolVersion) || '2024-11-05';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requestedVersion,
        capabilities: {
          tools: { listChanged: true },
          prompts: { listChanged: true },
          resources: { subscribe: false, listChanged: false },
          logging: {}
        },
        serverInfo: {
          name: 'Bridge',
          version: BRIDGE_VERSION
        }
      }
    };
  }

  if (method === 'notifications/initialized') {
    return null;
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools } };
  }

  if (method === 'tools/call') {
    const { name, arguments: toolArgs } = params || {};
    try {
      const resultText = await handleToolCall(name, toolArgs);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof resultText === 'string' ? resultText : JSON.stringify(resultText) }],
          isError: false
        }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true
        }
      };
    }
  }

  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts } };
  }

  if (method === 'prompts/get') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        description: 'Bridge Instructions',
        messages: [{ role: 'user', content: { type: 'text', text: getHarnessInstructions() } }]
      }
    };
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }

  if (method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  }

  if (method === 'completion/complete') {
    return { jsonrpc: '2.0', id, result: { completion: { values: [] } } };
  }

  if (method === 'logging/setLevel') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

// ==========================================
// 6. HTTP Transport (Gemini, Claude, ChatGPT)
// ==========================================

function extractAuthToken(req, url) {
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      return parts[1].trim();
    }
    return authHeader.trim();
  }

  if (req.headers['x-bridge-token']) {
    return String(req.headers['x-bridge-token']).trim();
  }
  if (req.headers['x-api-key']) {
    return String(req.headers['x-api-key']).trim();
  }

  if (url && url.searchParams) {
    const qToken = url.searchParams.get('token') || url.searchParams.get('apiKey') || url.searchParams.get('auth');
    if (qToken) {
      return qToken.trim();
    }
  }

  return null;
}

function verifyAuth(req, url) {
  if (!authToken) return true;
  const provided = extractAuthToken(req, url);
  if (!provided) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(authToken);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function startHttpServer(port) {
  logInfo(`Starting Bridge MCP Server on port ${port}...`);
  logInfo(`Current Sandboxed Folder: ${rootDir}`);

  const sseSessions = new Map();

  function sendToSse(sessionId, payload) {
    const sseFormatted = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    if (sessionId && sseSessions.has(sessionId)) {
      try {
        sseSessions.get(sessionId).res.write(sseFormatted);
        return;
      } catch (e) {
        sseSessions.delete(sessionId);
      }
    }
    // No fallback broadcast. Streamable HTTP clients (e.g. Gemini) POST without
    // a sessionId and already get the reply in the POST body. Broadcasting it to
    // every open SSE stream delivers responses with unknown ids to other clients,
    // which the MCP SDK treats as a protocol error and reconnects.
  }

  const server = http.createServer(async (req, res) => {
    const logLine = `[HTTP] ${new Date().toISOString()} ${req.method} ${req.url} (Accept: ${req.headers.accept || '*/*'}) host: ${req.headers.host || ''}\n`;
    appendRequestLog(logLine);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (authToken && !verifyAuth(req, url)) {
      const authErrLog = `[401-UNAUTHORIZED] ${new Date().toISOString()} ${req.method} ${url.pathname}\n`;
      appendRequestLog(authErrLog);

      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="Bridge MCP"'
      });
      res.end(JSON.stringify({
        error: 'Unauthorized: Valid authentication token required. Provide via Authorization header (Bearer <token>) or ?token=<token> query parameter.',
        status: 401
      }));
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/mcp' || url.pathname === '/' || url.pathname === '/sse')) {
      // Support standard MCP Server-Sent Events (SSE) streaming transport
      if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
        if (req.socket) {
          req.socket.setKeepAlive(true, 10000);
          req.socket.setNoDelay(true);
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*'
        });

        const proto = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const sessionId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
        const tokenParam = authToken ? `&token=${encodeURIComponent(authToken)}` : '';
        const endpointUri = `${proto}://${host}/mcp?sessionId=${sessionId}${tokenParam}`;

        // Send a 2KB whitespace comment to force Cloudflare proxy buffer to flush immediately!
        res.write(`: ${' '.repeat(2048)}\n\n`);
        res.write(`event: endpoint\ndata: ${endpointUri}\n\n`);

        const openedAt = Date.now();
        const shortId = sessionId.slice(0, 8);
        let pingsSent = 0;
        let closeReason = 'client closed the stream';

        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n');
            res.write('event: ping\ndata: {}\n\n');
            pingsSent++;
          } catch (e) {
            closeReason = `ping write failed: ${e.message}`;
            clearInterval(keepAlive);
            sseSessions.delete(sessionId);
          }
        }, 15000);

        sseSessions.set(sessionId, { res, keepAlive });
        appendRequestLog(`[SSE-OPEN] ${new Date().toISOString()} stream ${shortId} opened by "${clientLabel(req)}" via ${host} (open streams: ${sseSessions.size})\n`);

        let closed = false;
        const cleanup = (why) => {
          if (closed) return;
          closed = true;
          if (why) closeReason = why;
          clearInterval(keepAlive);
          sseSessions.delete(sessionId);
          appendRequestLog(`[SSE-CLOSE] ${new Date().toISOString()} stream ${shortId} closed after ${fmtDuration(Date.now() - openedAt)} (${pingsSent} pings sent; ${closeReason}; open streams: ${sseSessions.size})\n`);
        };
        req.on('close', () => cleanup());
        req.on('error', (e) => cleanup(`request error: ${e.message}`));
        res.on('close', () => cleanup());
        res.on('error', (e) => cleanup(`response error: ${e.message}`));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'online',
        service: 'Bridge Universal MCP Suite',
        protocolVersion: '2024-11-05',
        activeProject: rootDir,
        toolsCount: tools.length,
        tools: tools.map(t => t.name)
      }, null, 2));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        openapi: '3.1.0',
        info: {
          title: 'Bridge MCP API',
          description: 'Full software engineering harness: execution, background jobs, git, dependency analysis, atomic undo, and filesystem.',
          version: BRIDGE_VERSION
        },
        servers: [{ url: `https://${req.headers.host}` }],
        paths: {
          '/call': {
            post: {
              summary: 'Execute a Bridge tool',
              operationId: 'executeTool',
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', enum: tools.map(t => t.name) },
                        arguments: { type: 'object' }
                      },
                      required: ['name', 'arguments']
                    }
                  }
                }
              },
              responses: {
                '200': {
                  description: 'Tool result',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          success: { type: 'boolean' },
                          result: { type: 'string' },
                          error: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }, null, 2));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'online',
        activeProject: rootDir,
        toolsCount: tools.length,
        activeSseSessions: sseSessions.size,
        isReadOnly: isReadOnly,
        uptime: process.uptime()
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/set-directory') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request body too large (limit 20 MB).' } }));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        try {
          const payload = JSON.parse(body);
          let targetPath = payload.path;
          if (!targetPath) throw new Error('Missing path parameter.');
          const resolved = path.resolve(targetPath);
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error(`Directory "${targetPath}" does not exist.`);
          }
          rootDir = fs.realpathSync(resolved);
          approvedSandboxFolders.add(rootDir.toLowerCase()); // chosen by the user with [D]
          currentPlan = [];
          fileBackups.clear();
          logInfo(`Switched project directory via CLI to: ${rootDir}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, activeProject: rootDir }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/call') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request body too large (limit 20 MB).' } }));
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (res.writableEnded) return;
        try {
          const payload = JSON.parse(body);
          const result = await handleToolCall(payload.name, payload.arguments);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/' || url.pathname === '/messages' || url.pathname === '/message')) {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request body too large (limit 20 MB).' } }));
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (res.writableEnded) return;
        let msg;
        try {
          msg = JSON.parse(body);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error: invalid JSON' }
          }));
          return;
        }

        const sessionId = url.searchParams.get('sessionId') || req.headers['mcp-session-id'];
        const isLegacySseSession = Boolean(sessionId && sseSessions.has(sessionId));

        // Streamable HTTP: for tool calls from clients that accept SSE (e.g. Gemini),
        // answer the POST with an event stream and send keepalive comments while the
        // tool runs. Cloudflare drops a request after ~100s with no response bytes
        // (HTTP 524), so a plain JSON reply to a long command would kill the call.
        const acceptsSse = (req.headers.accept || '').includes('text/event-stream');
        const streamReply = acceptsSse && !isLegacySseSession && msg && msg.method === 'tools/call' && msg.id !== undefined;

        const startedAt = Date.now();
        const toolName = msg && msg.method === 'tools/call' && msg.params ? msg.params.name : null;
        let clientGone = false;
        res.on('close', () => {
          if (!res.writableEnded) {
            clientGone = true;
            appendRequestLog(`[CLIENT-ABORT] ${new Date().toISOString()} client disconnected while waiting for ${toolName ? 'tool "' + toolName + '"' : msg.method} (id: ${msg.id}) after ${fmtDuration(Date.now() - startedAt)}\n`);
          }
        });
        if (msg && msg.method === 'initialize') {
          const info = (msg.params && msg.params.clientInfo) || {};
          appendRequestLog(`[CLIENT] ${new Date().toISOString()} initialize from ${info.name || 'unknown client'} ${info.version || ''} (protocol ${(msg.params && msg.params.protocolVersion) || '?'}; UA "${clientLabel(req)}")\n`);
        }

        let streamKeepAlive = null;
        if (streamReply) {
          if (req.socket) req.socket.setNoDelay(true);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          // Flush Cloudflare's proxy buffer so keepalives reach the client.
          res.write(`: ${' '.repeat(2048)}\n\n`);
          streamKeepAlive = setInterval(() => {
            try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(streamKeepAlive); }
          }, 15000);
          res.on('close', () => clearInterval(streamKeepAlive));
        }

        let response;
        try {
          response = await processJsonRpcMessage(msg);
        } catch (err) {
          response = msg && msg.id !== undefined
            ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Internal error: ${err.message}` } }
            : null;
        }

        const isErr = response && response.result && response.result.isError;
        const status = response ? (isErr ? 'TOOL-ERROR' : 'OK') + (streamReply ? ' (sse)' : '') : '204';
        const rpcLog = `[MCP-RPC] ${new Date().toISOString()} method: ${(msg && msg.method) || 'unknown'}${toolName ? ' "' + toolName + '"' : ''} (id: ${msg && msg.id}) -> response: ${status} in ${fmtDuration(Date.now() - startedAt)}${clientGone ? ' [client already gone]' : ''}\n`;
        appendRequestLog(rpcLog);

        if (streamReply) {
          clearInterval(streamKeepAlive);
          if (!res.writableEnded && !res.destroyed) {
            res.end(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
          }
          return;
        }

        if (response) {
          if (isLegacySseSession) sendToSse(sessionId, response);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } else {
          res.writeHead(204);
          res.end();
        }
      });
      return;
    }

    const notFound = `[404-NOT-FOUND] ${new Date().toISOString()} ${req.method} ${url.pathname}\n`;
    appendRequestLog(notFound);

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found. Use /mcp' }));
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.timeout = 120000;
  server.maxHeadersCount = 2000;

  const listenHost = process.env.BRIDGE_HOST || '127.0.0.1';
  server.listen(port, listenHost, () => {
    logInfo(`Bridge MCP listening on ${listenHost}:${port}`);
    if (process.connected) process.send({ type: 'http-ready', port }, () => {});
  });
}

// ==========================================
// 7. Stdio Transport
// ==========================================

function startStdioServer() {
  logInfo(`Starting Stdio Bridge Server...`);
  logInfo(`Current Sandboxed Folder: ${rootDir}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const msg = JSON.parse(trimmed);
      const response = await processJsonRpcMessage(msg);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (e) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      }) + '\n');
    }
  });
}

// ==========================================
// 8. Launch
// ==========================================

if (httpPort) {
  startHttpServer(httpPort);
} else {
  startStdioServer();
}
