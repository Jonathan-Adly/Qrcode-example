'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { formatPrice } = require('../src/validate');

const PASSWORD = 'correct horse battery staple';
const PUBLIC_URL = 'https://menu.example.com';

let server;
let base;
let store;

before(async () => {
  store = openDatabase(':memory:');
  const app = createApp({ store, adminPassword: PASSWORD, sessionSecret: 'test-secret', publicUrl: PUBLIC_URL });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
});

/** Minimal browser-like client that keeps cookies between requests. */
function client() {
  let cookie = '';
  async function request(path, { method = 'GET', form, json, headers = {} } = {}) {
    const opts = { method, redirect: 'manual', headers: { ...headers } };
    if (cookie) opts.headers.cookie = cookie;
    if (form) {
      opts.body = new URLSearchParams(form).toString();
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (json !== undefined) {
      opts.body = JSON.stringify(json);
      opts.headers['content-type'] = 'application/json';
    }
    const res = await fetch(base + path, opts);
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    return res;
  }
  return {
    request,
    async login(password = PASSWORD) {
      return request('/admin/login', { method: 'POST', form: { password, next: '/admin' } });
    },
    async csrf() {
      const res = await request('/admin/api/session');
      return (await res.json()).csrfToken;
    },
  };
}

async function signedInClient() {
  const c = client();
  const res = await c.login();
  assert.equal(res.status, 302);
  c.token = await c.csrf();
  return c;
}

async function createMenu(c, title = 'Dinner') {
  const res = await c.request('/admin/menus', { method: 'POST', form: { title, _csrf: c.token } });
  assert.equal(res.status, 302);
  const id = Number(res.headers.get('location').split('/').pop());
  const { menu } = await (await c.request(`/admin/api/menus/${id}`)).json();
  return menu;
}

function sampleContent(overrides = {}) {
  return {
    title: 'Dinner',
    description: 'Served 5–10pm',
    currency: '€',
    published: true,
    sections: [
      {
        name: 'Starters',
        description: '',
        items: [
          { name: 'Bruschetta', price: '8.5', tags: 'Vegan, vegan, GF', description: 'Tomato', available: true },
          { name: 'Oysters', price: 'Market price', tags: '', available: false },
        ],
      },
      { name: 'Mains', items: [{ name: 'Steak', price: '24' }] },
    ],
    ...overrides,
  };
}

async function save(c, menu, content, updatedAt = menu.updatedAt) {
  return c.request(`/admin/api/menus/${menu.id}`, {
    method: 'PUT',
    json: { menu: content, updatedAt },
    headers: { 'x-csrf-token': c.token },
  });
}

// ---- Auth ---------------------------------------------------------------------

test('admin pages require signing in', async () => {
  const c = client();
  const res = await c.request('/admin');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/admin\/login\?next=/);

  const api = await c.request('/admin/api/menus/1');
  assert.equal(api.status, 401);
});

test('wrong password is rejected, correct password signs in', async () => {
  const c = client();
  assert.equal((await c.login('wrong')).status, 401);
  assert.equal((await c.request('/admin')).status, 302);

  assert.equal((await c.login()).status, 302);
  assert.equal((await c.request('/admin')).status, 200);
});

test('a login request with no body is rejected cleanly', async () => {
  const res = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 401);
});

test('login only redirects back into the admin area', async () => {
  const c = client();
  const res = await c.request('/admin/login', {
    method: 'POST',
    form: { password: PASSWORD, next: '//evil.example.com/admin' },
  });
  assert.equal(res.headers.get('location'), '/admin');
});

test('signing out ends the session', async () => {
  const c = await signedInClient();
  await c.request('/admin/logout', { method: 'POST', form: { _csrf: c.token } });
  assert.equal((await c.request('/admin')).status, 302);
});

test('changes without a CSRF token are blocked', async () => {
  const c = await signedInClient();
  const res = await c.request('/admin/menus', { method: 'POST', form: { title: 'Sneaky' } });
  assert.equal(res.status, 403);
  const menu = await createMenu(c);
  const put = await c.request(`/admin/api/menus/${menu.id}`, {
    method: 'PUT',
    json: { menu: sampleContent() },
    headers: { 'x-csrf-token': 'wrong' },
  });
  assert.equal(put.status, 403);
});

// ---- Menus --------------------------------------------------------------------

