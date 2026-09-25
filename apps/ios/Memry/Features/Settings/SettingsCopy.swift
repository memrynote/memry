import Foundation

// Spec 006. Every sentence Settings shows. Wording mirrors desktop
// `packages/i18n/src/locales/en/settings.json` where a key exists; the rest is
// new copy, logged in spec 006 §6. Footers follow what actually syncs (F2/F3):
// "Shared with your other devices" only on synced fields.
enum SettingsCopy {
    static let title = "Settings"
    static let moreTitle = "More"
    static let shared = "Shared with your other devices."
    static let thisDevice = "This iPhone."
    static let cancel = "Cancel"
    static let done = "Done"
    static let loading = "Loading settings..."

    // Root groups
    static let general = "General"
    static let appearance = "Appearance"
    static let features = "Features"
    static let modules = "Modules"
    static let content = "Content"
    static let data = "Data"
    static let journal = "Journal"
    static let tasks = "Tasks"
    static let inbox = "Inbox"
    static let templates = "Templates"
    static let tags = "Tags"
    static let properties = "Properties"
    static let vaults = "Vaults"
    static let about = "About"
    static func featuresOn(_ count: Int) -> String { "\(count) on" }

    // Account card and status
    static let account = "Account"
    static let endToEnd = "End-to-end encrypted"
    static let syncGroup = "Sync"
    static let status = "Status"
    static let syncNow = "Sync now"
    static let syncing = "Syncing…"
    static let synced = "Synced"
    static let neverSynced = "Not synced yet"
    static let offline = "Offline"
    static func syncedAgo(_ ago: String) -> String { "Synced · \(ago)" }
    static func pending(_ count: Int) -> String { count == 1 ? "1 change waiting" : "\(count) changes waiting" }
    static let downloadAttachments = "Download attachments"
    static let downloadAlways = "Always"
    static let downloadWifi = "On Wi-Fi"
    static let downloadNever = "Never"
    static let downloadFooter = "This iPhone. An attachment you open always downloads."
    static let planAndDevices = "Plan and devices"
    static let plan = "Plan"
    static let storage = "Storage"
    static let devices = "Devices"
    static let planFooter = "Plans are managed in memrynote on your computer."
    static func planLine(_ plan: String, _ status: String) -> String { "\(plan) · \(status)" }
    static func storageLine(_ used: String, _ limit: String) -> String { "\(used) of \(limit)" }

    // Storage
    static func usedOf(_ limit: String) -> String { "of \(limit) used" }
    static let notes = "Notes"
    static let attachments = "Attachments"
    static let editHistory = "Edit history (CRDT)"
    static let other = "Other"
    static func planLimits(plan: String, maxFile: String, vaults: Int64, days: Int64) -> String {
        let vaultText = vaults > 0 ? "\(vaults) vaults" : "unlimited vaults"
        return "\(plan) plan: \(maxFile) max file, \(vaultText), \(days) days of history."
    }
    static let nearLimit = "Notes near the sync limit"
    static func notSyncing(_ size: String) -> String { "Not syncing · \(size)" }
    static func approaching(_ size: String) -> String { "Approaching the limit · \(size)" }
    static func limitFooter(_ max: String) -> String {
        "Notes larger than \(max) stop syncing. Split them into smaller notes to keep them in sync."
    }
    static let noLargeNotes = "Every note is well under the sync limit."

