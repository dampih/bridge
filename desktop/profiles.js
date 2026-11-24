'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');

function profileFields({ name, folder, port }) {
  name = typeof name === 'string' ? name.trim() : '';
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Enter a profile name of 1 to 60 characters.');
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.includes('\0')) throw new Error('Choose a project folder.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port from 1 to 65535.');
  return { name, folder, port };
}

function namedOrigin(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^https:\/\/[a-z0-9.-]+\/?$/i.test(text)) {
    const url = URL.parse(text);
    if (url && url.hostname.split('.').length > 1 &&
        url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
        !/^\d+(?:\.\d+){3}$/.test(url.hostname)) return url.origin;
  }
  throw new Error('Enter an HTTPS public hostname without a port, path, query, or credentials.');
}

function publicProfile({ credentials, ...profile }) {
  return { ...profile, hasConnectorToken: Boolean(credentials?.connector) };
}

class ProfileStore {
  constructor(file, secureStorage) {
    this.file = file;
    this.secureStorage = secureStorage;
  }

  records() {
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
        const profile = { id: record.id, ...profileFields(record), tunnelMode: record.tunnelMode ?? 'quick' };
        if (profile.tunnelMode === 'quick') return profile;
        if (profile.tunnelMode !== 'named') throw new Error();
        const { connector, mcp } = record.credentials ?? {};
        profile.publicUrl = namedOrigin(record.publicUrl);
        profile.credentials = { connector, mcp };
        return profile;
      });
    } catch {
      throw new Error('Saved profiles could not be read. The profiles file was left unchanged.');
    }
  }

  list() { return this.records().map(publicProfile); }

  get(id) {
    const profile = this.records().find(item => item.id === id);
    if (!profile) throw new Error('This project profile no longer exists.');
    return profile;
  }

  requireEncryption() {
    if (!this.secureStorage?.isEncryptionAvailable() ||
        (process.platform === 'linux' && this.secureStorage.getSelectedStorageBackend?.() === 'basic_text')) {
      throw new Error('Secure credential storage is unavailable. Named tunnels require encrypted storage.');
    }
  }

  encrypt(value) {
    try { return this.secureStorage.encryptString(value).toString('base64'); } catch {
      throw new Error('Could not encrypt the named tunnel credentials.');
    }
  }

  decrypt(value, type) {
    try {
      if (typeof value !== 'string' || !value) throw new Error();
      const text = this.secureStorage.decryptString(Buffer.from(value, 'base64'));
      if (type === 'MCP' ? !/^[a-f0-9]{48}$/.test(text) : !/^[A-Za-z0-9+/_=-]{1,4096}$/.test(text)) throw new Error();
      return text;
    } catch {
      throw new Error(type === 'MCP'
        ? 'Could not decrypt the saved MCP token. Restore access to secure storage or recreate this profile to issue a new token.'
        : 'Could not decrypt the saved connector token. Replace it in the project profile.');
    }
  }

  forStart(id) {
    const profile = this.get(id);
    const { folder, port, name: profileName, tunnelMode } = profile;
    if (tunnelMode === 'quick') return { folder, port, profileName };
    this.requireEncryption();
    return { folder, port, profileName, namedTunnel: {
      publicUrl: profile.publicUrl,
      connectorToken: this.decrypt(profile.credentials.connector, 'connector'),
      mcpToken: this.decrypt(profile.credentials.mcp, 'MCP')
    } };
  }

  save(data, folderAllowed) {
    const profiles = this.records();
    const index = data?.id === undefined ? -1 : profiles.findIndex(item => item.id === data.id);
    if (data?.id !== undefined && index < 0) throw new Error('This project profile no longer exists.');
    const previous = profiles[index];
    const fields = profileFields(data ?? {});
    if (fields.folder !== previous?.folder) {
      if (!folderAllowed(fields.folder)) throw new Error('Choose a project folder first.');
      if (!fs.statSync(fields.folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Choose an existing project folder.');
    }
    const tunnelMode = data.tunnelMode ?? previous?.tunnelMode ?? 'quick';
    if (!['quick', 'named'].includes(tunnelMode)) throw new Error('Choose Quick or Named Tunnel.');
    const profile = { id: previous?.id ?? randomUUID(), ...fields, tunnelMode };
    if (tunnelMode === 'named') {
      profile.publicUrl = namedOrigin(data.publicUrl ?? previous?.publicUrl);
      this.requireEncryption();
      const connectorToken = typeof data.connectorToken === 'string' ? data.connectorToken.trim() : '';
      if (connectorToken && !/^[A-Za-z0-9+/_=-]{1,4096}$/.test(connectorToken)) {
        throw new Error('Paste only the Cloudflare connector token, not the installation command.');
      }
      const saved = previous?.credentials;
      if (!connectorToken && !saved?.connector) throw new Error('Enter a Cloudflare connector token.');
      if (!connectorToken) this.decrypt(saved.connector, 'connector');
      if (saved) this.decrypt(saved.mcp, 'MCP');
      profile.credentials = {
        connector: connectorToken ? this.encrypt(connectorToken) : saved.connector,
        mcp: saved ? saved.mcp : this.encrypt(randomBytes(24).toString('hex'))
      };
    }
    if (index < 0) profiles.push(profile);
    else profiles[index] = profile;
    return this.write(profiles);
  }

  delete(id) {
    const profiles = this.records();
    const remaining = profiles.filter(item => item.id !== id);
    return remaining.length === profiles.length ? this.list() : this.write(remaining);
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
    return profiles.map(publicProfile);
  }
}

module.exports = { ProfileStore };
