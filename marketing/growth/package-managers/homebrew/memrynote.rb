cask "memrynote" do
  arch arm: "arm64", intel: "x64"

  version "2026-11-11,2026.1111.1"
  sha256 arm:   "5f8e9dcd29bbb3683c9bf984b9fbb252030e12c75b190224bc3e23a3241e7f50",
         intel: "2d8cfb6a80bc9a20e325827bfd3c9054b93c749b96dde38a1c78eebe698f77bc"

  url "https://github.com/memrynote/memry/releases/download/v#{version.csv.first}/MemryNote-#{version.csv.second}-#{arch}.dmg",
      verified: "github.com/memrynote/memry/"
  name "MemryNote"
  desc "Local-first notes, tasks, and projects"
  homepage "https://memrynote.com/"

  livecheck do
    url :url
    regex(%r{/v?(\d{4}-\d{2}-\d{2}(?:\.\d+)?)/MemryNote[._-]v?(\d+(?:\.\d+)+)[._-]#{arch}\.dmg$}i)
    strategy :github_latest do |json, regex|
      json["assets"]&.map do |asset|
        match = asset["browser_download_url"]&.match(regex)
        next if match.blank?

        "#{match[1]},#{match[2]}"
      end
    end
  end

  auto_updates true
  depends_on macos: ">= :monterey"

  app "MemryNote.app"

  zap trash: [
    "~/Library/Application Support/@memry",
    "~/Library/Application Support/memrynote",
    "~/Library/Application Support/MemryNote",
    "~/Library/Caches/@memrydesktop-updater",
    "~/Library/Caches/com.memrynote.memry",
    "~/Library/Caches/com.memrynote.memry.ShipIt",
    "~/Library/Caches/memrynote-updater",
    "~/Library/HTTPStorages/com.memrynote.memry",
    "~/Library/Logs/@memry",
    "~/Library/Logs/memrynote",
    "~/Library/Preferences/com.memrynote.memry.plist",
    "~/Library/Saved Application State/com.memrynote.memry.savedState",
  ]
end
