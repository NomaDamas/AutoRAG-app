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

## Security model

**The server is LAN-visible HTTP with no TLS. Use it only on a trusted network
or through an encrypted tunnel.** It listens on all IPv4 interfaces, not only
loopback. Do not expose the raw HTTP port to the public internet.

The host generates a random token for each server session. Every request,
including the interface, previews, uploads, downloads, and event stream, must
carry that token. Browser tabs have separate session identifiers for their
file watches and clipboard; those identifiers are not separate credentials.
The token grants access to the host's Dazzi services and files with the
permissions of the running desktop app. This is not a read-only share, a
folder-limited share, or a multi-user permission system.

Treat the complete browser address as a credential. Anyone who has it and can
reach the server can use it. The token may appear in browser history and
copied links. It authenticates requests but does not encrypt them: someone
able to observe unencrypted network traffic can read the token and file
content. Stop and restart remote access if an address has been disclosed.

An encrypted SSH or VPN tunnel can protect transport over an untrusted
network. For example, with remote access running on port `47833` and SSH
already configured for the host:

```sh
ssh -N -L 47833:127.0.0.1:47833 user@dazzi-host
```

Open the copied URL at `http://localhost:47833/` on the client, retaining the
token query. Replace the example user, hostname, and ports with your own.
If the client-side port is different, change only that port in the URL.
A tunnel does not change the server's all-interface bind: restrict the host
firewall as needed so the raw HTTP port is reachable only by trusted devices.

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
| It works on the host but not another device | Replace `localhost` with the host's LAN address. Check the host firewall, Wi-Fi client isolation, network routing, and that both devices can reach the selected port. |
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
