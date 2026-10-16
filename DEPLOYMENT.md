# HTTPS Deployment

This project includes an installer for RHEL-family and Debian-family Linux distributions. It runs the backend with systemd and exposes the UI over HTTPS with Nginx.

Prerequisites:

- Node.js 18, 20, or 22+ must be available from the configured package repositories.
- Supported package managers are DNF on RHEL, CentOS Stream, Rocky Linux, AlmaLinux, Oracle Linux, and Fedora, or APT on Debian and Ubuntu.
- For Let's Encrypt, the domain must resolve to this server and inbound ports 80 and 443 must be open.
- The OpenSIPS database and the tables in `database/schema.sql` must already exist.

If the preflight reports that an app-owned table is missing on a new installation, create the app-owned tables once:

```bash
mariadb -h 127.0.0.1 -u opensips -p opensips < database/schema.sql
```

This schema file does not alter any existing OpenSIPS or custom routing table.

## Upgrading An Existing Installation

The separate Trunks, Inbound Routing, and Outbound Routing screens require the old embedded route fields in the app-owned `sbc_trunks` table to be optional. Apply this migration once, before rerunning the installer:

```bash
mariadb -h 127.0.0.1 -u opensips -p opensips < database/migrations/001_separate_routing.sql
```

This migration preserves all rows and does not alter any OpenSIPS or custom routing table. The installer intentionally does not run database migrations automatically.

To add the operational trunk enable/disable switch, apply the second app-owned
migration before deploying the updated backend:

```bash
sudo mysql opensips < database/migrations/002_trunk_enabled.sql
```

It adds only `enabled`, `registration_expiry`, and `binding_uri` to
`sbc_trunks`. Existing registration expiry and binding values are copied from
the latest matching `registrant` row so a disabled trunk can be restored later.

To add optional per-trunk P-Asserted-Identity URIs, apply:

```bash
sudo mysql opensips < database/migrations/003_custom_pai.sql
```

When the value is empty, OpenSIPS continues deriving P-Asserted-Identity from
the outbound From URI. A configured value such as
`tel:+2348139856030;user=phone` overrides only the selected trunk's PAI.

To enable named inbound application destinations and automatic dispatcher-set
allocation, apply the fourth app-owned migration:

```bash
sudo mysql opensips < database/migrations/004_application_destination_groups.sql
```

It imports destination sets already referenced by `did_mapping` into the new
app-owned catalogue. Existing `dispatcher`, `did_mapping`, and routing records
are not changed.

To add the per-trunk call-recording switch, apply:

```bash
sudo mysql opensips < database/migrations/005_trunk_recording.sql
```

All existing trunks default to recording disabled. The UI setting affects new
calls only.

### Optional outbound number prepending

Outbound routes now have **Prepend digits (optional)**, for example `+234`.
Apply the explicit additive migration before deploying the new backend:

```bash
sudo mysql opensips < database/migrations/006_outbound_add_prefix.sql
```

Unlike migrations 001-005, this adds a nullable column to the existing custom
`prefix_mapping` table, not to an app-owned `sbc_*` table. It preserves all rows;
existing routes default to adding nothing. It is also required on fresh installs
because the custom routing tables are provisioned separately.

The UI/API update alone does not rewrite SIP numbers. Apply the two production
config edits in `deploy/opensips-outbound-number-snippets.md`, validate OpenSIPS,
and restart it only in a maintenance window with no active calls. The snippets
honor `strip_prefix` and then apply `add_prefix`; they bypass old prefix caches
and read the current rule once per initial call. Benchmark this extra database
load. There is no Redis flush requirement for the new prefix-routing lookup.
Caller-DID/no-prefix routing, inbound calls and caller identity are unchanged.

Example: dial `1238012345678`, match prefix `123`, enable **Strip prefix**, and
set **Prepend digits** to `+234`: the provider receives `+2348012345678`.
Leaving the field blank (or clearing it) adds nothing. This does not implicitly
remove a leading zero or replace a country code.

## RTPengine Recording Prerequisites

