import Foundation

// JP047, the Day page's More menu. The item titles are desktop's
// (`JournalCopy.findInPage`, `.export`, `.journalSettings`); this adds the
// VoiceOver label of the export row, which on desktop is the visible title.
extension JournalCopy {
    static let exportAccessibilityLabel = "Export this day as text"
}