test('admin creates and saves a menu; customers see it', async () => {
  const c = await signedInClient();
  const menu = await createMenu(c, 'Dinner');
  assert.match(menu.code, /^[a-z0-9]{8}$/);
  assert.deepEqual(menu.sections, []);

  const res = await save(c, menu, sampleContent());
  assert.equal(res.status, 200);
  const saved = (await res.json()).menu;
  assert.deepEqual(saved.sections[0].items[0].tags, ['Vegan', 'GF'], 'tags are de-duplicated');
  assert.equal(saved.sections[0].items[1].available, false);
  assert.equal(saved.sections[1].items[0].name, 'Steak');

  // Public page, as a customer with no cookies.
  const page = await fetch(`${base}/m/${menu.code}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<h1>Dinner<\/h1>/);
  assert.match(html, /Bruschetta/);
  assert.match(html, /€8\.50/);
  assert.match(html, /Market price/);
  assert.match(html, /Sold out/);
  assert.ok(html.indexOf('Starters') < html.indexOf('Mains'), 'sections keep their order');
});

test('menu content is HTML-escaped on the public page', async () => {
  const c = await signedInClient();
  const menu = await createMenu(c);
  const content = sampleContent({ title: '<script>alert(1)</script>' });
  content.sections[0].items[0].name = '<img src=x onerror=alert(1)>';
  assert.equal((await save(c, menu, content)).status, 200);

  const html = await (await fetch(`${base}/m/${menu.code}`)).text();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('draft menus are hidden from customers but previewable by admins', async () => {
  const c = await signedInClient();
  const menu = await createMenu(c);
  await save(c, menu, sampleContent({ published: false }));

  assert.equal((await fetch(`${base}/m/${menu.code}`)).status, 404);
  const preview = await c.request(`/m/${menu.code}`);
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Draft preview/);
});

test('saving over someone else\'s changes is refused', async () => {
  const c = await signedInClient();
  const menu = await createMenu(c);
  const first = await save(c, menu, sampleContent({ title: 'First' }));
  assert.equal(first.status, 200);

  // A second tab still holding the original version tries to save.
  const stale = await save(c, menu, sampleContent({ title: 'Stale' }), menu.updatedAt);
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.menu.title, 'First');
});

test('invalid menus are rejected with a helpful message', async () => {
  const c = await signedInClient();
  const menu = await createMenu(c);

  let res = await save(c, menu, sampleContent({ title: '   ' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /title is required/i);

  const content = sampleContent();
  content.sections[1].items[0].name = '';
  res = await save(c, menu, content);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Section 2, item 1 name is required/);

  res = await save(c, menu, sampleContent({ title: 'x'.repeat(500) }));
  assert.equal(res.status, 400);

  res = await save(c, menu, sampleContent({ sections: 'nope' }));
  assert.equal(res.status, 400);
});

test('duplicating a menu copies its content as a draft with a new code', async () => {
  const c = await signedInClient();
  const menu = await createMenu(c);
  await save(c, menu, sampleContent());

  const res = await c.request(`/admin/menus/${menu.id}/duplicate`, { method: 'POST', form: { _csrf: c.token } });
  assert.equal(res.status, 302);
  const copyId = res.headers.get('location').split('/').pop();
  const { menu: copy } = await (await c.request(`/admin/api/menus/${copyId}`)).json();
  assert.equal(copy.title, 'Dinner (copy)');
  assert.equal(copy.published, false);
  assert.notEqual(copy.code, menu.code);
  assert.equal(copy.sections.length, 2);
});

test('deleting a menu removes it and its public page', async () => {
  const c = await signedInClient();
  const menu = await createMenu(c);
  const res = await c.request(`/admin/menus/${menu.id}/delete`, { method: 'POST', form: { _csrf: c.token } });
  assert.equal(res.status, 302);
  assert.equal((await fetch(`${base}/m/${menu.code}`)).status, 404);
  assert.equal((await c.request(`/admin/menus/${menu.id}`)).status, 404);
});

// ---- QR codes -------------------------------------------------------------------

test('QR code page and downloads point at the public menu URL', async () => {
  const c = await signedInClient();
  const menu = await createMenu(c);
  const url = `${PUBLIC_URL}/m/${menu.code}`;

  const page = await c.request(`/admin/menus/${menu.id}/qr`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes(url));
  assert.ok(html.includes('<svg'));
  assert.ok(!html.includes("phones can't reach"), 'no localhost warning when PUBLIC_URL is set');

  const png = await c.request(`/admin/menus/${menu.id}/qr.png?download=1`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');

  const svg = await c.request(`/admin/menus/${menu.id}/qr.svg`);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);

  const print = await c.request(`/admin/menus/${menu.id}/print?layout=grid`);
  assert.equal((await print.text()).match(/class="table-card"/g).length, 4);
});

test('QR downloads require signing in', async () => {
  const c = client();
  assert.equal((await c.request('/admin/menus/1/qr.png')).status, 302);
});

test('the menu link stays the same after edits', async () => {
  const c = await signedInClient();
  const menu = await createMenu(c);
  await save(c, menu, sampleContent({ title: 'Renamed' }));
  const { menu: after } = await (await c.request(`/admin/api/menus/${menu.id}`)).json();
  assert.equal(after.code, menu.code);
});

// ---- Helpers --------------------------------------------------------------------

test('formatPrice adds the currency to plain numbers only', () => {
  assert.equal(formatPrice('12', '$'), '$12');
  assert.equal(formatPrice('12.5', '$'), '$12.50');
  assert.equal(formatPrice('3.75', '€'), '€3.75');
  assert.equal(formatPrice('Market price', '$'), 'Market price');
  assert.equal(formatPrice('8 / 12', '$'), '8 / 12');
  assert.equal(formatPrice('', '$'), '');
});