The trunk switch makes OpenSIPS send `record-call=yes` on the initial RTPengine
offer. RTPengine must be configured separately to store the media. Choose one
recording method below. The in-app player uses the PCAP method; the separate
RTPengine recording daemon uses the `proc` method.
Because the server-specific `opensips.cfg` is excluded from Git, apply the
tracked snippets in `deploy/opensips-recording-snippets.md` to the production
configuration.

### PCAP method: play and download from the UI

For the Recordings page, RTPengine must write PCAP files. Your server already
has captures under `/var/spool/rtpengine/pcaps`, so verify its current settings
before making changes:

```bash
sudo grep -E '^[[:space:]]*(recording-dir|recording-method)[[:space:]]*=' \
  /etc/rtpengine/rtpengine.conf
sudo ls -ld /var/spool/rtpengine /var/spool/rtpengine/pcaps
```

The relevant RTPengine settings are:

```ini
recording-dir = /var/spool/rtpengine
recording-method = pcap
```

Do not switch a running server from `proc` to `pcap` just to follow this guide
without planning the change: it changes how recordings are produced. The UI
converts PCAPs to stereo WAV on demand, with one RTP direction per channel.
It supports G.711 PCMA/PCMU captures up to 40 MB and 30 minutes; unsupported
codecs or empty captures cannot be played. The conversion does not modify the
original PCAPs or the OpenSIPS database.

The recording list matches each capture's Call-ID to the existing OpenSIPS
`acc` table to display caller, called number, and call start time (`created`).
The backend database user needs `SELECT` access to `acc`; no migration is
needed. If a call has no matching accounting row yet, the UI shows its PCAP
file time and marks the phone numbers unavailable.

The backend runs as `opensips-sbc-ui` and needs read access to the PCAP folder.
On RHEL, the top-level spool is often root-only. Grant only the necessary path
access, without making the spool public:

```bash
sudo dnf install -y acl
sudo setfacl -m u:opensips-sbc-ui:--x /var/spool/rtpengine
sudo setfacl -m u:opensips-sbc-ui:r-x /var/spool/rtpengine/pcaps
sudo -u opensips-sbc-ui ls /var/spool/rtpengine/pcaps
```

Individual PCAP files must also be readable by this account. Check a sample
with `sudo -u opensips-sbc-ui test -r /var/spool/rtpengine/pcaps/FILE.pcap`.
If SELinux still denies access, inspect the audit log and add a narrowly
scoped policy; do not disable SELinux or make the directory world-readable.

Set these values in `/opt/opensips-sbc-ui/backend/.env` on the server:

```ini
RECORDINGS_ENABLED=true
RECORDINGS_DIR=/var/spool/rtpengine
```

`RECORDINGS_DIR` is the spool root; the backend appends `/pcaps` itself. The
existing `.env` is preserved by repeat deployments. After editing it, restart
the backend with `sudo systemctl restart opensips-sbc-ui` and open Recordings
in the UI. If you have updated the project code, rerun the deployment script
from the project root first, then verify the service status.

**Access control:** Recording audio is sensitive. The current recording API
does not authenticate users itself. Configure Nginx Basic Auth with
`BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` in the deployment settings before
enabling the page, and keep the backend bound to `127.0.0.1`. Verify that the
generated Nginx site contains `auth_basic` and that an unauthenticated request
to `/api/recordings` receives HTTP 401. Do not expose this endpoint publicly
without access control. Also define retention, encryption, and consent rules
appropriate to your jurisdiction.

### `proc` method: RTPengine recording daemon

If you instead need RTPengine's separate WAV-producing recording daemon, use
the following `proc` setup. The current Recordings page does **not** read that
daemon's WAV output; it reads only the PCAP folder described above.

Check the installed components first:

```bash
command -v rtpengine-recording
sudo systemctl status rtpengine-recording --no-pager
```

The main `/etc/rtpengine/rtpengine.conf` needs a recording spool and the `proc`
recording method:

```ini
[rtpengine]
recording-dir = /var/spool/rtpengine
recording-method = proc
```

