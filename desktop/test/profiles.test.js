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
  const expected = { id: saved.id, name: 'Frontend', folder, port: 3101 };
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, profiles: [expected] });
  store = new ProfileStore(file);
  assert.deepEqual(store.get(saved.id), expected);
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
