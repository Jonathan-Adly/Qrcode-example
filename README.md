# QR Menu

A small web app for restaurants and cafés. Create a menu, print its QR code, and let customers scan it to see the menu on their phone. Admins can edit menus at any time; **the QR code never changes**, so printed codes always show the latest version.

## Features

**For customers**
- Scan a QR code to open a fast, mobile-friendly menu (no app or login).
- Sticky section links (Starters, Mains, Drinks…), prices, descriptions and dietary tags.
- "Sold out" items are clearly marked. Supports dark mode.

**For admins** (`/admin`, password-protected)
- Create as many menus as you like (Lunch, Dinner, Drinks…). Each one gets its own QR code.
- Editor with sections and items: add, edit, reorder and delete. Set a price, description, tags (e.g. *Vegan, Gluten-free*) and availability for each item.
- Publish/unpublish a menu. Drafts are hidden from customers, but admins can preview them.
- Duplicate a menu to use as a starting point.
- QR code page: download a PNG or SVG, copy the link, or print ready-made table cards (1 or 4 per page).
- Protection against overwriting: if a menu was saved from another tab or by another admin, the editor warns you instead of silently replacing their changes.

## Quick start

Requires **Node.js 22.13 or newer** (the app uses Node's built-in SQLite, so there's nothing native to compile).

```bash
npm install
npm run seed                      # optional: adds a sample café menu
ADMIN_PASSWORD=choose-a-password npm start
```

Open http://localhost:3000/admin and sign in with your password.

If you don't set `ADMIN_PASSWORD`, a temporary password is printed in the terminal at startup.

### Try it on your phone

QR codes encode the address you used to open the admin panel (or `PUBLIC_URL` if it's set). `localhost` only works on your own computer, so to test with a phone on the same Wi‑Fi:

1. Find your computer's local IP address (for example `192.168.1.20`).
2. Open `http://192.168.1.20:3000/admin` and go to a menu's **QR code** page.
3. Scan the code with your phone.

## Configuration

Set these as environment variables (see `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `ADMIN_PASSWORD` | random, printed at startup | Password for `/admin`. **Required** when `NODE_ENV=production`. |
| `PUBLIC_URL` | address of the current request | The public address customers use, e.g. `https://menu.my-restaurant.com`. QR codes encode `PUBLIC_URL/m/<code>`, so set this before you print. |
| `SESSION_SECRET` | random per start | Signs admin login cookies. Set it so admins stay signed in across restarts. |
| `PORT` | `3000` | Port to listen on. |
| `DATA_DIR` | `./data` | Folder for the SQLite database (`menus.db`). Back this up. |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy or load balancer (Heroku, Render, Fly, nginx…) so HTTPS is detected correctly. |

## Deploying (make it public)

The app needs a host with a **persistent disk**, because menus are stored in a SQLite file. Free plans that wipe the disk on every restart will lose your menus.

### Render (recommended, a few clicks)

This repository includes a `render.yaml` that sets everything up: the web service, a 1 GB disk for the database, HTTPS, health checks and a generated session secret.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Jonathan-Adly/Qrcode-example)

1. Click the button above, or in the [Render dashboard](https://dashboard.render.com) choose **New → Blueprint** and select this repository. Sign in with GitHub if asked.
2. When prompted, enter an **ADMIN_PASSWORD**: a long, unique password, since the admin panel is on the internet.
3. Confirm. Render shows the price before you confirm: persistent disks need a paid instance (the blueprint uses the smallest one, `starter`).
4. When the deploy finishes, your site is live at `https://qr-menu-xxxx.onrender.com`. Open `/admin` there, sign in, and print your QR codes **from that address**. The codes will point to it.

Every push to `main` redeploys automatically; your menus stay on the disk.

**Using your own domain** (e.g. `menu.my-restaurant.com`): add it under the service's **Settings → Custom Domains** in Render, then set `PUBLIC_URL=https://menu.my-restaurant.com` under **Environment**. Do this before printing QR codes, because codes encode whichever address they were generated for.

### Other hosts

Any host that runs Node.js 22.13+ (or Docker) with a persistent volume works, such as Railway, Fly.io or a VPS. Set `NODE_ENV=production`, `ADMIN_PASSWORD`, `SESSION_SECRET` and `TRUST_PROXY=1`, point `DATA_DIR` at the persistent volume, and set `PUBLIC_URL` if customers will use a different address from the one you open the admin panel with.

With Docker:

```bash
docker build -t qr-menu .
docker run -d -p 3000:3000 -v qr-menu-data:/data \
  -e ADMIN_PASSWORD=choose-a-password \
  -e PUBLIC_URL=https://menu.my-restaurant.com \
  -e SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -e TRUST_PROXY=1 \
  qr-menu
```

Serve the site over HTTPS. Login cookies are marked secure when `PUBLIC_URL` starts with `https://`, or when requests arrive over HTTPS (behind a proxy this needs `TRUST_PROXY`).

## How it works

- `GET /m/:code` is the public menu page that QR codes point to. Each menu gets a random 8-character code when it's created, and the code never changes.
- `/admin` is the admin panel. Signing in sets a signed, HTTP-only cookie. All changes require a CSRF token, and repeated failed logins are throttled.
- Menus, sections and items are stored in SQLite (`data/menus.db`). The editor saves a whole menu in one request (`PUT /admin/api/menus/:id`), and each save runs in a single transaction.

```
src/
  server.js        entry point; reads environment variables
  app.js           Express app setup, security headers, error pages
  auth.js          admin sessions, CSRF protection, login throttling
  db.js            SQLite schema, migrations and queries
  validate.js      menu validation and price formatting
  routes/public.js customer-facing menu page
  routes/admin.js  admin pages, save API, QR code generation
views/             EJS templates
public/            CSS and browser JavaScript (menu editor)
scripts/seed.js    sample data
test/              integration tests (npm test)
```

## Development

```bash
npm run dev    # restarts on file changes
npm test       # runs the test suite
```
