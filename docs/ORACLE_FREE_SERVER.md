# Test server on Oracle Cloud's Always Free tier

Oracle differs from an ordinary VPS in four ways, so this page **replaces step 1 of `SERVER_SETUP.md`** and adjusts a few commands in the later steps. Everything else in that guide applies unchanged.

| Ordinary VPS (`SERVER_SETUP.md`) | Oracle Cloud |
|---|---|
| Log in as `root` with a password | Log in as `ubuntu` with a key file, then `sudo -i` |
| One firewall (`ufw`) | Two: Oracle's network rules in the web console, and `iptables` on the machine |
| `ufw` commands | **Do not use `ufw` on Oracle's Ubuntu images.** Oracle advises against it and it can lock you out |
| Files copied to `/root/` | Files copied to `/home/ubuntu/` |

The Oracle console's menus change from time to time; the names below describe what to look for rather than exact button labels. These steps were written from Oracle's documentation and have not been run on an Oracle account from here.

## A. Create the account

1. Sign up at oracle.com/cloud/free. A phone number and a credit or debit card are needed for verification; prepaid and virtual cards are not accepted. Nothing is charged unless you later choose to upgrade.
2. **Choose the home region carefully.** Always Free servers can only be created in the home region and it cannot be changed afterwards. Pick the one closest to Rwanda that is offered to you.

## B. Create the server

Console menu → **Compute → Instances → Create instance**.

| Setting | Choose |
|---|---|
| Name | `efalcon-test` |
| Image | Change image → **Canonical Ubuntu 24.04** |
| Shape | One marked **Always Free-eligible**: `VM.Standard.E2.1.Micro` (1 GB memory), or `VM.Standard.A1.Flex` with 1 OCPU and 6 GB if it is available. Both run E-Falcon |
| Networking | Create a new virtual cloud network and a new **public** subnet; make sure **assign a public IPv4 address** is on |
| SSH keys | **Generate a key pair for me**, then **download the private key**. This is the only time it can be downloaded. Keep the file safe |

Press **Create**. If you get an "out of host capacity" error, the free machines in that region are temporarily used up: try another availability domain or the other shape, or try again later.

When the instance shows **Running**, copy its **Public IP address**. That is `SERVER_IP` everywhere below.

## C. Open the charger port in Oracle's network

On the instance page, click the **subnet** name → **Security Lists** → the default security list → **Add Ingress Rules**:

| Field | Value |
|---|---|
| Source CIDR | `0.0.0.0/0` |
| IP protocol | TCP |
| Destination port range | `9988` |

Port 22 (SSH) is already open by default. Do not open port 4000.

## D. Connect

On your computer, in the folder holding the downloaded key (called `key.key` here):

```bash
chmod 600 key.key                       # Mac / Linux only
ssh -i key.key ubuntu@SERVER_IP
sudo -i                                 # become root for the setup commands
```

On Windows, run the `ssh` line in PowerShell. If it complains that the key file's permissions are too open, right-click the file → Properties → Security → Advanced, disable inheritance and leave only your own user with access.

## E. Prepare the server (replaces step 1 of SERVER_SETUP.md)

```bash
apt update && apt upgrade -y
apt install -y nginx unzip curl

# Open port 9988 on the machine itself. Oracle's Ubuntu image blocks everything except SSH.
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 9988 -j ACCEPT
netfilter-persistent save

# Check: the 9988 line must appear ABOVE the line that says REJECT.
iptables -L INPUT --line-numbers

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v        # must print v22.13 or higher
```

If the 9988 line is below the REJECT line, delete it (`iptables -D INPUT <its line number>`), insert it again with a smaller number in place of `6`, and run `netfilter-persistent save` again.

## F. Continue with SERVER_SETUP.md from step 2, with these changes

**Step 2, copying the project** (run on your computer):

```bash
scp -i key.key e-falcon.zip ubuntu@SERVER_IP:/home/ubuntu/
```

then on the server (as root):

```bash
cd /root && unzip -o /home/ubuntu/e-falcon.zip
```

and carry on from the `adduser` line.

On the 1 GB shape, if `npm install` stops with "Killed", add temporary swap space and run it again:

```bash
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

**Steps 3, 4 and 5** are unchanged.

**Step 5 check:** `curl -i http://SERVER_IP:9988/` from your computer should answer `404`. If it hangs instead, one of the two firewalls (section C or E) is still closed.

**Step 6, the tunnel** (run on your computer):

```bash
ssh -i key.key -N -L 4000:127.0.0.1:4000 ubuntu@SERVER_IP
```

**Steps 7 to 10** are unchanged.

## Two things to know about the free tier

- **Idle servers can be reclaimed.** Oracle may reclaim an Always Free server whose CPU and network use stay very low for seven days. A test server that mostly waits for one charger fits that description, so do not leave it unused for long, and take a copy of the database (`/var/lib/efalcon/efalcon.sqlite`) after any session you want to keep.
- **It is a test server.** Charger traffic is unencrypted and the database is a single file. Move to the paid server and `DEPLOYMENT.md` before real customers depend on it.
