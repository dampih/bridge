'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const bridgeScript = path.join(__dirname, '..', 'bridge.js');

function status(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('request timed out')));
  });
}

function runBridge(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgeScript, '--no-animation', ...args], {
      cwd: path.dirname(bridgeScript),
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, signal: 'TIMEOUT', stderr: `${stderr}\nBridge startup timed out` });
    }, 10000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

test('rejects invalid --port values before startup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-cli-port-'));
  try {
    for (const value of ['0', '65536', '12abc', '']) {
      const args = value ? [directory, '--port', value] : [directory, '--port'];
      const result = await runBridge(args, { ...process.env });
      assert.equal(result.code, 1, `expected --port ${JSON.stringify(value)} to fail`);
      assert.match(result.stderr, /Invalid --port value/);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('does not stop an existing listener when an explicit port is requested', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-cli-port-'));
  const owner = spawn(process.execPath, ['-e', `const s=require('node:http').createServer((q,r)=>{r.writeHead(404);r.end()});s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port)+'\\n')});setInterval(()=>{},1000)`], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  });
  let output = '';
  owner.stdout.setEncoding('utf8');
  owner.stdout.on('data', chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 5000;
    while (!output.includes('\n')) {
      assert.ok(Date.now() < deadline, 'Listener process did not report its port');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const port = Number(output.trim());
    const result = await runBridge([directory, '--port', String(port)], { ...process.env });
    assert.equal(result.code, 1, `${result.signal}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`Port ${port} is unavailable`));
    assert.equal(owner.exitCode, null, 'Existing listener process must stay alive');
    assert.equal(await status(port), 404);
  } finally {
    if (owner.exitCode === null) owner.kill('SIGKILL');
    await new Promise(resolve => owner.once('close', resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
