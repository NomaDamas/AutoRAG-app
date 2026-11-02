# Remote access in Dazzi powered by AutoRAG

Remote access serves the running Dazzi Finder interface to a web browser on your
phone, tablet, or another computer. The desktop app stays responsible for files,
search, indexing, and AI services; the browser controls that same host computer,
not a separate copy of its files. Dazzi must remain running and the host must be
awake.

## Enable remote access and pair a device

1. On the host computer, open **Settings > General > Remote Access**.
2. Choose a **Port** if needed. The default is `47833`; `0` asks the operating
   system for an available port. Press Enter or leave the field to save a valid
   whole number from `0` to `65535`.
3. Turn on **Enable Remote Access**. It is off by default. This switch saves the
   preference, so an enabled host serves again when Dazzi starts.
4. Connect another device using one of three built-in ways:
   - **Pairing Code + QR Code (recommended for phones and laptops):** Click
     **Get Pairing Code** under the **Pairing Code** tab. Point your phone's
     camera at the QR code (which automatically selects your active Tunnel,
     Tailscale, or LAN Wi-Fi address and appends `?pair=CODE`), or open the
     host's address in a browser and enter the 6-digit code on the Dazzi sign-in
     screen. Once paired, the browser receives a persistent 1-year `HttpOnly`
     device credential (`dazzi_device`) that survives Dazzi restarts until you
     revoke it in **Paired Devices**.
   - **Browser Address (`?token=...`):** Copy **Browser Address** to open a
     session on the same machine or over an SSH tunnel using the current server
     run's 256-bit access token. You can also paste that token into **Have an
     access token instead?** on the remote sign-in screen.
   - **Tailscale Serve owner login:** When `tailscale serve` proxies HTTPS on
     the host to Dazzi's port, devices signed in to the host owner's Tailscale
     account are admitted automatically without entering a code.

In a remote browser session, General settings shows that page's origin
(`http://host:port` or `https://...`), without the secret token, plus the active
authentication mode (`Connected as a paired device`, `Connected via Tailscale`,
or `Connected with the access token`) and the **Paired Devices** list.

## Connect from outside your home or office

**Never forward Dazzi's raw HTTP port on your router to the public internet:**
unencrypted HTTP exposes traffic on untrusted networks. Instead, use either the
built-in **Quick Tunnel** (no Tailscale or VPN needed) or **Tailscale**.

| Method | Best for | Router port forwarding | Client software needed |
| --- | --- | --- | --- |
| **Quick Tunnel (built-in `cloudflared`)** | Phones, locked-down work laptops, or anywhere Tailscale is not installed | None | Browser only |
| **Tailscale (`tailscale serve` HTTPS or direct IP)** | Personal laptops, phones, and tablets on your tailnet | None | Tailscale app on host and client |
| **SSH local port forward** | Developers who already have SSH access to the host | Only if SSH is remote | Any SSH client |

### Option 1: Built-in Cloudflare Quick Tunnel (without Tailscale)

When you want to reach Dazzi from anywhere using only a web browser — with no
VPN app on the client, no Cloudflare account, and no router configuration:

1. Install `cloudflared` on the host computer (for example
   `brew install cloudflared` on macOS or `winget install Cloudflare.cloudflared`
   on Windows).
2. In **Settings > General > Remote Access**, turn on **Enable Remote Access**,
   open the **Quick Tunnel** tab, and click **Start Tunnel**.
3. Dazzi starts an outbound `https://<name>.trycloudflare.com` tunnel to its
   local port and updates the QR code automatically.
4. Click **Get Pairing Code** (or scan the tunnel QR code directly) to pair your
   phone or remote browser. Every visitor reaching the tunnel URL hits Dazzi's
   sign-in gate and cannot access Finder without a valid 6-digit pairing code or
   access token.
5. Click **Stop Tunnel** (or turn off Remote Access) when finished.

### Option 2: Tailscale (private mesh + zero-code owner login)

[Tailscale](https://tailscale.com) creates an encrypted WireGuard mesh (tailnet)
between your signed-in devices. Dazzi inspects `tailscale status --json` and
`tailscale serve status --json` read-only in the **Tailscale** tab:

- If `tailscale serve` is already proxying HTTPS to Dazzi's port, the
  **Tailscale** tab displays the live `https://<machine>.<tailnet>.ts.net` URL
  and QR code immediately. Devices signed in as the host's Tailscale owner open
  Finder directly; devices belonging to another tailnet user see a notice and
  can still be admitted with a 6-digit pairing code.
- Otherwise, Dazzi shows the exact one-line command to publish HTTPS inside your
  tailnet (for example `tailscale serve --bg --https=443 http://127.0.0.1:47833`)
  alongside your direct `http://100.x.y.z:<port>` Tailscale IPv4 address. Do
  **not** use `tailscale funnel` without understanding that Funnel exposes the
  endpoint to the public internet (Dazzi never auto-trusts Funnel headers and
  always requires pairing or the token).

### Option 3: SSH local port forwarding

If you already reach the host over SSH, forward a local port on the client to
`127.0.0.1` on the host:

```sh
ssh -N -L 47833:127.0.0.1:47833 user@dazzi-host
```

Open `http://localhost:47833` in the client's browser and enter a 6-digit
pairing code (or open the full `?token=...` Browser Address).

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