A typical `/etc/rtpengine/rtpengine-recording.conf` is:

```ini
[rtpengine-recording]
table = 0
spool-dir = /var/spool/rtpengine
output-dir = /var/lib/rtpengine-recording
output-storage = file
output-format = wav
output-mixed = 1
```

Both directories must exist and be writable by the users running RTPengine and
its recording daemon. Restart both services after validating their exact unit
names. Recorded calls contain sensitive personal data; configure access,
retention, encryption, and consent requirements for the applicable jurisdiction.

On RHEL-family systems, the installer configures firewalld when it is active and applies the SELinux settings required for Nginx to serve the frontend and proxy the API. Public certificates require a repository that provides Certbot; if `dnf install certbot` cannot find it, enable EPEL or use the self-signed mode.

If a supported Node.js and npm installation already exists, including a NodeSource installation, the installer reuses it and does not ask DNF or APT to replace it.

For RHEL 8 or 9, if the default Node.js stream is older than version 18, select a supported stream before running the installer:

```bash
sudo dnf module install nodejs:20
```

## Production With Let's Encrypt

Run from the project root on the OpenSIPS/SBC host:

```bash
sudo DOMAIN=sbc.example.com EMAIL=admin@example.com bash scripts/install-https-nginx.sh
```

The first run copies the app to `/opt/opensips-sbc-ui`, creates `/opt/opensips-sbc-ui/backend/.env`, and stops so you can set the database, MI URL, and credential encryption key.

Edit:

```bash
sudo nano /opt/opensips-sbc-ui/backend/.env
```

Then rerun:

```bash
sudo DOMAIN=sbc.example.com EMAIL=admin@example.com bash scripts/install-https-nginx.sh
```

The installer preserves `backend/.env` on subsequent deployments, validates the database schema, rebuilds both workspaces, and restarts the backend service.

### Inbound application failover

An application destination group may contain a primary server followed by one
or more failover servers. Add them from the inbound-route editor using **Add
failover server**. Select a saved application server from the dropdown, or
choose **Add a new server…** to enter its name, IP, and SIP port. The dropdown
shows individual servers from clean application destination groups, excludes
servers already in the selected group, and never offers provider-trunk groups.
Selecting a saved server adds only that server to the failover chain; its
original group and routes are not moved or modified. Existing socket, attributes,
and administrative state are preserved. Newly entered servers are saved as
members of this group and can subsequently be selected from other groups.
Adding a failover updates every inbound route using the target group, not just
the route currently being edited.

The backend stores later servers with increasing dispatcher
priority and reloads the dispatcher automatically.

The production `opensips.cfg` is intentionally ignored by Git. Apply the two
tracked blocks in `deploy/opensips-inbound-failover-snippets.md`. Incoming calls
use dispatcher algorithm 8 (the first active destination), while
provider-facing outbound calls retain weighted round-robin. On SIP 408, 500,
502, 503, or 504, OpenSIPS marks the failed application destination for probing
and retries the next server. It does not fail over business responses such as
404, 486, or 603.

Before replacing the production configuration, validate the candidate and keep
a backup:

```bash
sudo cp -a /usr/local/etc/opensips/opensips.cfg \
  /usr/local/etc/opensips/opensips.cfg.before-app-failover
sudo /usr/local/sbin/opensips -C \
  /usr/local/etc/opensips/opensips.cfg
```

The backend uses the local `/usr/bin/opensips-cli` MI transport by default. The `opensips-sbc-ui` service account must be able to run MI commands, as verified with `sudo -u opensips-sbc-ui opensips-cli -x mi reg_list`. HTTP MI remains available by setting `MI_TRANSPORT=http` and `MI_URL`.

Set `SIP_BINDING_IP` and `SIP_BINDING_PORT` in the deployed `backend/.env` to the local OpenSIPS SIP listener. For example, `SIP_BINDING_IP=10.81.0.194` and `SIP_BINDING_PORT=5060`. New REGISTER contacts use this listener unless a trunk supplies an explicit SBC Contact URI.

## Private/Internal HTTPS

