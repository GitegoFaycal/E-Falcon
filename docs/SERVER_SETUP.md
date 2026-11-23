# Setting up a test server and connecting the first charger

Goal: one small server on the internet that a physical charger can reach, so we can see what the firmware actually does. This is a **test setup**: SQLite database, no domain name, and the dashboard reached through an SSH tunnel so nothing administrative is exposed. Moving to production (domain, TLS, PostgreSQL) is in `DEPLOYMENT.md` and can wait until the charger test has answered the open questions.

```
 charger ──ws://SERVER_IP:9988/ocpp/…──► nginx (only /ocpp/) ──► E-Falcon server (127.0.0.1:4000)
                                                                        ▲
 your computer: dashboard on localhost:5173 ──SSH tunnel to port 4000───┘
```

## What you need

- A VPS (virtual server) from any provider: **Ubuntu 24.04**, 1 CPU, 1 to 2 GB RAM, a **public IPv4 address**. Choose a region close to Rwanda if the provider offers one.
- The root password or SSH key the provider gives you.
- On your own computer: Node.js 22.13 or newer, and the `e-falcon.zip` file.

Wherever you see `SERVER_IP` below, use the server's public address.

## 1. Prepare the server

Open a terminal (on Windows: PowerShell) and connect:

```bash
ssh root@SERVER_IP
```

Then on the server:

```bash
apt update && apt upgrade -y
apt install -y nginx ufw unzip curl

# Firewall: SSH for you, 9988 for chargers. Nothing else is reachable from outside.
ufw allow OpenSSH
ufw allow 9988/tcp
ufw --force enable

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v        # must print v22.13 or higher
```

If your provider has its own firewall or "security group" in its control panel, allow inbound TCP 22 and 9988 there too.

## 2. Install E-Falcon

From **your computer** (a second terminal), copy the project up:

```bash
scp e-falcon.zip root@SERVER_IP:/root/
```

Back on **the server**:

```bash
cd /root && unzip -o e-falcon.zip
adduser --system --group --home /opt/efalcon efalcon
mkdir -p /var/lib/efalcon
cp -r /root/e-falcon/. /opt/efalcon/
cd /opt/efalcon/backend
npm install
npm test
```

`npm test` matters here: it is the first run against the real packages. All 13 tests should pass. If any fail, stop and send me the output.

## 3. Configure

```bash
cd /opt/efalcon/backend
SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
cat > .env <<EOF
NODE_ENV=development
HOST=127.0.0.1
PORT=4000
SQLITE_FILE=/var/lib/efalcon/efalcon.sqlite
JWT_SECRET=$SECRET
CORS_ORIGINS=http://localhost:5173
COOKIE_SAMESITE=lax
OCPP_REQUIRE_AUTH=true
EOF
chmod 600 .env
chown -R efalcon:efalcon /opt/efalcon /var/lib/efalcon
```

`NODE_ENV=development` is deliberate for this test: it allows SQLite and the plain-HTTP tunnel. `HOST=127.0.0.1` keeps the server private, and `OCPP_REQUIRE_AUTH=true` means a charger must present its key.

Create your administrator account (replace the email and name). A password is printed **once**; save it.

```bash
sudo -u efalcon node --env-file=.env tools/create-admin.js --email you@example.com --name "Your Name"
```

## 4. Run it as a service

```bash
cp /opt/efalcon/deploy/efalcon.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now efalcon
journalctl -u efalcon -n 20 --no-pager
```

You should see `E-Falcon server listening on 127.0.0.1:4000` and `charger authentication required`.

## 5. Open the charger port

```bash
cp /opt/efalcon/deploy/nginx-ocpp.conf /etc/nginx/conf.d/efalcon-ocpp.conf
nginx -t && systemctl reload nginx
```

Check from **your computer**:

```bash
curl -i http://SERVER_IP:9988/            # expect: HTTP/1.1 404  (nginx answering = the port is reachable)
curl -m 5 http://SERVER_IP:4000/api/health   # expect: no answer / timeout (the API is not public)
```

## 6. Open the dashboard on your computer

Terminal A, keep it open (this is the tunnel):

```bash
ssh -N -L 4000:127.0.0.1:4000 root@SERVER_IP
```

Terminal B:

```bash
cd e-falcon/frontend
npm install
echo "VITE_API_URL=http://localhost:4000" > .env
npm run dev
```

Open http://localhost:5173 and sign in with the administrator account from step 3.

## 7. Register the charger

In the dashboard:

1. **Locations → New location** (the site where the charger stands).
2. **Chargers → Register charger.** Choose an OCPP identity, for example `EF-KGL-001`. Letters, digits and dashes only; you will type it on the charger.
3. Open the charger's page → **Connecting this charger → Issue authorisation key.** Write the key down; it is shown once.

## 8. Point the charger at the server

**Before changing anything on the charger, photograph its current OCPP screen** so the original URL and key can be put back. Changing the URL takes the unit off the manufacturer's platform. We also do not yet know how the unit behaves for drivers while its backend is unreachable, so do this when the charger is not needed.

On the charger's OCPP screen:

| Field | Enter |
|---|---|
| Server URL (the field that now holds the `ws://ocpp.thaisen.cn…` address) | `ws://SERVER_IP:9988/ocpp` |
| CP Identification | the identity from step 7, exactly |
| Authorize Key | the key from step 7 |
| Security Profile | `1` |

Press **Apply**. Restart the charger if it does not reconnect by itself.

## 9. See what happened

On the server, watch what the charger asks for:

```bash
tail -f /var/log/nginx/efalcon-ocpp.log
```

Each line ends with the path requested and a status code:

| You see | Meaning | What to do |
|---|---|---|
| Nothing at all | The charger cannot reach the server | Check the charger's internet (SIM / Ethernet), the provider firewall, and the address typed on the screen |
| `GET /ocpp/EF-KGL-001 … 101` | Connected | Open the charger's page in the dashboard |
| `… 404` with the identity in the path | Identity not registered, or spelled differently | Register it exactly as it appears in the log line |
| `GET /ocpp … 404` (no identity in the path) | This firmware does not append the identity | Enter the full URL on the charger: `ws://SERVER_IP:9988/ocpp/EF-KGL-001` |
| `… 401` | Key missing or wrong | Re-enter the key; issue a new one if unsure |
| `… 400` | The charger did not offer OCPP 1.6 | Open **Alerts** in the dashboard: it shows which protocol the charger offered. Send me that line |

Refusals also appear in the dashboard under **Alerts**.

## 10. Once it is connected

On the charger's page:

1. **Identity and connection** now shows the vendor, model and firmware the unit reported. Send me these.
2. Press **Get configuration**, then open that command under **Command history** and copy the "Charger response". This lists every setting the firmware exposes, including any related to price. Send me this too: it decides how pricing can work on your hardware.
3. Continue with `HARDWARE_VERIFICATION.md` sections C and D, one test at a time, and record each result under **Edit → Capabilities**.

## Useful commands

```bash
systemctl status efalcon          # is it running?
journalctl -u efalcon -f          # live server log
systemctl restart efalcon         # restart after changing .env
cp /var/lib/efalcon/efalcon.sqlite /root/backup-$(date +%F).sqlite   # quick backup (stop the service first for a clean copy)
```
