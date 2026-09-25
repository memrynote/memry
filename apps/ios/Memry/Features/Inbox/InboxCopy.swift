import Foundation

// IB031. The strings the inbox screens share, mirroring desktop's English
// `packages/i18n/src/locales/en/inbox.json` (keys named beside each group).
// Literals, not a catalogue (spec 004 §5, spec-defect 98): a test asserts
// which sentence a state produced. Screen-specific strings live in
// `InboxCopy+<Screen>.swift` extensions.

enum InboxCopy {
    // MARK: Views (`view.tabs.*`, 00 audit: title menu)

    static let title = "Inbox"
    static let snoozedView = "Snoozed & reminders"
    static let archivedView = "Archived"
    static let insightsView = "Insights"
    static let titleMenuHint = "Shows the inbox views"
    static let loading = "Loading inbox..."
    static let loadFailed = "Failed to load inbox"
    static let tryAgain = "Try again"
    static let itemCaptured = "Item captured"
    static let untitled = "Untitled"

    // MARK: Types (`type.*`)

    static func typeName(_ type: String) -> String {
        switch type {
        case "link": "Link"
        case "note": "Note"
        case "image": "Image"
        case "voice": "Voice"
        case "video": "Video"
        case "clip": "Clip"
        case "pdf": "PDF"
        case "social": "Social"
        case "reminder": "Reminder"
        default: type.capitalized
        }
    }

    /// The filter menu's plural labels (Paper 03).
    static func typePlural(_ type: String) -> String {
        switch type {
        case "link": "Links"
        case "note": "Notes"
        case "image": "Images"
        case "voice": "Voice"
        case "video": "Video"
        case "clip": "Clips"
        case "pdf": "PDFs"
        case "social": "Social"
        case "reminder": "Reminders"
        default: type.capitalized
        }
    }

    /// Detail headers name a voice capture "Voice memo" (`content.voiceMemo`).
    static func kindName(_ type: String) -> String {
        type == "voice" ? "Voice memo" : typeName(type)
    }

    // MARK: List (`list.*`, `view.*`)

    static let sectionToday = "Today"
    static let sectionYesterday = "Yesterday"
    static let sectionOlder = "Older"
    static let transcribing = "Transcribing..."
    static let transcriptionFailed = "Transcription failed"
    static let retry = "Retry"
    static let photo = "Photo"
    static let onAnotherDevice = "File on another device"

    static func moreRowAccessibility(_ count: Int) -> String {
        count == 0 ? title : (count == 1 ? "\(title), 1 item to process" : "\(title), \(count) items to process")
    }

    static func pageCount(_ count: Int) -> String { count == 1 ? "1 page" : "\(count) pages" }

    static func toProcess(_ count: Int) -> String {
        count == 0 ? "Nothing to process" : "\(count) to process"
    }

    static func filedToday(_ count: Int) -> String { "\(count) filed today" }
    static func fetching(_ count: Int) -> String { "\(count) fetching" }
    static let subtitleSeparator = " · "

    static func itemAccessibility(type: String, title: String) -> String {
        "\(typeName(type)): \(title)"
    }

    static func sectionAccessibility(_ label: String, count: Int) -> String {
        count == 1 ? "\(label), 1 item" : "\(label), \(count) items"
    }

    static func snoozedSubtitle(_ count: Int) -> String {
        count == 1 ? "1 coming back · reminders and snoozed captures"
            : "\(count) coming back · reminders and snoozed captures"
    }
    static func archivedSubtitle(_ count: Int) -> String { count == 1 ? "1 item" : "\(count) items" }
    static let insightsSubtitle = "How your capture habit is going"
    static func selectedCount(_ count: Int) -> String { "\(count) selected" }
    static let selectHint = "File, tag, snooze or archive them together"
    static let selectAll = "Select all"
    static let deselectAll = "Deselect all"
    static let more = "More"
    static let inboxSettings = "Inbox settings"
    static let capture = "Capture"
    static let captureHint = "Opens the capture composer"

    // MARK: Inbox Zero (`empty.*`, Paper 21)

    static let zeroTitle = "Inbox Zero"
    static let zeroBody = "Everything’s processed. Tap + to capture something new, or share a link to Memry from any app."
    static func filedThisWeek(_ count: Int) -> String { "\(count) filed this week" }
    static func dayStreak(_ count: Int) -> String { "\(count) day streak" }
    static let noMatches = "No items match this filter"

    // MARK: Filter (`view.filter.*`, Paper 03)

    static let filter = "Filter"
    static let showTypes = "Show types"
    static let clearFilter = "Clear filter"

