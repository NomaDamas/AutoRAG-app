import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { datasourceSupported } from "../../../shared/messenger-platform";

/**
 * Progressive-disclosure setup skills for every built-in Dazzi datasource.
 *
 * Instead of bloating every Settings assistant system prompt with all 16
 * datasource manuals, each Settings assistant receives a compact
 * `<available_skills>` index of addable datasources and loads the full
 * installation, configuration, and troubleshooting guide on demand via
 * `load_datasource_setup_skill` (mirroring AutoRAG's own `load_datasource_skill`
 * pattern).
 */

export const LOAD_DATASOURCE_SETUP_SKILL_TOOL_NAME = "load_datasource_setup_skill";

export interface DatasourceSetupSkill {
	readonly name: string;
	readonly templateId: string;
	readonly label: string;
	readonly binary: string | null;
	readonly bundledInApp: boolean;
	readonly macOnly?: boolean;
	/** Opaque skill location (never a host filesystem path). */
	readonly location: string;
	/** One-line summary shown in the `<available_skills>` listing. */
	readonly description: string;
	/** Full setup, installation, configuration, and troubleshooting guide. */
	readonly content: string;
}

function skillLocation(name: string): string {
	return `dazzi-setup-skill://${name}`;
}

function makeSkill(
	input: Omit<DatasourceSetupSkill, "name" | "location" | "content"> & { readonly contentLines: readonly string[] },
): DatasourceSetupSkill {
	const name = `datasource-setup-${input.templateId}`;
	return {
		name,
		templateId: input.templateId,
		label: input.label,
		binary: input.binary,
		bundledInApp: input.bundledInApp,
		...(input.macOnly === undefined ? {} : { macOnly: input.macOnly }),
		location: skillLocation(name),
		description: input.description,
		content: input.contentLines.join("\n"),
	};
}

