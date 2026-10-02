import Foundation

// JP047, the Day page's More menu. The item titles are desktop's
// (`JournalCopy.findInPage`, `.export`, `.journalSettings`); the rest match the
// note page's menu, which is where desktop has them.
extension JournalCopy {
    static let exportAccessibilityLabel = "Export this day as a text file"
    static let share = "Share"
    static let backlinks = "Backlinks"
    static let reminder = "Reminder"
    static let addToFavorites = "Add to favorites"
    static let removeFromFavorites = "Remove from favorites"
    static let deleteDay = "Delete entry"
    static let deleteDayTitle = "Delete this day's entry?"
    static let deleteDayMessage = "It will be removed from every device signed in to this vault."
    static let keep = "Keep"
}