    static func filtering(_ count: Int) -> String {
        count == 1 ? "Filtering by 1 type" : "Filtering by \(count) types"
    }

    // MARK: Row actions (`quickActions.*`, `list.*`, 00 audit rows 11, 12)

    static let file = "File"
    static let fileEllipsis = "File…"
    static func fileTo(_ folder: String) -> String { "File to \(folder)" }
    static let convert = "Convert"
    static let convertTo = "Convert to"
    static let snooze = "Snooze"
    static let archive = "Archive"
    static let rename = "Rename"
    static let renameLabel = "Rename item"
    static let openLink = "Open link"
    static let select = "Select"
    static let recentFolders = "Recent"
    static let quickFileRecent = "Quick file · recent"
    static let notesRoot = "Notes"

    static let snoozeUntil = "Snooze until"
    static let pickDateTime = "Pick date & time…"
    static let close = "Close"
    static let done = "Done"
    static let cancel = "Cancel"

    // MARK: Toasts (`toast.*`)

    static let undo = "Undo"
    static let undoHint = "Brings the item back"
    static func archived(_ title: String) -> String { "Archived “\(title)”" }
    static func archivedItems(_ count: Int) -> String {
        count == 1 ? "Archived 1 item" : "Archived \(count) items"
    }
    static func filedTo(_ folder: String) -> String { "Filed to \(folder)" }
    static func filedItemsTo(_ count: Int, _ folder: String) -> String { "Filed \(count) items to \(folder)" }
    static func filedPartial(_ processed: Int, of total: Int) -> String { "Filed \(processed) of \(total) items" }
    static func snoozedUntil(_ time: String) -> String { "Snoozed until \(time)" }
    static func snoozedItemsUntil(_ count: Int, _ time: String) -> String {
        count == 1 ? "Snoozed 1 item until \(time)" : "Snoozed \(count) items until \(time)"
    }
    static func appliedTags(_ tags: Int, items: Int) -> String {
        let tagWord = tags == 1 ? "Applied 1 tag" : "Applied \(tags) tags"
        let itemWord = items == 1 ? "1 item" : "\(items) items"
        return "\(tagWord) to \(itemWord)"
    }
    static func restored(_ title: String) -> String { "“\(title)” restored" }
    static let linkedToNote = "Linked to note"
    static func linkedToNotes(_ count: Int) -> String { count == 1 ? linkedToNote : "Linked to \(count) notes" }
    static let embedFellBackToLink = "The image could not be filed in the sidebar on this phone — embedded in the note instead"
    static func convertedTo(_ target: String) -> String { "Converted to \(target)" }
    static let changesUndone = "Changes undone"

    // MARK: Capture (`phaseF.componentsCaptureInput.*`, Paper 04-06)

    static let composerPlaceholder = "Paste a link, jot a thought…"
    static let pasteLink = "Paste link"
    static func pasteDomain(_ domain: String) -> String { "Paste \(domain)" }
    static let attachFile = "Attach file"
    static let photoLibrary = "Photo Library"
    static let takePhoto = "Take Photo"
    static let chooseFile = "Choose File"
    static let recordVoiceMemo = "Record voice memo"
    static let send = "Capture"
    static let recording = "Recording"
    static func recordingElapsed(_ time: String) -> String { "Recording, \(time)" }
    static let transcribedHere = "Transcribed on this iPhone after you stop"
    static let cancelRecording = "Cancel recording"
    static let stopRecording = "Stop recording"
    static func alreadyCaptured(_ title: String, _ age: String) -> String { "Already captured: “\(title)” · \(age) ago" }
    static let openIt = "Open it"
    static let captureAnyway = "Capture anyway"
    static let closeComposer = "Close"
    static let microphoneTitle = "Voice memo"

    // MARK: Convert (`convert.*`)

    static let convertNote = "Note"
    static let convertTask = "Task"
    static let convertEvent = "Event"
    static let convertReminder = "Reminder"

    // MARK: Errors (`toast.failed*`, `loading.*`)

    static let failedArchive = "Failed to archive item"
    static let failedFile = "Failed to file item"
    static let failedSnooze = "Failed to snooze item"
    static let unsupportedType = "This file type can't be captured"
    static let fileTooLarge = "File too large (max 50MB)"
    static let fileElsewhere = "This file is on the device that captured it. File it there, or archive it here."
    static let offlineUpload = "Filing a file needs a connection. It stays in the inbox until then."

    static func unsupportedImageType(_ type: String) -> String { "Unsupported image type: \(type)" }
}