export const DATASOURCE_SETUP_SKILLS: readonly DatasourceSetupSkill[] = [
	makeSkill({
		templateId: "hister",
		label: "Hister (Browser history)",
		binary: "hister",
		bundledInApp: false,
		description:
			"Built-in datasource (NOT MCP) for browser web history via a local Hister server (`hister` CLI, `brew install hister`, `http://127.0.0.1:4433`).",
		contentLines: [
			"# Hister — Browser Web History Datasource Setup",
			"",
			"**Type:** Built-in datasource (`type: \"hister\"` in `config.json` under `datasources.<alias>`). **Never** install Hister as an MCP server in `mcp.json`.",
			"**Packaging:** Hister (AGPL-3.0-or-later) is NOT bundled in Dazzi; install and run it as a separate program via `bash`.",
			"",
			"## 1. Check & Install via `bash`",
			"1. Check if `hister` (or its renamed Homebrew binary `nogon`) is installed and running:",
			"   - `command -v hister || command -v nogon`",
			"   - `curl -fsS http://127.0.0.1:4433/api/config` (or `hister doctor` / `nogon doctor`)",
			"2. If missing on macOS/Linux with Homebrew, install directly:",
			"   - `brew install hister` (Note: newer Homebrew formula `hister` installs as `nogon`, which serves the same Hister HTTP API on `http://127.0.0.1:4433`.)",
			"   - If Homebrew is unavailable, check GitHub releases (`https://github.com/asciimoo/hister/releases`) or install with `web_search` / `bash`.",
			"3. Start the server as a background service so it stays up for the browser extension and Dazzi:",
			"   - macOS (Homebrew): run `brew services start nogon` (if `nogon` was installed) or `brew services start hister` (for older `hister` installs).",
			"   - Fallback if `brew services` fails (e.g. headless/non-brew): start `nohup nogon listen >/tmp/hister.log 2>&1 &` or `nohup hister listen >/tmp/hister.log 2>&1 &` (serves `http://127.0.0.1:4433` by default).",
			"4. Verify reachability: `curl -fsS http://127.0.0.1:4433/api/config` (wait 1-2s after starting if needed) and `hister doctor` / `nogon doctor`.",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"hister\"` (default alias `hister` or e.g. `browser`) and `connector: { baseUrl: \"http://127.0.0.1:4433\" }` (or update an existing entry with `update_datasource_connector`). Note: setting `baseUrl: \"http://127.0.0.1:4433\"` ensures Dazzi detects the running `nogon`/`hister` server as `installed` even when the binary is named `nogon`.",
			"- Supported connector fields: `baseUrl` (default `http://127.0.0.1:4433`; must be `https://` for non-loopback hosts when `tokenEnv` is set), `tokenEnv` (optional, default `HISTER_TOKEN`), `semantic` (boolean, default `false`), `timeoutMs`.",
			"- If Hister requires an access token (`authenticated: false`), call `set_datasource_credential` with `envName: \"HISTER_TOKEN\"` (never put plaintext tokens in config or chat).",
			"- Optional shared semantic search: run `autorag setup --sync-hister` (requires local `inl serve` daemon) so Hister shares AutoRAG's embedding model, verify `hister doctor` shows `server.index.embeddings` ok, then set `connector.semantic: true`.",
			"",
			"## 3. Remaining Manual Steps & Privacy Note",
			"- Browser extension: tell the user to install the Hister Chrome or Firefox extension so visited pages are captured live.",
			"- Before running `hister import browser history --start-date YYYY-MM-DD`, warn the user to configure a privacy skip list in Hister's `rules.json` (backfill re-fetches URLs without cookies).",
			"- Re-run `get_datasources` to confirm `installState` is `installed` and `status` is `ready`.",
		],
	}),
	makeSkill({
		templateId: "slack",
		label: "Slack",
		binary: "slacrawl",
		bundledInApp: true,
		description:
			"Built-in datasource for local Slack archives via `slacrawl` (`syncSource: 'wiretap'`, requires Slack Desktop + `workspace` team id).",
		contentLines: [
			"# Slack Datasource Setup (`slacrawl`)",
			"",
			"**Type:** Built-in datasource (`type: \"slack\"`).",
			"**CLI:** `slacrawl` (bundled in packaged Dazzi; fallback: GitHub `openclaw/slacrawl` releases or `go install`).",
			"",
			"## 1. Check Prerequisites via `bash`",
			"1. Verify binary: `which slacrawl && slacrawl --version`.",
			"   - If missing on macOS/Linux/Windows, check `~/.local/bin`, `~/go/bin`, or download from `https://github.com/openclaw/slacrawl/releases` and point `connector.binaryPath` if outside `PATH`.",
			"2. Check Slack Desktop app presence (required for `wiretap` desktop cache import). If missing on macOS and the user asked to install it, you can run `brew install --cask slack`.",
			"3. Initialize / inspect local archive:",
			"   - `slacrawl init -db ~/.slacrawl/slacrawl.db -workspace local` (if not yet initialized)",
			"   - `slacrawl sync --source wiretap`",
			"   - Find the real Slack team ID (REQUIRED — unscoped reads return nothing!):",
			"     `slacrawl sql 'select id, count(*) from workspaces join messages on messages.workspace_id = workspaces.id group by 1;'`",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"slack\"` (defaults to `connector.syncSource: \"wiretap\"`) and set `connector.workspace` to the real team ID (e.g. `T0123456789`) via `add_datasource` or `update_datasource_connector`.",
			"- Other connector fields: `configPath`, `databasePath`, `sourcePath`, `binaryPath`, `timeoutMs`, `indexTimeoutMs`, `maxBufferBytes`, `env`.",
			"",
			"## 3. Troubleshooting",
			"- macOS needs Full Disk Access granted to Dazzi/terminal to read Slack Desktop's cache.",
			"- Empty search results with messages present almost always mean `connector.workspace` is missing or set to `local` instead of the real `T...` team id.",
			"- Re-run `get_datasources` to verify status.",
		],
	}),
	makeSkill({
		templateId: "discord",
		label: "Discord",
		binary: "discrawl",
		bundledInApp: true,
		description:
			"Built-in datasource for local Discord archives via `discrawl` (token-free Discord Desktop wiretap, `discrawl doctor`).",
		contentLines: [
			"# Discord Datasource Setup (`discrawl`)",
			"",
			"**Type:** Built-in datasource (`type: \"discord\"`). Token-free wiretap import — never configure a Discord bot/user token.",
			"**CLI:** `discrawl` (bundled in packaged Dazzi; fallback: GitHub `openclaw/discrawl` releases).",
			"",
			"## 1. Check Prerequisites via `bash`",
			"1. Verify binary: `which discrawl && discrawl --version`.",
			"2. Check Discord Desktop app; if missing on macOS and user asks to install, `brew install --cask discord`.",
			"3. Inspect status: `discrawl doctor` and `discrawl --json status`.",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"discord\"`.",
			"- Optional connector fields: `guildId`, `defaultMode` (`hybrid` | `fts` | `semantic`), `binaryPath`, `configPath`, `root`, `workspacePath`, `embedLimit`, `timeoutMs`, `maxBufferBytes`, `env`.",
			"- Avoid setting `configPath` unless the user owns a custom discrawl config (leaving it unset lets AutoRAG manage `[search.embeddings]` automatically).",
			"",
			"## 3. Verify",
			"- Re-run `get_datasources`; if the user asked to sync, call `sync_datasource` with `confirmedByUser: true`.",
		],
	}),
	makeSkill({
		templateId: "kakao",
		label: "KakaoTalk",
		binary: "lazykatok",
		bundledInApp: true,
		macOnly: true,
		description:
			"macOS-only built-in datasource for KakaoTalk via `lazykatok` (>= 0.3.3, requires KakaoTalk for Mac + Full Disk Access).",
		contentLines: [
			"# KakaoTalk Datasource Setup (`lazykatok`, macOS-only)",
			"",
			"**Type:** Built-in datasource (`type: \"kakao\"`). **macOS only** (refuse on Windows/Linux).",
			"**CLI:** `lazykatok` >= 0.3.3 (bundled in packaged Dazzi on macOS; fallback: GitHub `changeroa/lazykatok` releases).",
			"",
			"## 1. Check Prerequisites via `bash`",
			"1. Verify binary & version: `which lazykatok && lazykatok --version` (must be >= 0.3.3 for shared embedder support).",
			"2. Check KakaoTalk Desktop app (`/Applications/KakaoTalk.app`) and run `lazykatok doctor`.",
			"3. Default native store: `~/Library/Application Support/katok`.",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"kakao\"` (defaults to `connector.source: \"macos\"` on macOS).",
			"- Optional connector fields: `workspacePath`, `configPath`, `source`, `binaryPath`, `timeoutMs`, `indexTimeoutMs` (large archives can take ~10+ min), `maxBufferBytes`, `env`.",
			"",
			"## 3. Troubleshooting",
			"- Reading KakaoTalk on macOS requires **Full Disk Access** (Privacy & Security → Full Disk Access for Dazzi). If `lazykatok doctor` reports permission denied, tell the user to grant Full Disk Access in System Settings.",
			"- Re-run `get_datasources` to verify status.",
		],
	}),
	makeSkill({
		templateId: "telegram",
		label: "Telegram",
		binary: "telecrawl",
		bundledInApp: true,
		description:
			"Built-in datasource for local Telegram Desktop archives via `telecrawl` (`~/.telecrawl/telecrawl.db`).",
		contentLines: [
			"# Telegram Datasource Setup (`telecrawl`)",
			"",
			"**Type:** Built-in datasource (`type: \"telegram\"`).",
			"**CLI:** `telecrawl` (bundled in packaged Dazzi; fallback: GitHub `openclaw/telecrawl` releases).",
			"",
			"## 1. Check Prerequisites via `bash`",
			"1. Verify binary: `which telecrawl && telecrawl --version`.",
			"2. Check Telegram Desktop app (macOS installable via `brew install --cask telegram-desktop` if missing and requested).",
			"3. Inspect archive / status: check `~/.telecrawl/telecrawl.db` or run `telecrawl --help` / `telecrawl doctor`.",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"telegram\"`.",
			"- Optional connector fields: `databasePath`, `sourcePath`, `configPath`, `syncSource`, `binaryPath`, `timeoutMs`, `indexTimeoutMs`, `maxBufferBytes`, `env`.",
			"- Note: macOS needs Full Disk Access to read Telegram Desktop's local cache.",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "whatsapp",
		label: "WhatsApp",
		binary: "wacrawl",
		bundledInApp: true,
		macOnly: true,
		description:
			"Built-in datasource for local WhatsApp archives via `wacrawl` (macOS default, or explicit `sourcePath` on other OSes).",
		contentLines: [
			"# WhatsApp Datasource Setup (`wacrawl`)",
			"",
			"**Type:** Built-in datasource (`type: \"whatsapp\"`).",
			"**Platform:** macOS by default (reads WhatsApp for Mac's database); on Windows/Linux only supported when an explicit `connector.sourcePath` is provided.",
			"**CLI:** `wacrawl` (bundled in packaged Dazzi; fallback: GitHub `openclaw/wacrawl` releases).",
			"",
			"## 1. Check Prerequisites via `bash`",
			"1. Verify binary: `which wacrawl && wacrawl --version`.",
			"2. Check WhatsApp Desktop app (macOS: `/Applications/WhatsApp.app`, installable via `brew install --cask whatsapp` if requested).",
			"3. Check `~/.wacrawl/wacrawl.db` or run `wacrawl doctor`.",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"whatsapp\"` (pass `connector.sourcePath` if off macOS).",
			"- Optional connector fields: `databasePath`, `sourcePath`, `configPath`, `syncSource`, `binaryPath`, `timeoutMs`, `indexTimeoutMs`, `maxBufferBytes`, `env`.",
			"- Note: macOS needs Full Disk Access for reading WhatsApp's desktop database.",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "lark",
		label: "Lark / Feishu",
		binary: "lark-cli",
		bundledInApp: true,
		description:
			"Built-in live-search datasource for Lark/Feishu via `lark-cli` (`npm install -g @larksuite/cli`, explicit search scopes).",
		contentLines: [
			"# Lark / Feishu Datasource Setup (`lark-cli`)",
			"",
			"**Type:** Built-in live-search datasource (`type: \"lark\"`, `polling: false` — queried live, no local archive).",
			"**CLI:** `lark-cli` (bundled in packaged Dazzi; fallback: `npm install -g @larksuite/cli` or GitHub `larksuite/cli`).",
			"",
			"## 1. Check & Install via `bash`",
			"1. Check binary: `which lark-cli && lark-cli --version`. If missing, run `npm install -g @larksuite/cli`.",
			"2. Check login state: `lark-cli auth status --json`.",
			"3. If not logged in or missing scopes, note that login requires explicit scopes:",
			"   `lark-cli auth login --scope \"search:message,search:docs:read\"`",
			"   (Plain `--recommend` does NOT grant those search scopes. Interactive browser login requires the user to complete OAuth.)",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"lark\"`.",
			"- Connector fields: `binaryPath`, `embedderBaseUrl` (must never be remote).",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "notion",
		label: "Notion",
		binary: "notcrawl",
		bundledInApp: true,
		description:
			"Built-in datasource for Notion archives via `notcrawl` (uses notcrawl's own config/auth, not a Notion API token in Dazzi).",
		contentLines: [
			"# Notion Datasource Setup (`notcrawl`)",
			"",
			"**Type:** Built-in datasource (`type: \"notion\"`). AutoRAG uses `notcrawl` directly — do not store a Notion API token in Dazzi config.",
			"**CLI:** `notcrawl` (bundled in packaged Dazzi; fallback: GitHub `openclaw/notcrawl` releases).",
			"",
			"## 1. Check Prerequisites via `bash`",
			"1. Verify binary: `which notcrawl && notcrawl --version`.",
			"2. Check existing config/archive (`~/.notcrawl/config.toml` or `notcrawl doctor` / `notcrawl status`).",
			"3. Check Notion Desktop app if applicable (macOS: `brew install --cask notion` if missing and requested).",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"notion\"` (optionally set `connector.configPath` if non-default).",
			"- Optional connector fields: `configPath`, `databasePath`, `sourcePath`, `syncSource`, `binaryPath`, `timeoutMs`, `indexTimeoutMs`, `maxBufferBytes`, `env`.",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "obsidian",
		label: "Obsidian",
		binary: null,
		bundledInApp: true,
		description:
			"Built-in datasource for local Obsidian markdown vaults (no CLI to install; discover `.obsidian` folders and set `connector.vaultPath`).",
		contentLines: [
			"# Obsidian Datasource Setup",
			"",
			"**Type:** Built-in datasource (`type: \"obsidian\"`). Indexed by MinSync in its own workspace — no external CLI needed.",
			"",
			"## 1. Discover Local Vault(s) via `bash`",
			"1. Unless the user already gave an exact path, search for `.obsidian` directories under `~` (e.g. `find ~ -maxdepth 4 -name .obsidian -type d 2>/dev/null`) or check Obsidian's own registry (`~/Library/Application Support/obsidian/obsidian.json` on macOS, `%APPDATA%/obsidian/obsidian.json` on Windows, `~/.config/obsidian/obsidian.json` on Linux).",
			"2. Verify the chosen vault directory exists and contains `.md` files.",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"obsidian\"` and `connector: { vaultPath: \"/absolute/path/to/vault\" }` (use a distinct `alias` when connecting multiple vaults).",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "clawgallery",
		label: "ClawGallery",
		binary: "clawgallery",
		bundledInApp: true,
		description:
			"Built-in datasource for local screenshots and photos via `clawgallery` (`cargo install clawgallery`, `connector.path`).",
		contentLines: [
			"# ClawGallery Datasource Setup (`clawgallery`)",
			"",
			"**Type:** Built-in datasource (`type: \"clawgallery\"`).",
			"**CLI:** `clawgallery` (bundled in packaged Dazzi; fallback: `cargo install clawgallery`).",
			"",
			"## 1. Check & Install via `bash`",
			"1. Verify binary: `which clawgallery && clawgallery --version`.",
			"2. If missing and Rust/Cargo is available, install with `cargo install clawgallery` (and check `~/.cargo/bin/clawgallery`).",
			"3. Check the target image/screenshot folder exists (e.g. `~/Desktop` or user-specified path).",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"clawgallery\"` and `connector: { path: \"/path/to/images\" }`.",
			"- Optional connector fields: `configDir`, `defaultMode` (`hybrid` | `keyword` | `lexical` | `embedding`), `vdrBackend` (`mlx` | `jina-mlx` | `vsplade` | `inl`), `syncVisual` (boolean, default `true`), `binaryPath`, `timeoutMs`, `maxBufferBytes`, `env`.",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "wombat",
		label: "AI Sessions (wombat)",
		binary: "wombat",
		bundledInApp: true,
		description:
			"Built-in datasource for coding-agent session logs (Claude Code, Codex, pi, omp, opencode, etc.) via `wombat` (`cargo install wombat-sessions`).",
		contentLines: [
			"# AI Sessions Datasource Setup (`wombat`)",
			"",
			"**Type:** Built-in datasource (`type: \"wombat\"`). Searches past coding-agent conversations from 20+ CLI agents (`claude-code`, `codex`, `opencode`, `pi`, `omp`, `gemini`, `aider`, `copilot`, etc.).",
			"**CLI:** `wombat` >= 0.1.3 (bundled in packaged Dazzi; fallback: `cargo install wombat-sessions`, installs to `~/.cargo/bin/wombat`).",
			"",
			"## 1. Check & Install via `bash`",
			"1. Verify binary: `which wombat || ls -la ~/.cargo/bin/wombat` and `wombat --version`.",
			"2. If missing, run `cargo install wombat-sessions` (if `cargo` is available).",
			"3. Inspect detected sessions: `wombat doctor --json`.",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"wombat\"`.",
			"- Optional connector fields: `agents` (array of agent ids to restrict scope), `includeSubagents`, `includeEphemeral`, `dataDir` (default `~/.wombat`), `binaryPath` (set to `~/.cargo/bin/wombat` if not on default `PATH`), `timeoutMs`, `indexTimeoutMs`, `maxBufferBytes`, `env`.",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "mailcrawl",
		label: "Mail (mailcrawl)",
		binary: "mailcrawl",
		bundledInApp: true,
		description:
			"Built-in datasource for Gmail/IMAP/Maildir/Apple Mail/`.eml`/`.mbox` via `mailcrawl` (>= 0.3.0, `@nomadamas/mailcrawl`, Himalaya or `source: 'files'`).",
		contentLines: [
			"# Mail Datasource Setup (`mailcrawl`)",
			"",
			"**Type:** Built-in datasource (`type: \"mailcrawl\"`). Covers Gmail, IMAP, Maildir, Apple Mail, and `.eml`/`.mbox` files.",
			"**CLI:** `mailcrawl` >= 0.3.0 (bundled in packaged Dazzi alongside `himalaya`; fallback: `npm install -g @nomadamas/mailcrawl` — NEVER use <= 0.1.3).",
			"",
			"## 1. Check & Install via `bash`",
			"1. Verify binary & version: `which mailcrawl && mailcrawl --version` (must be >= 0.3.0). If missing or outdated, run `npm install -g @nomadamas/mailcrawl@latest`.",
			"2. Inspect status: `mailcrawl doctor` and `mailcrawl status`.",
			"3. Determine mail source:",
			"   - **Himalaya / IMAP / Gmail**: check `which himalaya` and `~/.config/himalaya/config.toml` (`himalaya account list`). Never print or copy IMAP passwords/tokens.",
			"   - **Local files / Apple Mail**: set `connector.source: \"files\"` and `connector.paths: [\"/path/to/mail\"]` (e.g. `.eml`/`.mbox` folder or `~/Library/Mail` on macOS — note macOS requires Full Disk Access for `~/Library/Mail`).",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"mailcrawl\"` and the detected `connector` (`account`/`mailbox` for Himalaya, or `source: \"files\"` + `paths` for local mail).",
			"- Optional connector fields: `account`, `mailbox`, `dataDir`, `backend`, `source`, `paths`, `fixture`, `himalayaConfig`, `concurrency`, `binaryPath`, `timeoutMs`, `indexTimeoutMs`, `maxBufferBytes`, `env`.",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "github",
		label: "GitHub",
		binary: null,
		bundledInApp: true,
		description:
			"Built-in datasource for GitHub issues & PRs (no CLI needed; requires `connector.repos` and `GITHUB_TOKEN` via `set_datasource_credential`).",
		contentLines: [
			"# GitHub Datasource Setup",
			"",
			"**Type:** Built-in REST datasource (`type: \"github\"`). No CLI installation needed.",
			"",
			"## 1. Configure Repositories & Token",
			"1. Determine `owner/repo` list (can inspect local git remotes with `bash` if user refers to a local repo, or ask if unspecified).",
			"2. Call `add_datasource` with `type: \"github\"` and `connector: { repos: [\"owner/repo\"], tokenEnv: \"GITHUB_TOKEN\" }`.",
			"3. Store the GitHub token safely via `set_datasource_credential` (`envName: \"GITHUB_TOKEN\"`) — NEVER paste tokens in chat or write raw tokens into config.",
			"",
			"## 2. Verify",
			"- Optional connector fields: `repos`, `tokenEnv`, `baseUrl`, `timeoutMs`, `maxPages`, `maxDocuments`.",
			"- Re-run `get_datasources` to confirm `installState` is `builtin` (not `credential-missing`).",
		],
	}),
	makeSkill({
		templateId: "github-gist",
		label: "GitHub Gist",
		binary: null,
		bundledInApp: true,
		description:
			"Built-in datasource for the user's GitHub Gists (uses `GITHUB_TOKEN` via `set_datasource_credential` or `gh auth` fallback).",
		contentLines: [
			"# GitHub Gist Datasource Setup",
			"",
			"**Type:** Built-in datasource (`type: \"github-gist\"`). Indexes the authenticated account's public and secret gists.",
			"",
			"## 1. Check Auth & Configure",
			"1. Check if `gh` CLI is installed and authenticated (`which gh && gh auth status`) — `ghCliFallback: true` (default) can use `gh auth` automatically.",
			"2. If neither `GITHUB_TOKEN` nor `gh auth` is set up, either call `set_datasource_credential` (`envName: \"GITHUB_TOKEN\"`) or help install `gh` (`brew install gh`).",
			"3. Call `add_datasource` with `type: \"github-gist\"`.",
			"- Optional connector fields: `tokenEnv`, `ghCliFallback`, `baseUrl`, `statePath`, `timeoutMs`, `maxPages`, `maxGists`.",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "rss",
		label: "RSS / News",
		binary: null,
		bundledInApp: true,
		description:
			"Built-in datasource for RSS 2.0 / Atom feeds (no CLI needed; configure `connector.feeds: [{ url, category? }]`).",
		contentLines: [
			"# RSS / News Datasource Setup",
			"",
			"**Type:** Built-in datasource (`type: \"rss\"`). Nothing to install; fetches RSS 2.0 and Atom feeds over HTTP.",
			"",
			"## 1. Configure Feeds",
			"1. If the user names a blog/publication without a feed URL, use `web_search` or `web_fetch` to find its exact RSS/Atom URL.",
			"2. Call `add_datasource` (or `update_datasource_connector`) with `connector: { feeds: [{ url: \"https://example.com/feed.xml\", category: \"tech\" }] }`.",
			"- Optional connector fields: `feeds`, `maxItemsPerFeed`, `maxDocuments`, `maxContentChars`, `timeoutMs`.",
			"- Re-run `get_datasources` to verify.",
		],
	}),
	makeSkill({
		templateId: "calendar",
		label: "Apple Calendar & Reminders",
		binary: "npx",
		bundledInApp: false,
		macOnly: true,
		description:
			"macOS-only built-in datasource template for Apple Calendar & Reminders (EventKit via `npx -y mcp-server-apple-events`, auto-synced by Dazzi).",
		contentLines: [
			"# Apple Calendar & Reminders Datasource Setup (macOS-only)",
			"",
			"**Type:** Built-in datasource template (`type: \"calendar\"`). **macOS only** (EventKit). Dazzi manages its underlying `mcp-server-apple-events` registration automatically when you add it via `add_datasource` — do NOT hand-edit `mcp.json` separately.",
			"",
			"## 1. Check Prerequisites via `bash`",
			"1. Verify Node.js 20+ and `npx` are available: `which npx && node --version`.",
			"   - If missing on macOS, install Node via `brew install node` (or check bundled Node).",
			"",
			"## 2. Wire the Datasource in Dazzi",
			"- Call `add_datasource` with `type: \"calendar\"` (defaults to `requireWriteConfirmation: true`, `exposure: \"codemode\"`, `command: \"npx\"`).",
			"- Optional connector fields: `requireWriteConfirmation`, `exposure` (`codemode` | `direct` | `deferred` | `hidden`), `command`, `args`.",
			"",
			"## 3. Manual OS Permission",
			"- Remind the user that macOS requires Privacy & Security → Calendars and Reminders access for Dazzi, and calendars must be visible in Apple Calendar.app / Reminders.app.",
			"- Re-run `get_datasources` to verify.",
		],
	}),
];

const SKILL_BY_NAME: Readonly<Map<string, DatasourceSetupSkill>> = new Map(
	DATASOURCE_SETUP_SKILLS.map((skill) => [skill.name.toLowerCase(), skill]),
);

const SKILL_BY_TEMPLATE_ID: Readonly<Map<string, DatasourceSetupSkill>> = new Map(
	DATASOURCE_SETUP_SKILLS.map((skill) => [skill.templateId.toLowerCase(), skill]),
);

const SKILL_BY_BINARY: Readonly<Map<string, DatasourceSetupSkill>> = new Map(
	DATASOURCE_SETUP_SKILLS.filter((skill) => skill.binary !== null && skill.binary !== "npx").map((skill) => [
		skill.binary!.toLowerCase(),
		skill,
	]),
);

const SKILL_ALIAS_MAP: Readonly<Record<string, string>> = {
	kakaotalk: "kakao",
	"kakao talk": "kakao",
	feishu: "lark",
	"lark/feishu": "lark",
	"ai sessions": "wombat",
	"coding sessions": "wombat",
	mail: "mailcrawl",
	email: "mailcrawl",
	gist: "github-gist",
	gists: "github-gist",
	news: "rss",
	"browser history": "hister",
	"apple calendar": "calendar",
	"apple-events": "calendar",
	reminders: "calendar",
};

/** Resolve a setup skill by exact skill name (`datasource-setup-hister`), template id (`hister`), CLI binary (`slacrawl`), or common alias. */
export function resolveDatasourceSetupSkill(rawName: string): DatasourceSetupSkill | undefined {
	const key = rawName.trim().toLowerCase();
	if (key.length === 0) return undefined;
	const direct = SKILL_BY_NAME.get(key) ?? SKILL_BY_TEMPLATE_ID.get(key) ?? SKILL_BY_BINARY.get(key);
	if (direct !== undefined) return direct;
	const aliased = SKILL_ALIAS_MAP[key];
	if (aliased !== undefined) return SKILL_BY_TEMPLATE_ID.get(aliased);
	return undefined;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&apos;");
}

/** Format a loaded skill in the same `<skill name="..." location="...">` shape AutoRAG uses. */
export function formatDatasourceSetupSkillInvocation(skill: DatasourceSetupSkill): string {
	return `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.location)}">\n${skill.content}\n</skill>`;
}

/**
 * Render the progressive-disclosure `<available_skills>` block listing every
 * addable datasource and its dynamically loadable setup skill.
 */
export function buildDatasourceSetupSkillsPrompt(platform: NodeJS.Platform = process.platform): string {
	const lines = [
		"## Addable Datasources & Dynamic Setup Skills",
		`Every built-in datasource listed below is a **Datasource Connection** (\`datasources.<alias>\` in \`config.json\`), NOT an MCP server. Before installing, connecting, or fixing any datasource, call \`${LOAD_DATASOURCE_SETUP_SKILL_TOOL_NAME}\` to load its exact setup, installation, config, and troubleshooting instructions.`,
		"",
		"<available_skills>",
	];
	for (const skill of DATASOURCE_SETUP_SKILLS) {
		const supported = datasourceSupported(skill.templateId, platform);
		const osTag = supported ? "" : ` [unsupported on ${platform}; macOS only]`;
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(`${skill.description}${osTag}`)}</description>`);
		lines.push(`    <location>${escapeXml(skill.location)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

/** Dynamic tool that loads the full install/setup/connect skill for one built-in datasource on demand. */
export function createLoadDatasourceSetupSkillTool(): ToolDefinition {
	return defineTool({
		name: LOAD_DATASOURCE_SETUP_SKILL_TOOL_NAME,
		label: "Load Datasource Setup Skill",
		description:
			"Dynamically load the full installation, configuration, verification, and troubleshooting skill for one built-in Dazzi datasource (e.g. `datasource-setup-hister` or `hister`, `slack`, `discord`, `kakao`, `telegram`, `whatsapp`, `lark`, `notion`, `obsidian`, `clawgallery`, `wombat`, `mailcrawl`, `github`, `github-gist`, `rss`, `calendar`). Call this before installing, connecting, or repairing a datasource.",
		parameters: Type.Object({
			name: Type.String({
				description:
					"Skill name from `<available_skills>` (e.g. `datasource-setup-hister`) or datasource template id / CLI name (e.g. `hister`, `slack`, `slacrawl`, `mailcrawl`).",
			}),
		}),
		execute: async (_callId, params) => {
			const skill = resolveDatasourceSetupSkill(params.name);
			if (skill === undefined) {
				const available = DATASOURCE_SETUP_SKILLS.map((entry) => entry.name).join(", ");
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown datasource setup skill "${params.name}". Available skills: ${available}.`,
						},
					],
					details: { skill: params.name, templateId: null as string | null, loaded: false },
				};
			}
			return {
				content: [{ type: "text" as const, text: formatDatasourceSetupSkillInvocation(skill) }],
				details: { skill: skill.name, templateId: skill.templateId as string | null, loaded: true },
			};
		},
	});
}