    // Devices
    static let thisDeviceGroup = "This device"
    static let otherDevices = "Other devices"
    static let thisDeviceLabel = "This device"
    static func lastSeen(_ ago: String) -> String { "Last seen \(ago)" }
    static let neverSeen = "Not seen yet"
    static let devicesFooter = "Long press to rename. Swipe left to revoke."
    static let linkNewDevice = "Link new device"
    static let linkFooter = "The new device shows a code; this phone approves it."
    static func showMore(_ count: Int) -> String { "Show \(count) more" }
    static let renameDevice = "Rename device"
    static let rename = "Rename"
    static func renamedTo(_ name: String) -> String { "Renamed to \(name)" }
    static let revoke = "Revoke"
    static func revokeTitle(_ name: String) -> String { "Revoke “\(name)”?" }
    static let revokeMessage = "It is signed out and stops syncing. Notes already on it stay there until it is linked again."
    static let revokeDevice = "Revoke device"
    static let linkInstruction = "On the new device, choose Link this device and scan this code."
    static let orEnterCode = "Or paste the code"
    static let copyCode = "Copy code"
    static func expiresIn(_ time: String) -> String { "Expires in \(time)" }
    static let linkWaiting = "When it scans, this phone asks you to approve."
    static let linkExpired = "This code expired. Close and start again."
    static let approveTitle = "Approve this device?"
    static func approveMessage(_ code: String) -> String {
        "Check that the new device shows \(code). Approving gives it the key to your notes."
    }
    static let approve = "Approve"
    static let linked = "Linked just now"

    // Vaults
    static let onThisPhone = "On this iPhone"
    static let inAccount = "In your account"
    static let openVault = "Open"
    static let currentVault = "Open now"
    static let download = "Download"
    static let unnamedVault = "Unnamed vault"
    static func vaultsFooter(_ max: Int64?) -> String {
        if let max { return "Swipe left to delete a vault from your account. Your plan includes \(max) vaults." }
        return "Swipe left to delete a vault from your account."
    }
    static func deleteVaultTitle(_ name: String) -> String { "Delete “\(name)” from your account?" }
    static let deleteVaultMessage = "Its items are removed from the server and from every device that has not opened it. This cannot be undone."
    static let deleteFromAccount = "Delete from account"

    // General
    static let language = "Language"
    static let languageFooter = "Takes effect the next time memrynote opens. Shared with your other devices."
    static let dateAndTime = "Date and time"
    static let timeFormat = "Time Format"
    static let dateFormat = "Date Format"
    static let system = "System"
    static let hour12 = "12-hour"
    static let hour24 = "24-hour"
    static let weekStarts = "Week starts on"
    static let sunday = "Sunday"
    static let monday = "Monday"
    static let editing = "Editing"
    static let newNotesGoTo = "New notes go to"
    static let vaultRoot = "Vault root"
    static let folders = "Folders"
    static let newNotesFooter = "This iPhone. New notes from the + button land here."
    static let checkSpelling = "Check spelling"
    static let privacy = "Privacy"
    static let usageMetrics = "Share Anonymous Usage Metrics"
    static let privacyFooter = "This iPhone. Metrics never include note content, titles or tags."

    // Appearance
    static let colorMode = "Color Mode"
    static let warm = "Warm"
    static let white = "White"
    static let dark = "Dark"
    static let accentColor = "Accent Color"
    static let customColor = "Custom Color"
    static let typography = "Typography"
    static let font = "Font"
    static let builtIn = "Built-in"
    static let appearanceFooter = "Text size follows iOS Dynamic Type. Shared with your other devices."
    static let fontFooter = "Used in notes and journal entries. Menus and lists keep the system font."

    // Features
    static let home = "Home"
    static let featuresFooter = "Off hides the module on this iPhone. Nothing is deleted and sync keeps running. Notes and More are always on."
    static let keepOne = "Keep at least one on."

    // About
    static func version(_ version: String, _ build: String) -> String { "Version \(version) (\(build))" }
    static let loveMemry = "Love memrynote?"
    static let starGitHub = "Star us on GitHub"
    static let feedback = "Share feedback"
    static let privacyPolicy = "Privacy policy"
    static let terms = "Terms"
    static let licenses = "Open-source licenses"
    static let licensesBody = "memrynote on iOS is built on SwiftUI, UniFFI, libsodium, SQLite and Yrs. Each keeps its own license."

    // Toasts and errors
    static let saved = "Saved"
}
