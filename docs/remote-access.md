# Remote access in Dazzi powered by AutoRAG

Remote access serves the running Dazzi Finder interface to a web browser.
The desktop app stays responsible for files, search, indexing, and AI services;
the browser controls that same host computer, not a separate copy of its files.
Dazzi must remain running and the host must be awake.

## Enable remote access

1. On the host computer, open **Settings > General > Remote Access**.
2. Choose a **Port** if needed. The default is `47833`; `0` asks the operating
   system for an available port. Press Enter or leave the field to save a valid
   whole number from `0` to `65535`. Restart Dazzi after changing the port.
3. Turn on **Enable Remote Access**. It is off by default. This switch saves
   the preference, so an enabled host serves again when Dazzi starts.
4. Copy **Browser Address** and open the complete address, including its
   `?token=...` query, in a browser.
5. For another device on the same network, replace `localhost` in the copied
   address with the host computer's LAN address or resolvable hostname. Keep
   the port, path, and token unchanged. `localhost` always means the device
   running the browser.

The address comes from the server's status, not from the port field. If port
`0` was chosen, use the actual port in that address. The address row reads
**Stopped** and its copy button is disabled while the server is not serving.
Select the address to copy it manually if the browser refuses clipboard
access.

In a remote browser session, General settings shows that page's origin
(`http://host:port`), without the token. Its Copy Address button copies that
origin. Use the desktop's complete token-bearing address to open a new session
or connect another device.

Turn off **Enable Remote Access** to stop serving. Quitting Dazzi also stops
the server. A new server session has a new token: copy the address again after
restarting Dazzi or stopping and starting remote access.

## Connect from outside your home or office

Dazzi's built-in server speaks plain HTTP on your local network and does not
open router ports, configure DDNS, or manage TLS certificates. To reach your
host safely over the internet or an untrusted Wi-Fi network, put an encrypted
private network or tunnel in front of it. **Never forward the raw HTTP port on
your router to the public internet:** unencrypted traffic exposes both the
session token and your files.

| Method | Best for | Router port forwarding | Client software needed |
| --- | --- | --- | --- |
| **Tailscale (direct IP / MagicDNS)** | Personal laptops, phones, and tablets | None | Tailscale app on host and client |
| **Tailscale Serve (HTTPS)** | Same as above, plus full browser HTTPS (clipboard API, no HTTP warnings) | None | Tailscale app on host and client |
| **SSH local port forward** | Developers who already have SSH access to the host | Only if SSH is remote | Any SSH client |
| **Cloudflare Tunnel + Cloudflare Access** | Devices where you cannot install a VPN client | None | Browser only |

### Option 1: Tailscale (recommended)

