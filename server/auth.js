'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const hash = value => createHash('sha256').update(String(value)).digest();
function tokenMatches(got, expected) {
  return Boolean(expected && got) && timingSafeEqual(hash(got), hash(expected));
}
function bearer(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  return match ? match[1] : '';
}
module.exports = { tokenMatches, bearer };
