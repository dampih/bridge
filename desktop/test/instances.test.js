'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { InstanceManager } = require('../instances');

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(20);
  }
  throw new Error('Timed out waiting for an instance update');
}

async function listener() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function localUrl(port, route) { return `http://127.0.0.1:${port}${route}`; }

test('an unconfirmed mode change stops only the affected instance', async () => {
  const manager = new InstanceManager();
  const instance = {
    id: 'a', token: 'test-secret', status: 'online', approvalMode: 'review', logs: [], approvals: new Map(),
    server: {
      child: { connected: true, send(_message, callback) { callback(new Error('IPC closed')); } },
      closed: Promise.resolve()
    }
  };
  manager.instances.set(instance.id, instance);
  manager.instances.set('b', { id: 'b', status: 'online', logs: [], approvals: new Map(), approvalMode: 'review' });
  await assert.rejects(manager.setApprovalMode({ instanceId: 'a', mode: 'turbo' }), /did not confirm/);
  await instance.stopping;
  assert.equal(instance.status, 'failed');
  assert.equal(instance.approvalMode, 'review');
  assert.equal(manager.instances.get('b').status, 'online');
});

test('desktop manages two isolated MCP servers, approvals, conflicts and shutdown', { timeout: 20000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-desktop-'));
  const folders = await Promise.all(['project-a', 'project-b'].map(async name => {
    const folder = path.join(home, name);
    await fs.mkdir(folder);
    return fs.realpath(folder);
  }));
  const tunnels = [];
  const env = { ...process.env };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const approvalEvents = [];
  const namedTunnel = { publicUrl: 'https://frontend.example.com', connectorToken: 'test-connector-secret', mcpToken: 'a'.repeat(48) };
  const manager = new InstanceManager({
    onApproval: target => approvalEvents.push(target),
    resolveTunnel: () => 'mock-cloudflared',
    startTunnel(binary, args, connectorToken) {
      assert.equal(binary, 'mock-cloudflared');
      assert.equal(connectorToken, args.at(-1) === 'run' ? namedTunnel.connectorToken : undefined);
      const script = connectorToken
        ? `console.log(process.env.TEST_CONNECTOR); process.stdin.once('data', () => console.log('INF Registered tunnel connection'));`
        : `console.log('https://test-quick.trycloudflare.com'); setInterval(() => {}, 1000)`;
      const child = spawn(process.execPath, ['-e', script], {
        env: { ...process.env, TEST_CONNECTOR: connectorToken ?? '' }, stdio: ['pipe', 'pipe', 'pipe']
      });
      tunnels.push({ args, child, closed: once(child, 'close') });
      return child;
    }
  });
  const reservations = await Promise.all([listener(), listener(), listener()]);
  t.after(async () => {
    await manager.shutdown();
    for (const server of reservations) if (server.listening) await close(server);
    for (const key of ['HOME', 'USERPROFILE']) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    await fs.rm(home, { recursive: true, force: true });
  });
  const [portA, portB, busyPort] = reservations.map(server => server.address().port);
  await Promise.all(reservations.slice(0, 2).map(close));
  const get = id => manager.list().find(item => item.id === id);
  const online = async id => waitFor(() => {
    const item = get(id);
    assert.notEqual(item.status, 'failed', JSON.stringify(item));
    return item.status === 'online' && item;
  });
  assert.throws(() => manager.start({ folder: folders[0], port: 0 }), /1 to 65535/);
  const namedOptions = { folder: folders[0], port: portA, profileName: 'Frontend', namedTunnel };
  const a = manager.start(namedOptions);
  assert.throws(() => manager.start({ ...namedOptions, port: portB }), /named tunnel or hostname is already in use/);
  assert.throws(() => manager.start({ folder: folders[1], port: portA }), /already assigned/);
  const b = manager.start({ folder: folders[1], port: portB });
  const busy = manager.start({ folder: folders[0], port: busyPort });
  const namedChild = await waitFor(() => tunnels.find(item => item.args.at(-1) === 'run'));
  assert.equal(get(a).status, 'starting-tunnel');
  assert.throws(() => manager.urlForCopy(a), /does not have an active URL/);
  namedChild.child.stdin.write('register');
  await Promise.all([online(a), online(b), waitFor(() => get(busy).status === 'failed')]);
  assert.equal(get(a).tunnelMode, 'named');
  assert.ok(get(a).logs.some(line => line.includes('[REDACTED]')));
  assert.ok(!JSON.stringify(manager.list()).includes(namedTunnel.connectorToken));
  assert.equal(get(a).profileName, 'Frontend');
  assert.equal(get(a).approvalMode, 'review');
  assert.equal(get(b).approvalMode, 'review');
  assert.throws(() => manager.setApprovalMode({ instanceId: a, mode: 'invalid' }), /Invalid approval mode/);
  assert.match(get(busy).error, /already in use/);
  assert.ok(reservations[2].listening);
  assert.deepEqual(namedChild.args, ['tunnel', '--no-autoupdate', 'run']);
  assert.deepEqual(tunnels.map(({ args }) => args.at(-1)).sort(), [localUrl(portB, ''), 'run']);
  const urlA = new URL(manager.urlForCopy(a));
  const urlB = new URL(manager.urlForCopy(b));
  const tokenA = urlA.searchParams.get('token');
  const tokenB = urlB.searchParams.get('token');
  assert.equal(urlA.origin, namedTunnel.publicUrl);
  assert.equal(tokenA, namedTunnel.mcpToken);
  assert.notEqual(urlA.origin, urlB.origin);
  assert.match(tokenA, /^[a-f0-9]{48}$/);
  assert.match(tokenB, /^[a-f0-9]{48}$/);
  assert.notEqual(tokenA, tokenB);
  const auth = token => ({ Authorization: `Bearer ${token}` });
  const status = (port, token) => fetch(localUrl(port, '/api/status'), { headers: auth(token), signal: AbortSignal.timeout(3000) });
  assert.equal((await status(portB, tokenA)).status, 401);
  assert.equal((await status(portB, tokenB)).status, 200);

  function write(port, token, id, file = 'hello.txt') {
    return fetch(localUrl(port, '/mcp'), {
      method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'write_file', arguments: { path: file, content: 'Hello' } } })
    }).then(response => response.json());
  }
  const writeResults = Promise.all([write(portA, tokenA, 1), write(portB, tokenB, 2)]);
  // Attach immediately while waiting for both servers' approval notices.
  writeResults.catch(() => {});
  const [approvalA, approvalB] = await Promise.all([a, b].map(id => waitFor(() => get(id).approvals[0])));
  assert.equal(approvalA.id, approvalB.id, 'Approval IDs are scoped to each server');
  assert.deepEqual(approvalEvents.sort((x, y) => x.port - y.port), [
    { instanceId: a, requestId: approvalA.id, port: portA },
    { instanceId: b, requestId: approvalB.id, port: portB }
  ].sort((x, y) => x.port - y.port));
  await manager.setApprovalMode({ instanceId: a, mode: 'default' });
  assert.equal(get(a).approvalMode, 'default');
  assert.equal(get(b).approvalMode, 'review');
  assert.equal(get(a).approvals[0].id, approvalA.id);
  assert.equal(get(b).approvals[0].id, approvalB.id);
  await assert.rejects(fs.access(path.join(folders[0], 'hello.txt')), { code: 'ENOENT' });
  await write(portA, tokenA, 3, 'default.txt');
  assert.equal(await fs.readFile(path.join(folders[0], 'default.txt'), 'utf8'), 'Hello');
  await manager.answerApproval({ instanceId: a, requestId: approvalA.id, approved: true });
  await manager.answerApproval({ instanceId: b, requestId: approvalB.id, approved: false });
  await writeResults;
  assert.equal(await fs.readFile(path.join(folders[0], 'hello.txt'), 'utf8'), 'Hello');
  await assert.rejects(fs.access(path.join(folders[1], 'hello.txt')), { code: 'ENOENT' });

  async function expectReview(id, port, token, rpcId) {
    const pending = write(port, token, rpcId, 'review.txt');
    pending.catch(() => {});
    const approval = await waitFor(() => get(id).approvals[0]);
    await manager.answerApproval({ instanceId: id, requestId: approval.id, approved: false });
    await pending;
  }
  await expectReview(b, portB, tokenB, 4);
  await manager.setApprovalMode({ instanceId: a, mode: 'review' });
  assert.equal(get(a).approvalMode, 'review');
  await expectReview(a, portA, tokenA, 5);

  await fetch(localUrl(portA, `/api/status?token=${tokenA}`), { signal: AbortSignal.timeout(3000) });
  assert.ok(!JSON.stringify(manager.list()).includes(tokenA));
  assert.ok(!JSON.stringify(manager.list()).includes(tokenB));
  assert.ok(!(await fs.readFile(path.join(home, '.bridge', 'logs', 'server_requests.log'), 'utf8')).includes(tokenA));
  await manager.stop(a);
  assert.equal(get(a).status, 'stopped');
  assert.equal((await status(portB, tokenB)).status, 200);
  const restarted = manager.start(namedOptions);
  const restartChild = await waitFor(() => tunnels.find(item => item !== namedChild && item.args.at(-1) === 'run'));
  restartChild.child.stdin.write('register');
  await online(restarted);
  assert.equal(manager.urlForCopy(restarted), urlA.href);
  await manager.shutdown();
  assert.equal(get(restarted).status, 'stopped');
  assert.equal(get(b).status, 'stopped');
  await Promise.all(tunnels.map(tunnel => tunnel.closed));
  await assert.rejects(status(portB, tokenB));
  assert.ok(reservations[2].listening);
});
