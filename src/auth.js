'use strict';

const crypto = require('node:crypto');

const COOKIE = 'qrmenu_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // one week
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

function safeEqual(a, b) {
  // Hash first so the comparison is constant-time regardless of length.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createAuth({ adminPassword, secureCookies }) {
  const failedLogins = new Map(); // ip -> { count, resetAt }

  // Mark cookies Secure when the site is configured for HTTPS or the request
  // itself arrived over HTTPS (behind a proxy this needs TRUST_PROXY).
  const isSecure = (req) => secureCookies || req.secure;

  function readSession(req) {
    const raw = req.signedCookies?.[COOKIE];
    if (!raw) return null;
    try {
      const session = JSON.parse(raw);
      if (typeof session.exp !== 'number' || session.exp < Date.now()) return null;
      if (typeof session.csrf !== 'string') return null;
      return session;
    } catch {
      return null;
    }
  }

  function startSession(req, res) {
    const session = {
      exp: Date.now() + SESSION_TTL_MS,
      csrf: crypto.randomBytes(24).toString('base64url'),
    };
    res.cookie(COOKIE, JSON.stringify(session), {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure(req),
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  function endSession(req, res) {
    res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: isSecure(req) });
  }

  /** Makes req.session / res.locals.csrfToken available to every request. */
  function sessionMiddleware(req, res, next) {
    req.session = readSession(req);
    res.locals.isAdmin = Boolean(req.session);
    res.locals.csrfToken = req.session?.csrf ?? '';
    next();
  }

  /** Requires a logged-in admin and a valid CSRF token on state-changing requests. */
  function requireAdmin(req, res, next) {
    const isApi = req.originalUrl.startsWith('/admin/api/');
    if (!req.session) {
      if (isApi) {
        return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      }
      const nextUrl = req.method === 'GET' ? req.originalUrl : '/admin';
      return res.redirect(`/admin/login?next=${encodeURIComponent(nextUrl)}`);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const token = req.get('x-csrf-token') || req.body?._csrf;
      if (!token || !safeEqual(token, req.session.csrf)) {
        const message = 'Security check failed. Reload the page and try again.';
        if (isApi) return res.status(403).json({ error: message });
        return res.status(403).render('error', { title: 'Request blocked', message });
      }
    }
    next();
  }

  function isThrottled(ip) {
    const entry = failedLogins.get(ip);
    if (!entry) return false;
    if (entry.resetAt < Date.now()) {
      failedLogins.delete(ip);
      return false;
    }
    return entry.count >= MAX_FAILED_LOGINS;
  }

  function recordFailure(ip) {
    const entry = failedLogins.get(ip);
    if (!entry || entry.resetAt < Date.now()) {
      failedLogins.set(ip, { count: 1, resetAt: Date.now() + FAILED_LOGIN_WINDOW_MS });
    } else {
      entry.count++;
    }
  }

  /** Returns null on success, or an error message to show on the login form. */
  function attemptLogin(req, res, password) {
    const ip = req.ip;
    if (isThrottled(ip)) return 'Too many failed attempts. Try again in a few minutes.';
    if (typeof password !== 'string' || !safeEqual(password, adminPassword)) {
      recordFailure(ip);
      return 'Incorrect password.';
    }
    failedLogins.delete(ip);
    startSession(req, res);
    return null;
  }

  return { sessionMiddleware, requireAdmin, attemptLogin, endSession };
}

module.exports = { createAuth };
