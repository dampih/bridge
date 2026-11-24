'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function profileFields({ name, folder, port }) {
  name = typeof name === 'string' ? name.trim() : '';
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Enter a profile name of 1 to 60 characters.');
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.includes('\0')) throw new Error('Choose a project folder.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port from 1 to 65535.');
  return { name, folder, port };
}

class ProfileStore {
  constructor(file) { this.file = file; }

  list() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    try {
      const data = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.profiles)) throw new Error();
      const ids = new Set();
      return data.profiles.map(record => {
        if (typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id) || ids.has(record.id)) throw new Error();
        ids.add(record.id);
        return { id: record.id, ...profileFields(record) };
      });
    } catch {
      throw new Error('Saved profiles could not be read. The profiles file was left unchanged.');
    }
  }

  get(id) {
    const profile = this.list().find(item => item.id === id);
    if (!profile) throw new Error('This project profile no longer exists.');
    return profile;
  }

  save(data, folderAllowed) {
    const profiles = this.list();
    const index = data?.id === undefined ? -1 : profiles.findIndex(item => item.id === data.id);
    if (data?.id !== undefined && index < 0) throw new Error('This project profile no longer exists.');
    const fields = profileFields(data ?? {});
    if (fields.folder !== profiles[index]?.folder) {
      if (!folderAllowed(fields.folder)) throw new Error('Choose a project folder first.');
      if (!fs.statSync(fields.folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Choose an existing project folder.');
    }
    const profile = { id: profiles[index]?.id ?? randomUUID(), ...fields };
    if (index < 0) profiles.push(profile);
    else profiles[index] = profile;
    return this.write(profiles);
  }

  delete(id) {
    const profiles = this.list();
    const remaining = profiles.filter(item => item.id !== id);
    return remaining.length === profiles.length ? profiles : this.write(remaining);
  }

  write(profiles) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, profiles }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return profiles;
  }
}

module.exports = { ProfileStore };
