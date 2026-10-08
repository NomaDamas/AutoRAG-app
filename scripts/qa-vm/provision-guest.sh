#!/bin/bash
# Provision a macOS VM for the manual-QA lanes. Runs INSIDE the guest, as the
# image's `admin` user, once, while the golden image is built (setup.mjs pipes
# it over ssh). Safe to re-run. Requires SIP to be off already (see setup.mjs).
set -euo pipefail

log() { printf '[provision] %s\n' "$*"; }
export PATH="/opt/homebrew/bin:$HOME/bin:$HOME/tools/node/bin:$PATH"
ARCH=darwin-arm64

mkdir -p "$HOME/bin" "$HOME/tools" "$HOME/Documents" "$HOME/Downloads"

# --- Command Line Tools: git, swift (the drag-out lane compiles os-drag.swift) ---
if ! xcode-select -p >/dev/null 2>&1; then
	log "installing Command Line Tools"
	sudo touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
	label=$(softwareupdate -l 2>&1 | sed -n 's/^\* Label: //p' | grep 'Command Line Tools' | tail -1)
	sudo softwareupdate -i "$label" --verbose
	sudo rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
fi
git config --global --replace-all safe.directory '*'

# --- Rosetta: LaunchServices refuses to open a .app whose executable is not
# Mach-O (error -10669) without it; the app-bundles lane launches a script bundle.
if [ ! -d /Library/Apple/usr/share/rosetta ]; then
	log "installing Rosetta"
	sudo softwareupdate --install-rosetta --agree-to-license
fi

# --- Node and bun, verified against the publishers' checksum lists ---
if [ ! -x "$HOME/tools/node/bin/node" ]; then
	log "installing Node 24"
	sums=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)
	tarball=$(printf '%s\n' "$sums" | awk -v a="$ARCH.tar.gz" '$2 ~ a"$" {print $2; exit}')
	expected=$(printf '%s\n' "$sums" | awk -v t="$tarball" '$2 == t {print $1}')
	curl -fsSL -o "/tmp/$tarball" "https://nodejs.org/dist/latest-v24.x/$tarball"
	[ "$(shasum -a 256 "/tmp/$tarball" | awk '{print $1}')" = "$expected" ] || { echo "node checksum mismatch"; exit 1; }
	tar -xzf "/tmp/$tarball" -C "$HOME/tools"
	ln -sfn "$HOME/tools/${tarball%.tar.gz}" "$HOME/tools/node"
	rm -f "/tmp/$tarball"
fi
if [ ! -x "$HOME/bin/bun" ]; then
	log "installing bun"
	base=https://github.com/oven-sh/bun/releases/latest/download
	curl -fsSL -o /tmp/bun.zip "$base/bun-darwin-aarch64.zip"
	expected=$(curl -fsSL "$base/SHASUMS256.txt" | awk '$2 == "bun-darwin-aarch64.zip" {print $1}')
	[ "$(shasum -a 256 /tmp/bun.zip | awk '{print $1}')" = "$expected" ] || { echo "bun checksum mismatch"; exit 1; }
	unzip -qo /tmp/bun.zip -d "$HOME/tools"
	ln -sf "$HOME/tools/bun-darwin-aarch64/bun" "$HOME/bin/bun"
	rm -f /tmp/bun.zip
fi

# --- Homebrew and ffmpeg (the thumbnail, file-actions, and quick-look lanes encode fixtures) ---
if [ ! -x /opt/homebrew/bin/brew ]; then
	log "installing Homebrew"
	NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
command -v ffmpeg >/dev/null || { log "installing ffmpeg"; /opt/homebrew/bin/brew install ffmpeg; }

# PATH for ssh's non-login shells (zshenv) and for the GUI session's children.
for rc in "$HOME/.zshenv" "$HOME/.zprofile"; do
	grep -q 'tools/node/bin' "$rc" 2>/dev/null || echo 'export PATH=/opt/homebrew/bin:$HOME/bin:$HOME/tools/node/bin:$PATH' >> "$rc"
done

# --- TCC grants (needs SIP off to write the system database) ---
# kTCCServiceScreenCapture: without it `screencapture` fails with "could not
# create image from display" and the quick-look-reference lane cannot run.
# Accessibility and PostEvent let the sshd session drive System Events.
log "granting TCC permissions"
SYSTEM_TCC="/Library/Application Support/com.apple.TCC/TCC.db"
USER_TCC="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
grant() { # db service client client_type indirect_object
	local sql="INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version,csreq,policy_id,indirect_object_identifier_type,indirect_object_identifier,indirect_object_code_identity,flags,last_modified) VALUES ('$2','$3',$4,2,4,1,NULL,NULL,$( [ "$5" = UNUSED ] && echo NULL || echo 0 ),'$5',NULL,0,strftime('%s','now'));"
	if [ "$1" = system ]; then sudo sqlite3 "$SYSTEM_TCC" "$sql"; else sqlite3 "$USER_TCC" "$sql"; fi
}
for service in kTCCServiceScreenCapture kTCCServiceAccessibility kTCCServicePostEvent; do
	for client in com.apple.sshd-session com.apple.sshd-keygen-wrapper com.apple.screencapture com.apple.Terminal; do
		grant system "$service" "$client" 0 UNUSED
	done
	grant system "$service" /usr/libexec/sshd-keygen-wrapper 1 UNUSED
done
# AppleEvents: the recents, drop-attachments, and drag-out lanes script Finder, TextEdit, and System Events.
for target in com.apple.systemevents com.apple.finder com.apple.TextEdit; do
	grant user kTCCServiceAppleEvents /usr/libexec/sshd-keygen-wrapper 1 "$target"
done
sudo killall tccd 2>/dev/null || true

# --- Stability for the lanes ---
# Spotlight off: with indexing on, `mdls` answers "(null)" for new files in
# ~/Documents for minutes after any large sync, and the Kind lane then shows
# the extension fallback ("Markdown") instead of the OS kind.
sudo mdutil -a -i off >/dev/null
# Dock autohide: otherwise the work area changes by one pixel when the Dock
# first draws, which fails the Quick Look lane's exact size assertion.
defaults write com.apple.dock autohide -bool true
defaults write com.apple.dock autohide-delay -float 0
killall Dock 2>/dev/null || true
# A VM that sleeps stops the display the lanes capture.
sudo pmset -a sleep 0 displaysleep 0 disksleep 0
defaults write com.apple.screensaver idleTime -int 0
# No first-run prompts over the apps the lanes drive.
defaults write com.apple.TextEdit NSShowAppCentricOpenPanelInsteadOfUntitledFile -bool false
defaults write com.apple.finder FXEnableExtensionChangeWarning -bool false

# --- Fixture content ---
# A fresh account has an empty ~/Documents. The Finder shows an empty folder
# as an empty-state message with no rows, so every lane that opens on
# ~/Documents and waits for `[role="row"]` times out. A few ordinary files fix that.
mkdir -p "$HOME/Documents/Reports"
for n in 1 2 3; do [ -f "$HOME/Documents/note-$n.txt" ] || echo "sample $n" > "$HOME/Documents/note-$n.txt"; done
[ -f "$HOME/Documents/Reports/summary.md" ] || printf '%s\n' "Summary" > "$HOME/Documents/Reports/summary.md"
# The trash-restore lane lists this directory before anything was trashed;
# macOS only creates it the first time iCloud Drive trashes a file.
mkdir -p "$HOME/Library/Mobile Documents/.Trash" "$HOME/.Trash"

log "done"