[Tailscale](https://tailscale.com) creates an encrypted WireGuard mesh
(tailnet) between your own signed-in devices, even behind home NAT or carrier
CGNAT, without exposing any port to the public internet.

1. Install Tailscale and sign in to the same tailnet on both the **host**
   computer running Dazzi and the **client** device (Mac, Windows, iOS, or
   Android).
2. Keep the host awake while away (for example `caffeinate -dimsu` on macOS, or
   disable sleep in System Settings / Windows Power settings).
3. Enable **Remote Access** in Dazzi (**Settings > General > Remote Access**)
   and copy **Browser Address**:
   ```text
   http://localhost:47833/?token=<your-session-token>
   ```
4. Find the host computer's Tailscale IPv4 address (`100.x.y.z`) or MagicDNS
   name (`<machine>.<tailnet>.ts.net`) in the Tailscale menu bar / tray icon,
   or from a terminal on the host:
   ```sh
   tailscale ip -4
   ```
5. On the client device, replace `localhost` with that Tailscale IP or MagicDNS
   hostname, **keeping the port and `?token=...` query intact**:
   ```text
   http://100.x.y.z:47833/?token=<your-session-token>
   ```

#### Optional: HTTPS within your tailnet (`tailscale serve`)

Plain `http://100.x.y.z:...` is already encrypted end-to-end by WireGuard, but
browsers still treat `http://` origins as non-secure contexts (which can block
one-click clipboard copy). If HTTPS certificates are enabled in your Tailscale
admin console (**DNS > HTTPS Certificates**), proxy Dazzi's port over TLS inside
your tailnet:

```sh
tailscale serve --bg 47833
```

(If you configured a custom port or `0`, pass the actual running port shown in
**Browser Address** instead of `47833`.)

Tailscale prints an `https://<machine>.<tailnet>.ts.net` URL reachable **only**
by devices in your tailnet. Open it with the same `?token=...` query from Dazzi:

```text
https://<machine>.<tailnet>.ts.net/?token=<your-session-token>
```

Stop sharing the HTTPS proxy at any time with `tailscale serve reset`. Do
**not** use `tailscale funnel`, which exposes the port to the public internet.

### Option 2: SSH local port forwarding

If you already reach the host over SSH, forward a local port on the client to
`127.0.0.1` on the host (replace `47833` with Dazzi's running port if
different):

```sh
ssh -N -L 47833:127.0.0.1:47833 user@dazzi-host
```

Leave the `ssh` command running and open the copied URL unchanged
(`http://localhost:47833/?token=...`) in the client's browser. Because the
browser connects to `localhost`, it treats the page as a secure context. If the
local port `47833` is taken on the client, forward another port (for example
`-L 57833:127.0.0.1:47833`) and change only the port in the URL.

### Option 3: Cloudflare Tunnel + Cloudflare Access (browser-only clients)

When you need to connect from a browser on a machine where you cannot install
Tailscale or run SSH:

1. Point a `cloudflared` tunnel on the host at `http://127.0.0.1:47833` (or
   your configured fixed port — avoid port `0` so the local port stays fixed
   across restarts).
2. **Required:** Protect the hostname with a **Cloudflare Access** application
   (email OTP, SSO, or hardware key) restricted to your own email address
   *before* routing traffic. Without an Access policy, anyone who discovers or
   guesses the URL reaches your host's login boundary directly.
3. After passing Cloudflare Access in the browser, append Dazzi's current
   `/?token=...` query on first entry so Dazzi sets its session cookie.

## Security model

**The built-in server is LAN-visible HTTP with no TLS. Use it only on a trusted
network or through an encrypted tunnel.** It binds to `0.0.0.0` (all IPv4
interfaces), not only loopback. Even when you connect through Tailscale, SSH,
or `cloudflared`, the local HTTP port remains open on the host's active network
interfaces: if the host joins an untrusted Wi-Fi network (hotel, cafe, airport),
enable the OS firewall to block incoming connections to Dazzi's port on public
interfaces while allowing loopback / Tailscale, or turn off Remote Access until
needed.

The host generates a fresh 256-bit random token each time the server starts.
Every request — the interface, static assets (via an `HttpOnly; SameSite=Strict`
session cookie set on first entry), previews, uploads, downloads, and the SSE
event stream — must carry that token. Browser tabs have separate session
identifiers for their file watches and clipboard; those identifiers are not
separate credentials.

The token grants full access to the host's Dazzi services and files with the
permissions of the running desktop app. This is not a read-only share, a
folder-limited share, or a multi-user permission system:

- Treat the complete browser address as a password. It may be recorded in
  browser history, bookmarks, or chat logs.
- If a token-bearing URL is ever shared or exposed, toggle **Enable Remote
  Access** off and back on (or restart Dazzi) to invalidate the old token
  immediately.

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

The browser is an interface to the host's real files. Moving or trashing a
file there changes the host immediately; it does not just remove a downloaded
copy on the client.

## Uploads and downloads

### Uploads

Drop files from the client into a normal host folder in the browser Finder.
Their bytes are uploaded to that folder on the host; the client originals
are not moved or deleted. File names are made safe, and name collisions
receive an available copy name instead of overwriting an existing file.
Uploads are file-by-file; a partial failure does not roll back earlier files.
The server limits each request body to 512 MiB.

**Uploads are not recorded in undo history. Cmd+Z does not undo an upload.**
To remove an uploaded file, select it and move it to Trash. Browser folder
uploads do not recreate a directory tree; upload individual files into the
intended host folder.

### Downloads

A file download copies the host file's bytes to the browser's download
destination and leaves the host original in place. The browser controls the
save location, prompting, and whether it permits multiple downloads.
Native drag-out downloads files instead of handing host paths to client
applications.

The current download endpoint handles individual regular files, not folders
or directory ZIP archives. Download files individually; do not assume that
dragging a folder produces an archive.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The address says **Stopped** | Confirm remote access is enabled on the host. Return to General or refocus the window to refresh status. Check the host log if the server could not start. |
| The page says `remote access token required` or returns HTTP 403 | Copy the current complete address from the host. Keep the token query intact; an address from a previous server session no longer works. |
| It works on the host but not another device | Replace `localhost` with the host's LAN IP or Tailscale IP (`100.x.y.z` / MagicDNS). Confirm Tailscale is signed in and connected on both devices, or check the host firewall, Wi-Fi client isolation, and routing on a local network. |
| Connection refused or the page stops updating | Keep Dazzi running and the host awake. Check that remote access is still enabled, then reload using the current address. |
| The port is already in use | Choose another valid port or `0`, save it, and restart Dazzi. Copy the newly reported address rather than constructing one from the old port. |
| A changed port does not match the browser address | The displayed address is the running server's address. Restart Dazzi to apply the saved port. |
| Copy Address fails | Select the address field and copy manually. Browsers can restrict clipboard access on plain HTTP or deny permission. |
| An upload fails | Check write permission on the host folder, available disk space, and the 512 MiB request limit. Check which files arrived before retrying a partial batch. |
| A download or preview does not open | Allow downloads or popups for the page, confirm the host file still exists and is readable, and try an individual regular file rather than a folder. |
| Show in Finder, Open With, sign-in, or a native dialog does nothing | Use the desktop app for native-only actions. A browser cannot open the host's operating-system UI. |

Enabling this feature does not configure router forwarding, TLS, firewall
rules, DNS, or a tunnel. Those remain network configuration choices outside
Dazzi.
