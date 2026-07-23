#!/usr/bin/env node
// Renders the Homebrew cask for MemryNote from release inputs so publish-release
// can push it to memrynote/homebrew-tap on every release (no manual brew edits).
//
// Usage:
//   node scripts/generate-homebrew-cask.mjs \
//     --tag v2026-07-01.2 --app-version 2026.701.2 --sha-arm <hex> --sha-x64 <hex>
//   node scripts/generate-homebrew-cask.mjs --selfcheck
import assert from 'node:assert/strict'

export function renderCask({ tag, appVersion, shaArm, shaX64 }) {
  for (const [field, value] of Object.entries({ tag, appVersion, shaArm, shaX64 })) {
    if (!value) throw new Error(`Missing required field: ${field}`)
  }
  assert.match(shaArm, /^[0-9a-f]{64}$/, 'sha-arm must be a 64-char hex sha256')
  assert.match(shaX64, /^[0-9a-f]{64}$/, 'sha-x64 must be a 64-char hex sha256')

  // csv.first drives the /v<tag>/ download path; csv.second drives the DMG
  // filename (MemryNote-<appVersion>-<arch>.dmg). Keep both interpolations so the
  // cask stays a single source of truth even when hand-inspected.
  const tagVersion = tag.replace(/^v/, '')

  return `cask "memry" do
  arch arm: "arm64", intel: "x64"

  version "${tagVersion},${appVersion}"
  sha256 arm:   "${shaArm}",
         intel: "${shaX64}"

  url "https://github.com/memrynote/memry/releases/download/v#{version.csv.first}/MemryNote-#{version.csv.second}-#{arch}.dmg",
      verified: "github.com/memrynote/memry/"
  name "MemryNote"
  desc "Local-first notes, tasks, and projects"
  homepage "https://memrynote.com/"

  livecheck do
    url :url
    regex(%r{/v?(\\d{4}-\\d{2}-\\d{2}(?:\\.\\d+)?)/Memry(?:note)?[._-]?v?(\\d+(?:\\.\\d+)+)[._-]#{arch}\\.dmg$}i)
    strategy :github_latest do |json, regex|
      json["assets"]&.map do |asset|
        match = asset["browser_download_url"]&.match(regex)
        next if match.blank?

        "#{match[1]},#{match[2]}"
      end
    end
  end

  depends_on macos: :monterey

  app "MemryNote.app"

  # Three naming eras coexist. Today app.name is package.json "name"
  # (@memry/desktop) — electron-builder never writes productName into the asar —
  # so live app state (Chromium profile, crdt-store, models, config) sits under
  # @memry/, logs under Logs/@memry, and electron-updater's cache under
  # @memrydesktop-updater (name with "/" sanitized). The memrynote entries cover
  # the runtime identity rename (PR #897) that moves userData/logs/updater cache
  # there; @memry* entries stay for not-yet-migrated installs. MemryNote entries
  # are aspirational but harmless — kept. Bundle-id (com.memrynote.memry) keys
  # Caches/HTTPStorages/Preferences/ShipIt and is rename-independent.
  # Vault content (notes + .memry/*.db) lives under the user-chosen vault dir
  # (default ~/Documents/Memry) and is deliberately NOT zapped.
  zap trash: [
    "~/Library/Application Support/@memry",
    "~/Library/Application Support/MemryNote",
    "~/Library/Application Support/memrynote",
    "~/Library/Caches/@memrydesktop-updater",
    "~/Library/Caches/com.memrynote.memry",
    "~/Library/Caches/com.memrynote.memry.ShipIt",
    "~/Library/Caches/memrynote-updater",
    "~/Library/HTTPStorages/com.memrynote.memry",
    "~/Library/Logs/@memry",
    "~/Library/Logs/MemryNote",
    "~/Library/Logs/memrynote",
    "~/Library/Preferences/com.memrynote.memry.plist",
    "~/Library/Saved Application State/com.memrynote.memry.savedState",
  ]
end
`
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith('--')) continue
    if (flag === '--selfcheck') {
      args.selfcheck = true
      continue
    }
    args[flag.slice(2)] = argv[++i]
  }
  return args
}

function selfcheck() {
  const out = renderCask({
    tag: 'v2026-07-01.2',
    appVersion: '2026.701.2',
    shaArm: 'a'.repeat(64),
    shaX64: 'b'.repeat(64)
  })
  assert.match(out, /version "2026-07-01\.2,2026\.701\.2"/)
  // The whole reason this exists: url must use the MemryNote- asset prefix.
  assert.match(out, /MemryNote-#\{version\.csv\.second\}-#\{arch\}\.dmg/)
  assert.ok(!/Memry-#\{version\.csv\.second\}/.test(out), 'url must not use stale Memry- prefix')
  // app stanza must match the shipped bundle (productName=MemryNote), not the pre-rename Memry.app.
  assert.match(out, /app "MemryNote\.app"/)
  assert.ok(!/app "Memry\.app"/.test(out), 'app stanza must not use stale Memry.app bundle name')
  assert.match(out, /arm:\s+"a{64}"/)
  assert.match(out, /intel:\s+"b{64}"/)
  // zap must cover the REAL userData parent (@memry — app.name, not productName,
  // drives it) and the electron-updater cache, or --zap leaves all app state behind.
  assert.match(out, /"~\/Library\/Application Support\/@memry"/)
  assert.match(out, /"~\/Library\/Caches\/@memrydesktop-updater"/)
  // ...and the post-identity-rename (PR #897) memrynote paths, so the cask stays
  // correct once userData/logs/updater cache move to the new name.
  assert.match(out, /"~\/Library\/Application Support\/memrynote"/)
  assert.match(out, /"~\/Library\/Caches\/memrynote-updater"/)
  assert.match(out, /"~\/Library\/Logs\/@memry"/)
  // Regex backslashes must survive templating (JS drops unknown escapes).
  assert.match(out, /\\d\{4\}-\\d\{2\}-\\d\{2\}/)
  assert.throws(() =>
    renderCask({ tag: 'v1', appVersion: '', shaArm: 'a'.repeat(64), shaX64: 'b'.repeat(64) })
  )
  assert.throws(() =>
    renderCask({ tag: 'v1', appVersion: '1', shaArm: 'nothex', shaX64: 'b'.repeat(64) })
  )
  console.log('selfcheck ok')
}

const args = parseArgs(process.argv.slice(2))
if (args.selfcheck) {
  selfcheck()
} else {
  process.stdout.write(
    renderCask({
      tag: args.tag,
      appVersion: args['app-version'],
      shaArm: args['sha-arm'],
      shaX64: args['sha-x64']
    })
  )
}
