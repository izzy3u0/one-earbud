'use strict';
// OAuth has its own state/table. Never reads or writes the NetEase login row.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { poolOptions } = require('./music/postgres-auth');
const AAD = Buffer.from('one-earbud:oauth-state:v1');
const empty = () => ({ clients: {}, tokens: {} });
function stateFile(dataDir) {
  return path.join(dataDir || process.env.ONE_EARBUD_DATA_DIR || path.join(__dirname, '..', 'data'), 'oauth-state.json');
}
function storageError(config = false) {
  const error = new Error(config ? 'OAuth storage configuration is invalid' : 'OAuth storage temporarily unavailable');
  error.code = config ? 'OAUTH_STORAGE_CONFIG' : 'OAUTH_STORAGE_UNAVAILABLE';
  error.status = 503;
  return error;
}
function readFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return empty(); throw storageError(); }
}
function createFileOAuthStore({ dataDir } = {}) {
  const file = stateFile(dataDir);
  let pending = Promise.resolve();
  return {
    async read(fn) { await pending; return fn(readFile(file)); },
    change(fn) {
      const task = pending.then(() => {
        const state = readFile(file), result = fn(state);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp-' + crypto.randomBytes(12).toString('hex');
        try {
          fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
          fs.renameSync(tmp, file);
          try { fs.chmodSync(file, 0o600); } catch (_) {}
        } catch (_) { throw storageError(); }
        return result;
      });
      pending = task.catch(() => {});
      return task;
    },
    async close() { await pending; }
  };
}
async function createPostgresOAuthStore(options = {}) {
  if (typeof options.encryptionKey !== 'string' || options.encryptionKey.length < 32) throw storageError(true);
  let config;
  try { config = poolOptions(options.connectionString); } catch (_) { throw storageError(true); }
  const pool = options.pool || new (require('pg').Pool)(config);
  pool.on('error', () => {}); // Never log pg errors: they can contain credentials.
  const key = crypto.createHash('sha256').update(options.encryptionKey).digest();
  function encrypt(state) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }
  function decrypt(payload) {
    try {
      const [version, iv, tag, data, extra] = String(payload).split('.');
      if (version !== 'v1' || extra !== undefined) throw new Error();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
      if (!state || typeof state.clients !== 'object' || !state.clients || typeof state.tokens !== 'object' || !state.tokens) throw new Error();
      return state;
    } catch (_) { throw storageError(); }
  }
  async function query(connection, sql, args) {
    try { return await connection.query(sql, args); } catch (_) { throw storageError(); }
  }
  const select = 'SELECT payload FROM one_earbud_oauth_state WHERE id = $1';
  try {
    await query(pool, 'CREATE TABLE IF NOT EXISTS one_earbud_oauth_state (id text PRIMARY KEY, payload text NOT NULL)');
    const found = await query(pool, select, ['oauth']);
    if (!found.rows.length) {
      await query(pool, 'INSERT INTO one_earbud_oauth_state (id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', ['oauth', encrypt(readFile(stateFile(options.dataDir)))]);
    }
    // Validate before listening; a broken DB/key must not silently erase registrations.
    decrypt((await query(pool, select, ['oauth'])).rows[0]?.payload);
    fs.rmSync(stateFile(options.dataDir), { force: true });
  } catch (_) { await pool.end().catch(() => {}); throw storageError(); }
  return {
    async read(fn) {
      const result = await query(pool, select, ['oauth']);
      return fn(decrypt(result.rows[0]?.payload));
    },
    async change(fn) {
      let connection;
      try { connection = await pool.connect(); } catch (_) { throw storageError(); }
      try {
        await query(connection, 'BEGIN');
        // Locks cover read/consume/issue/commit, including overlapping deploy processes.
        const result = await query(connection, select + ' FOR UPDATE', ['oauth']);
        const state = decrypt(result.rows[0]?.payload), value = fn(state);
        await query(connection, 'UPDATE one_earbud_oauth_state SET payload = $1 WHERE id = $2', [encrypt(state), 'oauth']);
        await query(connection, 'COMMIT');
        return value;
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { connection.release(); }
    },
    async close() { await pool.end(); }
  };
}
async function prepareOAuthStore(env = process.env, options = {}) {
  if (!env.ONE_EARBUD_AUTH_DATABASE_URL) return createFileOAuthStore(options);
  return createPostgresOAuthStore({ ...options, connectionString: env.ONE_EARBUD_AUTH_DATABASE_URL, encryptionKey: env.ONE_EARBUD_AUTH_ENCRYPTION_KEY });
}
module.exports = { createFileOAuthStore, createPostgresOAuthStore, prepareOAuthStore };
