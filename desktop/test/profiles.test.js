'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProfileStore } = require('../profiles');

test('profiles persist only name, folder, and port and support editing and deletion', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-profiles-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const folder = path.join(directory, 'project');
  fs.mkdirSync(folder);
  const file = path.join(directory, 'userData', 'project-profiles.json');
  let store = new ProfileStore(file);
  const allowed = value => value === folder;
  assert.deepEqual(store.list(), []);
  const input = { name: ' Frontend ', folder, port: 3101, token: 'secret', url: 'secret', approvalMode: 'turbo' };
  assert.throws(() => store.save(input, () => false), /Choose a project folder/);
  assert.throws(() => store.save({ ...input, port: 0 }, allowed), /1 to 65535/);
  assert.throws(() => store.save({ ...input, name: ' ' }, allowed), /profile name/);
  const [saved] = store.save(input, allowed);
  const legacy = { id: saved.id, name: 'Frontend', folder, port: 3101 };
  const expected = { ...legacy, tunnelMode: 'quick', hasConnectorToken: false };
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, profiles: [{ ...legacy, tunnelMode: 'quick' }] });
  fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: [legacy] }));
  store = new ProfileStore(file);
  assert.deepEqual(store.list(), [expected]);
  assert.deepEqual(store.forStart(saved.id), { folder, port: 3101, profileName: 'Frontend' });
  assert.throws(() => store.save({ ...saved, folder: directory }, allowed), /Choose a project folder/);
  assert.deepEqual(store.save({ ...saved, name: 'Web', port: 3102 }, () => false), [{ ...expected, name: 'Web', port: 3102 }]);
  fs.rmdirSync(folder);
  assert.equal(store.get(saved.id).folder, folder, 'Loading preserves a missing folder so it can be corrected');
  assert.throws(() => store.save({ ...input, name: 'Missing' }, allowed), /existing project folder/);
  assert.deepEqual(store.delete(saved.id), []);
  assert.throws(() => store.get(saved.id), /no longer exists/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);

  fs.writeFileSync(file, '{invalid');
  assert.throws(() => store.save(input, allowed), /left unchanged/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
});

test('named credentials stay encrypted and stable across reload and connector replacement', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-named-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const file = path.join(directory, 'profiles.json');
  const vault = new Map();
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString(secret) {
      const key = `ciphertext-${vault.size}`;
      vault.set(key, secret);
      return Buffer.from(key);
    },
    decryptString(ciphertext) { return vault.get(ciphertext.toString()); }
  };
  const store = new ProfileStore(file, storage);
  const input = { name: 'Site', folder: directory, port: 3101, tunnelMode: 'named',
    publicUrl: 'https://MCP.example.com/', connectorToken: 'connector-secret' };
  const allow = () => true;
  for (const publicUrl of ['http://mcp.example.com', 'https://mcp.example.com/path', 'https://mcp.example.com?',
    'https://user@mcp.example.com', 'https://mcp.example.com:443', 'https://127.0.0.1']) {
    assert.throws(() => store.save({ ...input, publicUrl }, allow), /HTTPS public hostname/);
  }
  assert.throws(() => new ProfileStore(file).save(input, allow), /Secure credential storage/);
  if (process.platform === 'linux') {
    assert.throws(() => new ProfileStore(file, { ...storage, getSelectedStorageBackend: () => 'basic_text' }).save(input, allow), /Secure credential storage/);
  }
  assert.throws(() => store.save({ ...input, connectorToken: '' }, allow), /Enter a Cloudflare/);
  const [saved] = store.save(input, allow);
  const reload = new ProfileStore(file, storage);
  const first = reload.forStart(saved.id).namedTunnel;
  assert.equal(first.publicUrl, 'https://mcp.example.com');
  assert.equal(first.connectorToken, input.connectorToken);
  assert.match(first.mcpToken, /^[a-f0-9]{48}$/);
  for (const serialized of [fs.readFileSync(file, 'utf8'), JSON.stringify(reload.list()), JSON.stringify(saved)]) {
    assert.ok(!serialized.includes(first.connectorToken));
    assert.ok(!serialized.includes(first.mcpToken));
  }
  assert.ok(!JSON.stringify(saved).includes('credentials'));
  assert.equal(saved.hasConnectorToken, true);
  reload.save({ ...saved, name: 'Renamed' }, allow);
  assert.deepEqual(reload.forStart(saved.id).namedTunnel, first);
  reload.save({ ...saved, connectorToken: 'replacement-secret' }, allow);
  assert.deepEqual(reload.forStart(saved.id).namedTunnel, { ...first, connectorToken: 'replacement-secret' });
  const broken = new ProfileStore(file, { ...storage, decryptString() { throw new Error('bad key'); } });
  assert.throws(() => broken.forStart(saved.id), /Could not decrypt/);
  assert.equal(broken.list()[0].hasConnectorToken, true);
  const [quick] = broken.save({ ...saved, tunnelMode: 'quick' }, allow);
  assert.equal(quick.hasConnectorToken, false);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('credentials'));
});
