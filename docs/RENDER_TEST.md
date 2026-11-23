# Test deployment on Render (free plan)

Render can run the E-Falcon server for free, with one condition that only the charger can answer:

> **Render only accepts encrypted connections (`wss://` on port 443).** The charger is currently set up for unencrypted `ws://` with Security Profile 1. This deployment works only if the charger's firmware can connect with TLS. Finding that out is itself a useful test result.

Other limits of the free plan, all acceptable for a test:

- The service sleeps after 15 minutes with no incoming traffic and takes about a minute to wake. A connected charger's heartbeats count as traffic and keep it awake.
- Files on the service are wiped on every restart, so the database must be Render's free PostgreSQL, which **expires 30 days after creation**.
- No command line on the server. The first administrator is created from environment variables instead.
- **This is the first time E-Falcon runs on PostgreSQL.** That part was written but could not be tested during development. If the service fails to start, send me the Render log.

## 1. Put the project on GitHub

Render deploys from a Git repository. Create a **private** repository on github.com (for example `e-falcon`), then on your computer, in the `e-falcon` folder:

```bash
git init
git add .
git commit -m "E-Falcon CMS"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/e-falcon.git
git push -u origin main
```

The project's `.gitignore` keeps `.env` files and `node_modules` out of the repository. Check on GitHub that no `.env` file was uploaded.

## 2. Create the database

Render dashboard → **New → Postgres**. Name `efalcon-db`, plan **Free**, region closest to you (Frankfurt is the nearest to Rwanda). When it is ready, open it and copy the **Internal Database URL**.

## 3. Create the web service

Render dashboard → **New → Web Service** → connect the GitHub repository.

| Setting | Value |
|---|---|
| Region | the same as the database |
| Root Directory | `backend` |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node src/server.js` |
| Instance Type | Free |
| Health Check Path | `/api/health` |

Environment variables:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the Internal Database URL from step 2 |
| `JWT_SECRET` | a long random string. Generate one on your computer: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `CORS_ORIGINS` | `http://localhost:5173` |
| `COOKIE_SAMESITE` | `none` |
| `TRUST_PROXY` | `1` |
| `ADMIN_EMAIL` | your email |
| `ADMIN_PASSWORD` | a password of at least 10 characters that you choose |
| `ADMIN_NAME` | your name |

Create the service and open its **Logs**. A good first start shows, in order:

```
migration applied: 001_init.sql
First administrator created from ADMIN_EMAIL: you@example.com. Remove ADMIN_PASSWORD from the environment now.
E-Falcon server listening on 0.0.0.0:10000 (production, postgres)
```

Then delete the `ADMIN_PASSWORD` variable (Environment tab). The account stays; the variable is only read when the database has no users.

Check from a browser: `https://YOUR-SERVICE.onrender.com/api/health` should show `{"ok":true,…}`.

## 4. Open the dashboard

On your computer:

```bash
cd e-falcon/frontend
echo "VITE_API_URL=https://YOUR-SERVICE.onrender.com" > .env
npm run dev
```

Open http://localhost:5173 in Chrome and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

If you are signed out every time you reload the page, your browser is blocking cross-site cookies (Safari and private windows do). Use a normal Chrome window for this test; the permanent setup avoids the issue by putting dashboard and server on one domain.

## 5. Register the charger

In the dashboard: create a location, register the charger with an identity such as `EF-KGL-001`, then on its page **Issue authorisation key** and write the key down.

## 6. Point the charger at Render

Photograph the charger's current OCPP screen first so it can be restored, and do this when the unit is not needed by drivers.

| Field | Enter |
|---|---|
| Server URL | `wss://YOUR-SERVICE.onrender.com/ocpp` |
| CP Identification | the identity from step 5 |
| Authorize Key | the key from step 5 |
| Security Profile | `2` |

Press **Apply**. Allow up to two minutes: if the service was asleep, the first attempt wakes it.

If the screen refuses `wss://` or Security Profile 2, try `wss://YOUR-SERVICE.onrender.com:443/ocpp`, and Security Profile 1 with the `wss://` address.

## 7. Read the result

| What you see | Meaning |
|---|---|
| Charger shows **online** in the dashboard | It works. The firmware supports TLS. Continue with step 10 of `SERVER_SETUP.md` (Get configuration, then `HARDWARE_VERIFICATION.md`) |
| A new entry under **Alerts** (unregistered identity, wrong key, wrong protocol) | The charger reached the server over TLS; fix what the alert names. For "unregistered identity", the alert shows the identity the charger actually sent |
| Nothing in Alerts and nothing in the Render log | The charger never completed an encrypted connection. Either it has no internet path to Render, or the firmware cannot do TLS (or does not trust Render's certificate). Render cannot be used with this unit as it is |

If it is the last case, the charger needs a server that accepts plain `ws://`: the local-network test (your computer as the server) or a VPS following `SERVER_SETUP.md`.
