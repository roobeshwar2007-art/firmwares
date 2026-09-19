# ESP32-S3 Web Flasher — R Track Creation

A commercial-ready website to flash your ESP32-S3 firmware straight from a
customer's browser (Chrome/Edge, using Web Serial) — no separate flashing
tool needed, and the customer never gets a downloadable copy of your `.bin`.

## How it works
- **Admin** logs in, uploads the firmware `.bin`, and creates customer
  accounts (username + password) right from the dashboard.
- **Customer** logs in with the account you gave them, picks the firmware,
  plugs in the ESP32-S3, and clicks **Flash**. Flashing happens entirely in
  their browser via [esptool-js](https://github.com/espressif/esptool-js)
  (WebSerial) — the `.bin` is streamed from your server straight into the
  flasher and is never exposed as a "Save As" link.
- Success/failure of every flash attempt is logged and visible to the admin.
- **Logout** button on both dashboards.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

On first run it creates a default admin account and prints it to the
console once:

```
Username: admin
Password: ChangeMe123!
```

**Log in immediately and either change the password (delete + recreate the
account from the admin panel) or set your own before going live** via
environment variables:

```bash
ADMIN_USER=youradmin ADMIN_PASS=your-strong-password SESSION_SECRET=some-long-random-string npm start
```

## Deploying for real customers
- Put it behind HTTPS (Web Serial requires a secure context — `https://`
  or `localhost`). Any basic VPS + Nginx/Caddy reverse proxy, or a host like
  Render/Railway, works.
- Set `SESSION_SECRET` to a long random string in production.
- The SQLite database lives at `data/app.db` and uploaded `.bin` files at
  `uploads/` — back these up.
- Customers must use Chrome or Edge on desktop (Web Serial isn't supported
  on Firefox/Safari or iOS/Android browsers).

## Notes on firmware protection
The `/api/firmware/:id/bin` route only serves bytes to a *logged-in* browser
session and has no `Content-Disposition: attachment` header, so a normal
link click won't offer a file download — the bytes only flow into
esptool-js's in-page flasher. This deters casual leaking but isn't
DRM: a technically determined user could still capture the response from
browser dev tools. If you need stronger protection, that requires firmware
signing/encryption on the ESP32 side, which is a separate, deeper project.

## Project structure
```
server.js          Express + SQLite backend, all API routes
public/index.html   Login page
public/admin.html   Admin dashboard (upload firmware, create accounts, logs)
public/user.html    Customer dashboard (pick firmware, connect & flash)
uploads/             Uploaded .bin files (created automatically)
data/                SQLite database (created automatically)
```
