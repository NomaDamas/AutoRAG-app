# Remote access in Dazzi powered by AutoRAG

Remote access serves the running Dazzi Finder interface to a web browser on your
phone, tablet, or another computer. The desktop app stays responsible for files,
search, indexing, and AI services; the browser controls that same host computer,
not a separate copy of its files. Dazzi must remain running and the host must be
awake.

## Enable remote access and pair a device

1. On the host computer, open **Settings > Remote Access** and turn on
   **Enable Remote Access**. It is off by default; the switch saves the
   preference, so an enabled host serves again when Dazzi starts. While it is
   off, nothing else is shown.
2. In **Connect a Device**, pick a **Route**. It decides which address the new
   device opens:
   - **Same Wi-Fi:** the host's LAN address (`http://192.168.x.y:<port>`). When
     the host has several, choose one from the list.
   - **Tailscale:** the tailnet IP (`http://100.x.y.z:<port>`) until you click
     **Publish over HTTPS in Tailnet**, then the
     `https://<machine>.<tailnet>.ts.net` address.
   - **Internet:** a Cloudflare tunnel (see below). Its address appears once
     the tunnel is online.
3. Click **Get Pairing Code**. The same 6-digit code works on every route. The
   QR code is the chosen route's address plus `?pair=CODE`: scan it with the
   phone's camera, or open the address and type the code on the Dazzi sign-in
   screen. Switching the route changes the QR code, not the code. Once paired,
   the browser keeps a 1-year `HttpOnly` device credential (`dazzi_device`)
   that survives Dazzi restarts until you revoke it in **Paired Devices**.

**Details** holds the rest:

- **Browser Address** (`?token=...`) opens a session with the current server
  run's 256-bit access token, for the same machine or an SSH tunnel. The token
  can also be pasted into **Have an access token instead?** on the sign-in
  screen. Treat it as a password.
- **Port**: the default is `47833`; `0` asks the operating system for a free
  port. Press Enter or leave the field to save a whole number from `0` to
  `65535`; a running server moves to the new port right away.

If the port is already taken — most often by a second Dazzi, such as the
installed app running beside a development build — the server does not start
and **Connect a Device** says which port is in use. **Start on port N** saves a
port that is free at that moment and starts on it; **Try Again** retries the
saved port after the other program has quit.

Devices signed in to the host owner's Tailscale account, reaching Dazzi through
`tailscale serve`, are admitted without a code.

In a remote browser session, the same settings page shows how that browser got
in (`Connected as a paired device`, `Connected via this computer's Tailscale
login`, or `Connected with the access token`) and the **Paired Devices** list.
Tunnel controls stay on the host.

## Connect from outside your home or office

**Never forward Dazzi's raw HTTP port on your router to the public internet:**
unencrypted HTTP exposes traffic on untrusted networks. Use the **Internet**
route (Cloudflare tunnel, no VPN needed) or **Tailscale** instead.

| Method | Best for | Router port forwarding | Client software needed |
| --- | --- | --- | --- |
| **Internet: Cloudflare temporary address** | Trying it out; no account | None | Browser only |
| **Internet: own domain on Cloudflare** | A fixed address you bookmark | None | Browser only |
| **Tailscale (`tailscale serve` HTTPS or tailnet IP)** | Devices already on your tailnet | None | Tailscale app on host and client |
| **SSH local port forward** | Developers who already have SSH access to the host | Only if SSH is remote | Any SSH client |

Both Internet modes need `cloudflared` on the host (for example
`brew install cloudflared` on macOS or `winget install Cloudflare.cloudflared`
on Windows). Dazzi always runs it with an empty `--config`, so an existing
`~/.cloudflared/config.yml` never reroutes Dazzi's traffic. Every visitor still
meets Dazzi's sign-in gate and needs a pairing code, a device credential, or the
access token.

### Option 1: Cloudflare temporary address (no account)

1. Choose the **Internet** route and click **Start Tunnel**.
2. Dazzi runs `cloudflared tunnel --url http://127.0.0.1:<port>` and shows the
   `https://<words>.trycloudflare.com` address it receives, with its QR code.
3. The address changes every time the tunnel starts, and Cloudflare gives no
   uptime guarantee for it. Click **Stop Tunnel** (or turn off Remote Access)
   when finished.

### Option 2: Your own domain on Cloudflare (fixed address)

For an address that stays the same, use a hostname on a domain whose DNS you
manage in Cloudflare:

1. Under the **Internet** route, open **Use my own domain** and enter a hostname
   such as `dazzi.example.com`. Dazzi accepts a bare hostname only (no scheme,
   path, IP address, or wildcard) and stores it lower-case. Clearing the field
   returns to the temporary address.
2. Click **Sign in to Cloudflare** once. This runs `cloudflared tunnel login`,
   which opens Cloudflare in the host's browser; approve the account that owns
   the domain. It writes `~/.cloudflared/cert.pem` (or `TUNNEL_ORIGIN_CERT`).
3. Click **Start Tunnel**. On the first start Dazzi creates the named tunnel
   `dazzi-<hostname>` (for `dazzi.example.com`, `dazzi-dazzi-example-com`),
   keeps its credentials file in Dazzi's settings directory, and runs
   `cloudflared tunnel route dns` for the hostname. It does not pass
   `--overwrite-dns`: if the hostname already has a DNS record, setup stops and
   shows cloudflared's reason instead of replacing that record. Later starts
   reuse the tunnel, so `https://<hostname>` stays the same.

### Option 3: Tailscale (private mesh + zero-code owner login)