For an internal host without public DNS or Let's Encrypt access:

```bash
sudo DOMAIN=sbc.internal SELF_SIGNED=true bash scripts/install-https-nginx.sh
```

Your browser will warn about the private certificate unless you install/trust it locally.

## Saved Deployment Settings

Instead of passing the domain and password on every deployment, keep them in a
root-owned file outside the Git checkout. Set it up once from the project root:

```bash
sudo install -d -m 700 /etc/opensips-sbc-ui
sudo install -o root -g root -m 600 \
  deploy/deploy.env.example /etc/opensips-sbc-ui/deploy.env
sudo vi /etc/opensips-sbc-ui/deploy.env
```

After editing the values, future deployments require one command:

```bash
sudo bash scripts/deploy.sh
```

The wrapper reads `/etc/opensips-sbc-ui/deploy.env`, verifies that it is private
and root-owned, then runs the standard installer. To use another settings file,
set `DEPLOY_CONFIG` when invoking the wrapper.

A service restart alone does not copy or rebuild newly pulled source code. If no
code or deployment settings changed and only the existing backend process needs
restarting, use `sudo systemctl restart opensips-sbc-ui`.

## Basic Password Protection

Until application login is added, use Nginx basic auth:

```bash
sudo DOMAIN=sbc.example.com \
  EMAIL=admin@example.com \
  BASIC_AUTH_USER=admin \
  BASIC_AUTH_PASSWORD='change-this-password' \
  bash scripts/install-https-nginx.sh
```

## Custom Install Directory Or Port

```bash
sudo DOMAIN=sbc.example.com \
  EMAIL=admin@example.com \
  APP_DIR=/opt/opensips-sbc-ui \
  BACKEND_PORT=3000 \
  bash scripts/install-https-nginx.sh
```

Nginx listens on ports `80` and `443`. The NestJS backend listens only on localhost at `BACKEND_PORT`.

## Optional Homer 11 on the same HTTPS server

For an existing Homer service listening on `127.0.0.1:8080`, see
[`deploy/nginx/HOMER.md`](deploy/nginx/HOMER.md). Install the opt-in
`deploy/nginx/homer.locations.conf.example` as
`/etc/nginx/opensips-sbc-ui.d/homer.conf`. The HTTPS template now includes that
directory, and deployments preserve its contents outside the application folder.
For an already generated site, add the documented include inside the HTTPS
server once, validate with `nginx -t`, then reload Nginx (no SIP-service restart).
Do not put bare location fragments directly in `/etc/nginx/conf.d/`.

The fragment handles `/homer/`, Homer `/api/v4/`, logos and root-relative lazy
assets without disabling Basic Auth on the SBC root, API or existing SBC assets.
Homer retains its own login. Shared-origin paths can collide; check the guide's
scope and tests, and prefer a separate hostname where available. Homer is not
installed or automatically exposed by the SBC deployment script.

## Database Preflight

Before applying the schema or saving trunks, check that the expected OpenSIPS/custom tables exist:

```bash
DB_HOST=127.0.0.1 \
DB_PORT=3306 \
DB_USER=opensips \
DB_PASSWORD='your-password' \
DB_NAME=opensips \
bash scripts/preflight-db.sh
```

The installer runs this check automatically using the deployed `backend/.env`. For an initial web-server-only setup when the database is deliberately unavailable, set `SKIP_DB_PREFLIGHT=true`; run the preflight manually before using the application.

## Services

### Optional passive DTMF monitor (separate from the web app)

This monitor **does not change calls, discard digits, reload OpenSIPS, restart
RTPengine, or write to the database**. It reads captured packet copies and flags
suspected duplicate **IPv4/UDP RTP telephone-event** sequences from one configured
provider. It does not decode in-band audio, infer unobserved keypresses, or claim
which upstream device produced an event. The UI is not integrated with this first
version; findings are private JSONL logs and evidence PCAPs.

Two independent services are provided:

- `sbc-dtmf-capture`: dumpcap collector on the SBC, with a bounded rotating ring.
- `sbc-dtmf-worker`: unprivileged analyzer, preferably on a separate monitoring
  server. It can also run locally for a controlled benchmark.

