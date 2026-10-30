'use strict';
// A short-lived command, not listening history. The persisted queue remains authoritative.
const { randomUUID } = require('node:crypto');
const COMMAND_TTL_MS = 3 * 60 * 1000;
function createPlaybackSync({ now = Date.now } = {}) {
  let command = null;
  return {
    publish(itemId) {
      command = { id: randomUUID(), itemId, at: now(), expiresAt: now() + COMMAND_TTL_MS };
      return { ...command, status: 'pending' };
    },
    current(queue) {
      if (!command || now() > command.expiresAt || queue.currentId !== command.itemId) return null;
      return { ...command };
    }
  };
}
module.exports = { createPlaybackSync, COMMAND_TTL_MS };
