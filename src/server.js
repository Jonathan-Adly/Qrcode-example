'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const { openDatabase } = require('./db');
const { createApp } = require('./app');

const env = process.env;
const port = Number(env.PORT) || 3000;
const dataDir = env.DATA_DIR || path.join(__dirname, '..', 'data');
const isProduction = env.NODE_ENV === 'production';

let adminPassword = env.ADMIN_PASSWORD;
if (!adminPassword) {
  if (isProduction) {
    console.error('ADMIN_PASSWORD must be set when NODE_ENV=production.');
    process.exit(1);
  }
  adminPassword = crypto.randomBytes(9).toString('base64url');
  console.warn(
    `\n  ADMIN_PASSWORD is not set. Using a temporary password for this run:\n\n` +
    `      ${adminPassword}\n\n` +
    `  Set ADMIN_PASSWORD to choose your own (it will change on every restart until you do).\n`);
}

let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProduction) {
    console.warn('SESSION_SECRET is not set; admins will be signed out whenever the server restarts.');
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
}

let trustProxy = env.TRUST_PROXY;
if (trustProxy === 'true') trustProxy = true;
else if (/^\d+$/.test(trustProxy ?? '')) trustProxy = Number(trustProxy);

const store = openDatabase(path.join(dataDir, 'menus.db'));
const app = createApp({
  store,
  adminPassword,
  sessionSecret,
  publicUrl: env.PUBLIC_URL,
  trustProxy,
});

const server = app.listen(port, () => {
  console.log(`QR Menu running at http://localhost:${port}`);
  console.log(`Admin panel:        http://localhost:${port}/admin`);
  if (!env.PUBLIC_URL) {
    console.log('Tip: set PUBLIC_URL to the address customers will use, so QR codes point there.');
  }
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
