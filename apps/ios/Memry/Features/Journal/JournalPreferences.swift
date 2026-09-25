import Foundation

// D9. `showStatsFooter` is not in the synced settings schema, so the phone
// keeps it device-local, per vault, as desktop keeps its own copy local.
// The Day page reads it (JP051) and Settings › Journal writes it (JP048).

enum JournalPreferences {
    /// The `UserDefaults` key for a vault's stats-footer switch. Off by
    /// default, as on desktop.
    static func statsFooterKey(vaultId: String) -> String {
        "journal.showStatsFooter.\(vaultId)"
    }
}