[Tailscale](https://tailscale.com) creates an encrypted WireGuard mesh (tailnet)
between your signed-in devices. Dazzi reads `tailscale status --json` and
`tailscale serve status --json`, and changes Tailscale's configuration only when
you press its button:

- **Publish over HTTPS in Tailnet** runs
  `tailscale serve --bg --yes --https=<port> http://127.0.0.1:<Dazzi port>` on the
  first HTTPS port (443, 8443, 47833, 17317) no other serve route uses, so an
  existing route such as `https://<machine>.ts.net` → another app is left alone.
  The **Tailscale** route then shows the `https://<machine>.<tailnet>.ts.net[:port]`
  address and its QR code. Devices signed in as the host's Tailscale owner open
  Finder directly; devices of another tailnet user see a notice and can still
  pair with a code.
- **Stop Publishing** runs `tailscale serve --yes --https=<port> off` for that one
  route only; Dazzi never runs `tailscale serve reset`.
- Dazzi's port can change between runs (`0` picks a free one, or the default is
  taken). Dazzi remembers the ports it listened on (`remote-ports.json` in its
  settings folder); when a serve route still points at one of those, the next
  start re-points that same route at the new port, so the `ts.net` address keeps
  working instead of answering `502`. A route that points anywhere else belongs to
  another app and is never changed.
- When neither the `tailscale` CLI nor the Tailscale app is on the computer, the
  **Tailscale** route is not shown.
- If Tailscale refuses (for example, HTTPS certificates or Serve are off for the
  tailnet), Settings shows Tailscale's reason and, when Tailscale prints one, a
  button that opens its admin-console page to turn it on.
- **Run it yourself in a terminal** shows the same command for people who prefer
  it. Dazzi never uses `tailscale funnel`, which exposes the endpoint to the
  public internet (Dazzi never trusts Funnel headers and always requires pairing
  or the token).

### Option 4: SSH local port forwarding

If you already reach the host over SSH, forward a local port on the client to
`127.0.0.1` on the host:

```sh
ssh -N -L 47833:127.0.0.1:47833 user@dazzi-host
```

Open `http://localhost:47833` in the client's browser and enter a 6-digit
pairing code (or open the full `?token=...` Browser Address from **Details**).

## Security model

- **Paired device credentials (`remote-devices.json`):** Each paired browser
  receives a unique 256-bit random token in an `HttpOnly; SameSite=Strict`
  cookie (`Secure` when served over HTTPS or `X-Forwarded-Proto: https`). Only
  the SHA-256 hash of that token is stored on disk (`0600` owner-only atomic
  writes). If `remote-devices.json` is unreadable or corrupted, device matching
  and new pairings fail closed.
- **One-time 6-digit pairing codes:** Valid for 10 minutes; 5 wrong guesses
  immediately destroy the pending code, and at most 10 codes can be issued per
  10-minute window. Scanning a `?pair=CODE` QR link strips `pair` from the URL
  via `history.replaceState` before exchanging it so spent codes do not remain
  in browser history.
- **Instant revocation:** Renaming a device in **Paired Devices** updates its
  label in place. Clicking **Revoke** (or **Revoke All**) deletes its token hash
  from disk and immediately closes any open SSE event streams belonging to that
  device; its next action returns `403` and reloads back to the sign-in gate.
- **Session token & brute-force backoff:** The host also mints a fresh 256-bit
  per-run access token on start. Token comparisons are constant-time
  (`timingSafeEqual`), and repeated wrong token attempts trigger per-client and
  per-proxy exponential backoff (`HTTP 429`).
- **CSRF protection:** State-changing requests (`POST /remote/call`,
  `POST /remote/upload`, `POST /remote/pair`, `POST /remote/auth`) enforce
  same-origin / `Sec-Fetch-Site` and custom header checks (`x-dazzi-remote: 1`).
- **Full host authority:** Any authenticated remote session has the same file
  and AI Search permissions as the desktop app. Turn off **Enable Remote
  Access** or revoke paired devices whenever access is no longer needed.

## Browser capabilities and limitations

The browser uses the same Finder interface and host services as the desktop:

- Browse host folders, change views, select files, and search.
- Create, rename, move, copy, duplicate, and trash host files, subject to the
  host's filesystem permissions.
- Use AI Search with the host's configured models and indexed sources.
- Open supported file previews (images, PDF, plain text, and browser-playable
  audio/video) in a browser tab. Formats a browser cannot render directly, such
  as archives or Office/HWP documents, show an unsupported notice instead;
  double-click them to download.
- Receive live file-list updates from the host.

Browser actions that need native operating-system integration differ:

- Dragging files out becomes a download, not a native drag into another app.
- Opening a file uses a browser download rather than the host's default app.
- **Show in Finder**, **Open With**, native share sheets, OS services, and
  native file conversion are unavailable.
- Quick Look uses browser previews rather than a native Quick Look window.
- The file cut/copy clipboard belongs to each browser session. It is not the
  host's system clipboard and is lost when the page reloads or closes.
- Native sign-in, checkout, app-update installation, and host permission or
  folder-picker dialogs still require the desktop app.

## Uploads and downloads

### Uploads

Drop files from the client into a normal host folder in the browser Finder.
Their bytes are uploaded to that folder on the host; the client originals are
not moved or deleted. File names are made safe, and name collisions receive an
available copy name instead of overwriting an existing file. The server limits
each request body to 512 MiB. **Uploads are not recorded in undo history
(`Cmd+Z`).**

### Downloads

Double-clicking or dragging out a regular file downloads its bytes to the
browser's download folder while leaving the host original untouched. Folders are
not zipped on download; download individual files instead.
