'use strict';
// Optional durable NetEase auth only. OAuth, queue and heartbeat storage are unchanged.
const crypto = require('node:crypto');
const { publicState, savedState, refreshedState } = require('./store');
const ID = 'netease';
const AAD = Buffer.from('one-earbud:netease-auth:v1');

function storageError(config = false) {
  const error = new Error(config ? '检查 ONE_EARBUD_AUTH_DATABASE_URL 和 ONE_EARBUD_AUTH_ENCRYPTION_KEY 配置' : '网易云登录态存储暂时不可用，请稍后重试');
  error.code = config ? 'MUSIC_AUTH_STORAGE_CONFIG' : 'MUSIC_AUTH_STORAGE_UNAVAILABLE';
  error.status = 503;
  return error;
}
function poolOptions(connectionString) {
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2) throw new Error();
    // pg connection-string SSL options can override ssl.rejectUnauthorized. Always verify TLS.
    for (const name of [...url.searchParams.keys()]) if (/^ssl/i.test(name)) url.searchParams.delete(name);
    return { connectionString: url.toString(), ssl: { rejectUnauthorized: true }, enableChannelBinding: true,
      max: 1, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000, statement_timeout: 15000, query_timeout: 17000 };
  } catch (_) { throw storageError(true); }
}

async function createPostgresAuthStore(options = {}) {
  if (typeof options.encryptionKey !== 'string' || options.encryptionKey.length < 32) throw storageError(true);
  const config = poolOptions(options.connectionString);
  const key = crypto.createHash('sha256').update(options.encryptionKey).digest();
  const pool = options.pool || new (require('pg').Pool)(config);
  // pg emits background idle-connection errors; never print raw errors / connection strings.
  pool.on('error', () => {});
  function encrypt(value) {
    if (!value) return null; // Tombstone: an explicit logout must not resurrect a local copy.
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }
  function decrypt(payload) {
    if (payload === null) return null;
    const [version, iv, tag, data, extra] = String(payload).split('.');
    if (version !== 'v1' || extra !== undefined) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
    if (!value || typeof value.cookie !== 'string' || !value.cookie) throw new Error();
    return value;
  }
  let value, revision;
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS one_earbud_netease_auth (id text PRIMARY KEY, payload text, revision bigint NOT NULL DEFAULT 0)');
    let result = await pool.query('SELECT payload, revision FROM one_earbud_netease_auth WHERE id = $1', [ID]);
    if (!result.rows.length) {
      // Migrate an existing file only once, while it still exists. Never use it as a fallback.
      const local = options.localStore;
      const state = local && local.publicState();
      const initial = local && local.cookie() ? savedState(null, local.cookie(), state.profile, state.vip) : null;
      if (initial && state.connectedAt) initial.connectedAt = state.connectedAt;
      await pool.query('INSERT INTO one_earbud_netease_auth (id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [ID, encrypt(initial)]);
      result = await pool.query('SELECT payload, revision FROM one_earbud_netease_auth WHERE id = $1', [ID]);
    }
    value = decrypt(result.rows[0].payload); revision = String(result.rows[0].revision);
  } catch (_) { await pool.end().catch(() => {}); throw storageError(); }
  // Serialize persistence; do not acknowledge login or a refresh before the durable write succeeds.
  let pending = Promise.resolve();
  function change(makeValue) {
    const task = pending.then(async () => {
      const next = makeValue(value);
      if (next === undefined) return;
      try {
        const result = await pool.query('UPDATE one_earbud_netease_auth SET payload = $1, revision = revision + 1 WHERE id = $2 AND revision = $3 RETURNING revision', [encrypt(next), ID, revision]);
        if (result.rows.length !== 1) {
          // Render can briefly overlap old and new processes during a deploy. Adopt the
          // newer session for subsequent requests, but never overwrite it with this stale write.
          const fresh = await pool.query('SELECT payload, revision FROM one_earbud_netease_auth WHERE id = $1', [ID]);
          const recovered = decrypt(fresh.rows[0].payload);
          value = recovered; revision = String(fresh.rows[0].revision);
          throw new Error();
        }
        value = next; revision = String(result.rows[0].revision);
      } catch (_) { throw storageError(); }
    });
    pending = task.catch(() => {});
    return task;
  }
  return {
    cookie: () => value ? value.cookie : '',
    publicState: () => publicState(value),
    save: (cookie, profile, vip, nowMs) => change(prev => savedState(prev, cookie, profile, vip, nowMs)),
    refreshCookie: (cookie, baseCookie) => change(prev => refreshedState(prev, cookie, baseCookie) || undefined),
    clear: () => change(() => null),
    close: async () => { await pending; await pool.end(); }
  };
}

// Initialize before HTTP starts. A configured but broken database must not silently log out the owner.
async function prepareMusicAuthStore(env = process.env, options = {}) {
  const { createMusicAuthStore } = require('./store');
  const localStore = options.localStore || createMusicAuthStore(options);
  if (!env.ONE_EARBUD_AUTH_DATABASE_URL) return localStore;
  const store = await createPostgresAuthStore({ ...options, localStore, connectionString: env.ONE_EARBUD_AUTH_DATABASE_URL, encryptionKey: env.ONE_EARBUD_AUTH_ENCRYPTION_KEY });
  // After migration, the database is the sole source; remove the obsolete plaintext file.
  localStore.clear();
  return store;
}
module.exports = { createPostgresAuthStore, prepareMusicAuthStore, poolOptions };