Requirements: Node.js 20+, systemd, and dumpcap on the capture host. On RHEL,
`sudo dnf install wireshark-cli` normally supplies dumpcap. The optional installer
does not install packages or alter package repositories. Check `command -v node`
and `command -v dumpcap` first. SELinux must remain enabled; investigate narrowly
scoped denials if the collector cannot access a capture interface.

Install from the updated project checkout:

```bash
sudo bash scripts/install-dtmf-monitor.sh
sudo vi /etc/sbc-dtmf/monitor.json
```

The installer copies the worker to root-owned `/opt/sbc-dtmf`, preserves an
existing configuration, and installs the units **without starting or enabling
them**. This separate location is not overwritten/chowned by web deployments.
No npm dependencies or application rebuild are needed for the monitor itself.
Re-running this installer updates code and units but does not restart active
monitor services; stop them first when upgrading.

Replace the example provider network and SBC addresses with the addresses seen
in your SIP/SDP and packet captures. Include both the provider's SIP signalling
peer and its complete, confirmed RTP networks, not just a single successful
call's media IP. For an initial local trial, relevant settings look like:

```json
{
  "enabled": true,
  "providerName": "Selected provider",
  "providerNetworks": ["192.0.2.0/24"],
  "sbcAddresses": ["198.51.100.10"],
  "interface": "any",
  "sipPorts": [5060],
  "inputDir": "/var/lib/sbc-dtmf/capture",
  "outputDir": "/var/lib/sbc-dtmf/results",
  "captureFileKB": 100000,
  "captureFiles": 10,
  "captureSeconds": 60,
  "minFreeMB": 2048,
  "maxCalls": 250,
  "minMatchingEvents": 3,
  "maxDelayMs": 600,
  "logDigits": false
}
```

Those IPs are documentation placeholders. Do not use them unchanged. The file is
JSON, not `backend/.env`. Confirm `/usr/bin/dumpcap` matches your installed path,
or set `dumpcap` in the JSON. The installer resolves the Node executable in each
unit. Changing paths also requires adjusting systemd `ReadWritePaths` /
`ReadOnlyPaths`; initially keep the defaults.

Validate, then start a trial **without enabling at boot**:

```bash
sudo -u sbc-dtmf node /opt/sbc-dtmf/cli.mjs check /etc/sbc-dtmf/monitor.json
sudo systemctl start sbc-dtmf-worker
sudo systemctl start sbc-dtmf-capture
sudo systemctl status sbc-dtmf-worker sbc-dtmf-capture --no-pager
sudo journalctl -u sbc-dtmf-worker -u sbc-dtmf-capture -n 50 --no-pager
sudo tail -F /var/lib/sbc-dtmf/results/events.jsonl
```

The collector has only packet-capture capability; the worker has no network
capabilities. If capture permissions fail, inspect the journal/SELinux audit
rather than running the whole worker as root or disabling SELinux.

**Resource and coverage limits:** default ring approximately 1 GB; evidence at
most 50 files of 1 MB each; JSONL logs at most five files of 5 MB each. There can
be small rotation/packet overshoots. The collector also prunes its own oldest
`dtmf_*.pcapng` files across restarts, so they do not accumulate indefinitely.
An existing large capture ring from another tool is independent and is not
deleted by this service. The collector checks a
2 GB free-space reserve every ten seconds and stops on low disk; the worker
pauses on low disk. Neither daemon automatically restarts after a fatal failure.
This is not a guarantee against another process exhausting the disk.

The units use low CPU/I/O priority, collector CPU quota 15% of one core and
192 MB memory limit, worker CPU quota 20% and 256 MB memory limit. These are
initial safeguards, **not a promise of zero impact**. Benchmark CPU, memory,
disk I/O, capture drops and call audio during peak traffic. Restricting collector
CPU can itself cause monitoring packet loss; prefer remote analysis and narrower
capture networks over increasing quotas without measuring. A worker that cannot
keep up can miss data as the ring rotates. Check `capture_gap`,
`coverage_warning`, `evictedCalls`, `streamLimit`, `uncorrelatedRtp`, `fragmented`,
`truncated`, and `observedCaptureDrops` in logs, plus dumpcap's journal/drop
summary. No observed drops is not proof that every network packet was captured.

