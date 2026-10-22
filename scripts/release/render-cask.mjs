/**
 * Render the Homebrew cask for one release.
 *
 *   node scripts/release/render-cask.mjs <tag> <sha256> > Casks/dazzi.rb
 *
 * The cask lives in the tap repository (NomaDamas/homebrew-dazzi); the release workflow's
 * `homebrew` job renders it from the published dmg's digest and pushes it there
 * (docs/release.md → "Homebrew").
 */

import { fileURLToPath } from "node:url";

const REPO = "NomaDamas/AutoRAG-app";

/** Cask text for release `tag` (`v1.2.3`) whose arm64 dmg has SHA-256 `sha256`. */
export function renderCask(tag, sha256) {
	const version = /^v?(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
	if (version === undefined) throw new Error(`"${tag}" is not a stable vX.Y.Z tag`);
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 must be 64 lowercase hex digits");
	return `cask "dazzi" do
  arch arm: "arm64"

  version "${version}"
  sha256 arm: "${sha256}"

  url "https://github.com/${REPO}/releases/download/v#{version}/Dazzi-#{version}-#{arch}.dmg",
      verified: "github.com/${REPO}/"
  name "Dazzi"
  desc "Local-first Finder with AI search over your files, powered by AutoRAG"
  homepage "https://github.com/${REPO}"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app updates itself (electron-updater); brew upgrade only needs to catch up, not fight it.
  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Dazzi.app"
  # The dazzi command (dazzi <folder> opens it in Dazzi); the app also links it itself on first start, so either order works.
  binary "#{appdir}/Dazzi.app/Contents/Resources/bin/dazzi"
end
`;
}

function main() {
	const [tag, sha256] = process.argv.slice(2);
	if (tag === undefined || sha256 === undefined) {
		process.stderr.write("usage: render-cask.mjs <tag> <sha256>\n");
		process.exit(2);
	}
	process.stdout.write(renderCask(tag, sha256));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
