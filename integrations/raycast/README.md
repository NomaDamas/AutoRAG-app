# Dazzi for Raycast

Search what Dazzi has indexed and ask Dazzi's AI Search without switching to the app.

| Command | What it does |
| --- | --- |
| **Search Dazzi** | Searches your files, mail, chats, and web history in Dazzi's local index. No model is involved and nothing leaves your Mac. ↵ opens a file, ⌘↵ shows it in Dazzi; Show in Finder and Quick Look are in the action panel, and a web page opens in the browser. ⌘⇧↵ asks Dazzi the same text with the selected file attached. |
| **Ask Dazzi** | Sends the question to Dazzi, which answers it in a new AI Search tab. |
| **Ask Dazzi About Selected Files** | The same, with the files selected in Finder attached to the question. |
| **Open in Dazzi** | Opens the folders selected in Finder in Dazzi, and shows selected files in their folder. |

## Requirements

- Dazzi installed in `/Applications` or `~/Applications`. A copy elsewhere can be set under **Dazzi Application** in the extension preferences.
- A Dazzi that supports `dazzi --ask` for the two Ask commands. An older Dazzi shows "Update Dazzi".

## How it works

The extension only uses what the Dazzi app bundle ships:

- `Dazzi.app/Contents/Resources/bin/dazzi` is the `dazzi` command. `--ask QUESTION [--] [path...]` asks AI Search and `[--] path...` opens or reveals paths. A running Dazzi receives the request over its local socket; if Dazzi isn't running, the command starts it.
- `Dazzi.app/Contents/Resources/tools/bin/autorag lite retrieve --json` is Dazzi's bundled librarian. It runs model-free retrieval over the same index the app keeps, with the app's tools first on `PATH`, the same way the app runs them.

## Development

```sh
npm install
npm run dev        # ray develop: loads the extension into Raycast
npm test           # vitest: argument building, launcher outcomes, result parsing
npm run lint       # ray lint: manifest, icon, ESLint, Prettier
npm run build
```

The live end-to-end lane that drives Raycast with real keystrokes is `scripts/manual-qa/run-qa-live-raycast.mjs` at the repository root.