The analyzer keeps SDP/call state across files, skips recently modified files
(default settling time 30 seconds), and validates file size/identity after
reading. Active-file changes, lost ring segments and malformed input cause
coverage warnings and a correlation reset. Events whose SIP setup was not
captured, ambiguous port reuse, IP fragments, IPv6, SIP/TCP, SRTP and in-band
audio are not analysed as DTMF. Retention is bounded to 250 calls, eight streams
per call and 64 recent events per stream. Long idle calls can lose correlation.

Detection requires at least three consecutive matching events on distinct SSRCs
on the **same provider-to-SBC transport tuple**, within 600 ms per pair. Normal
event repeats in one SSRC, a forwarded SBC-to-PBX copy, and a lone repeated digit
do not produce an alert. An alert is still a **suspected anomaly**, not proof of
caller intent. A legitimate source change or unusual signalling can require
human review. It does not confirm what the downstream application received.

Find a reported call:

```bash
sudo grep -F 'THE-SIP-CALL-ID' /var/lib/sbc-dtmf/results/events.jsonl*
```

Each anomaly log references a small `evidence-*.pcap` containing bounded SIP
context and DTMF packets **only up to detection**, not complete call audio or
every later digit. For a complete incident use the retained raw ring files.
Numbers and Call-IDs are logged; digits are redacted by default. `logDigits=true`
exposes potentially sensitive PINs/account numbers. Evidence packets contain the
actual digit values even when JSONL digits are redacted. Keep both directories
private, define retention/consent, and transfer evidence securely. Do not serve
these folders directly through Nginx. Captures are excluded from Git.

To stop monitoring, without affecting calls:

```bash
sudo systemctl stop sbc-dtmf-capture sbc-dtmf-worker
```

If a worker was killed (for example by its memory limit), verify it is stopped
and remove only `/var/lib/sbc-dtmf/results/.worker.lock` before restarting. Do
not remove the lock while another worker or offline analysis uses that output
directory. Enable at boot only after the benchmark has passed:

```bash
sudo systemctl enable sbc-dtmf-capture sbc-dtmf-worker
```

**Off-box operation:** install the same code on the monitoring server and run
only `sbc-dtmf-worker` there. Transfer completed captures in chronological order
over SSH/SFTP with a dedicated, least-privileged account. Copy into temporary
names ending `.partial`, then atomically rename to `.pcapng` only after the copy
finishes. Keep a bounded incoming spool on that server too. Never copy the
currently written capture. Scheduling, credentials and remote transfer are
site-specific and are **not configured by this installer**. Missing signalling
segments prevent reliable Call-ID correlation. A network mirror/TAP to a
dedicated capture server is another option with less SBC capture overhead.

For offline validation on any Node.js 20+ host:

```bash
node monitoring/dtmf/cli.mjs analyze /absolute/path/config.json \
  /absolute/path/first.pcapng /absolute/path/second.pcapng
npm run test:dtmf
```

Offline analysis works even with `enabled=false`; it does not start packet
capture. Use a separate `outputDir` from any running worker and supply files
in chronological order. Keep the capture files unchanged during analysis.

```bash
sudo systemctl status opensips-sbc-ui
sudo journalctl -u opensips-sbc-ui -f
sudo nginx -t
```

## Generated Files

- `/etc/systemd/system/opensips-sbc-ui.service`
- RHEL family: `/etc/nginx/conf.d/opensips-sbc-ui.conf`
- Debian family: `/etc/nginx/sites-available/opensips-sbc-ui.conf` and `/etc/nginx/sites-enabled/opensips-sbc-ui.conf`
- Optional: `/etc/nginx/.opensips-sbc-ui.htpasswd`
- `/opt/opensips-sbc-ui/backend/.env`
