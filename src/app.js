'use strict';

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { createAuth } = require('./auth');
const { formatPrice } = require('./validate');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const ROOT = path.join(__dirname, '..');

/**
 * @param {object} config
 * @param {ReturnType<import('./db').openDatabase>} config.store
 * @param {string} config.adminPassword
 * @param {string} config.sessionSecret
 * @param {string} [config.publicUrl]  Base URL encoded in QR codes, e.g. https://menu.example.com
 * @param {boolean|number|string} [config.trustProxy]
 */
function createApp(config) {
  const { store } = config;
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));

  const publicUrl = config.publicUrl ? config.publicUrl.replace(/\/+$/, '') : '';
  const secureCookies = publicUrl.startsWith('https://');
  const auth = createAuth({ adminPassword: config.adminPassword, secureCookies });

  /** Absolute URL customers reach after scanning a menu's QR code. */
  app.locals.menuUrl = (req, menu) => {
    const base = publicUrl || `${req.protocol}://${req.host}`;
    return `${base}/m/${menu.code}`;
  };
  app.locals.formatPrice = formatPrice;
  app.locals.formatDate = (iso) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
        "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));
  app.use(cookieParser(config.sessionSecret));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(auth.sessionMiddleware);

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.redirect('/admin'));

  app.use(publicRoutes({ store }));
  app.use('/admin', adminRoutes({ store, auth }));

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Page not found',
      message: "We couldn't find that page.",
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'This menu is too large to save.' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'The request was not valid JSON.' });
    }
    console.error(err);
    if (req.path.startsWith('/admin/api/')) {
      return res.status(500).json({ error: 'Something went wrong on the server.' });
    }
    res.status(500).render('error', {
      title: 'Something went wrong',
      message: 'Please try again in a moment.',
    });
  });

  return app;
}

module.exports = { createApp };
