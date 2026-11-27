'use strict';

const express = require('express');
const QRCode = require('qrcode');

const { validateMenu, validateTitle, ValidationError, LIMITS } = require('../validate');

const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 2 };

/** Only allow redirects back into the admin area after login. */
function safeNext(value) {
  return typeof value === 'string' && /^\/admin(\/|$|\?)/.test(value) && !value.startsWith('//')
    ? value
    : '/admin';
}

function isLocalHost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' ||
      hostname.startsWith('127.') || hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

module.exports = function adminRoutes({ store, auth }) {
  const router = express.Router();

  // ---- Login / logout (no session required) -------------------------------

  router.get('/login', (req, res) => {
    if (res.locals.isAdmin) return res.redirect(safeNext(req.query.next));
    res.render('admin/login', { error: null, next: safeNext(req.query.next) });
  });

  router.post('/login', (req, res) => {
    const next = safeNext(req.body?.next);
    const error = auth.attemptLogin(req, res, req.body?.password);
    if (error) return res.status(401).render('admin/login', { error, next });
    res.redirect(next);
  });

  router.post('/logout', (req, res) => {
    auth.endSession(req, res);
    res.redirect('/admin/login');
  });

  // ---- Everything below requires a signed-in admin ------------------------

  router.use(auth.requireAdmin);

  // Lets the editor pick up a fresh CSRF token after the admin signs in again.
  router.get('/api/session', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ csrfToken: res.locals.csrfToken });
  });

  /** Loads the menu named by :id into req.menu, or renders 404. */
  function loadMenu(req, res, next) {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    const menu = Number.isSafeInteger(id) ? store.getMenuById(id) : null;
    if (!menu) {
      if (req.originalUrl.startsWith('/admin/api/')) {
        return res.status(404).json({ error: 'This menu no longer exists.' });
      }
      return res.status(404).render('error', {
        title: 'Menu not found',
        message: 'This menu may have been deleted.',
      });
    }
    req.menu = menu;
    next();
  }

  function renderDashboard(res, { status = 200, error = null, notice = null } = {}) {
    res.status(status).render('admin/dashboard', {
      menus: store.listMenus(),
      error,
      notice,
      limits: LIMITS,
    });
  }

  router.get('/', (req, res) => {
    const notices = { deleted: 'Menu deleted.' };
    renderDashboard(res, { notice: notices[req.query.notice] ?? null });
  });

  router.post('/menus', (req, res) => {
    let title;
    try {
      title = validateTitle(req.body?.title);
    } catch (err) {
      if (err instanceof ValidationError) {
        return renderDashboard(res, { status: 400, error: err.message });
      }
      throw err;
    }
    const menu = store.createMenu({ title });
    res.redirect(`/admin/menus/${menu.id}`);
  });

  // ---- Editor ---------------------------------------------------------------

  router.get('/menus/:id', loadMenu, (req, res) => {
    res.render('admin/editor', {
      menu: req.menu,
      menuUrl: req.app.locals.menuUrl(req, req.menu),
      limits: LIMITS,
    });
  });

  router.get('/api/menus/:id', loadMenu, (req, res) => {
    res.json({ menu: req.menu });
  });

  router.put('/api/menus/:id', loadMenu, (req, res) => {
    let data;
    try {
      data = validateMenu(req.body?.menu);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
    const result = store.saveMenu(req.menu.id, data, req.body.updatedAt);
    if (result.notFound) return res.status(404).json({ error: 'This menu no longer exists.' });
    if (result.conflict) {
      return res.status(409).json({
        error: 'This menu was changed somewhere else (another tab or another admin) ' +
          'since you opened it. Reload to get the latest version.',
        menu: result.menu,
      });
    }
    res.json({ menu: result.menu });
  });

  router.post('/menus/:id/duplicate', loadMenu, (req, res) => {
    const suffix = ' (copy)';
    const copy = store.createMenu({
      ...req.menu,
      title: req.menu.title.slice(0, LIMITS.title - suffix.length) + suffix,
      published: false,
    });
    res.redirect(`/admin/menus/${copy.id}`);
  });

  router.post('/menus/:id/delete', loadMenu, (req, res) => {
    store.deleteMenu(req.menu.id);
    res.redirect('/admin?notice=deleted');
  });

  // ---- QR codes ---------------------------------------------------------------

  router.get('/menus/:id/qr', loadMenu, async (req, res) => {
    const menuUrl = req.app.locals.menuUrl(req, req.menu);
    const svg = await QRCode.toString(menuUrl, { ...QR_OPTIONS, type: 'svg' });
    res.render('admin/qr', {
      menu: req.menu,
      menuUrl,
      svg,
      localOnly: isLocalHost(menuUrl),
    });
  });

  router.get('/menus/:id/qr.svg', loadMenu, async (req, res) => {
    const svg = await QRCode.toString(req.app.locals.menuUrl(req, req.menu), {
      ...QR_OPTIONS,
      type: 'svg',
    });
    if (req.query.download) res.attachment(`menu-${req.menu.code}-qr.svg`);
    res.type('image/svg+xml').send(svg);
  });

  router.get('/menus/:id/qr.png', loadMenu, async (req, res) => {
    const png = await QRCode.toBuffer(req.app.locals.menuUrl(req, req.menu), {
      ...QR_OPTIONS,
      type: 'png',
      width: 1024,
    });
    if (req.query.download) res.attachment(`menu-${req.menu.code}-qr.png`);
    res.type('image/png').send(png);
  });

  router.get('/menus/:id/print', loadMenu, async (req, res) => {
    const menuUrl = req.app.locals.menuUrl(req, req.menu);
    const svg = await QRCode.toString(menuUrl, { ...QR_OPTIONS, type: 'svg' });
    const layout = req.query.layout === 'grid' ? 'grid' : 'single';
    res.render('admin/print', { menu: req.menu, menuUrl, svg, layout });
  });

  return router;
};
