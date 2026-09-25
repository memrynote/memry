import Foundation

// Copy for the detail screens (`detail.*`, `content.*`, `reminder.*`,
// `phaseF.componentsInboxDetail*`).

extension InboxCopy {
    static func detailKind(_ kind: String, _ captured: String) -> String { "\(kind) · Captured \(captured)" }
    static let voiceTitlePlaceholder = "Name this voice memo..."
    static let titlePlaceholder = "Name this item..."
    static let notePlaceholder = "Write your note..."
    static let itemGone = "This item is no longer in the inbox"
    static let itemGoneDetail = "It may have been filed, archived or deleted on another device."
    static let restore = "Restore"
    static let deletePermanently = "Delete permanently"
    static let deleteTitle = "Delete this item permanently?"
    static let deleteBody = "It is removed from every device. This cannot be undone."
    static let open = "Open"
    static let savedArticle = "Saved article"
    static let transcription = "Transcription"
    static let copy = "Copy"
    static let copied = "Copied"
    static let copyTranscription = "Copy transcription"
    static let transcribingAudio = "Transcribing audio..."
    static let noTranscription = "No transcription available"
    static let play = "Play"
    static let pause = "Pause"
    static let audioPosition = "Audio position"
    static let dimensions = "Dimensions"
    static let format = "Format"
    static let size = "Size"
    static let source = "Source"
    static let tweetUnavailable = "Tweet unavailable"
    static let tweetUnavailableDetail = "This tweet may have been deleted or is from a private account."
    static let openPost = "Open post"

    /// The social link's label, by the platform the post is on.
    static func viewOn(platform: String?) -> String {
        let names = [
            "twitter": "X", "x": "X", "reddit": "Reddit", "instagram": "Instagram", "threads": "Threads",
            "bluesky": "Bluesky", "mastodon": "Mastodon", "linkedin": "LinkedIn", "facebook": "Facebook",
            "tiktok": "TikTok", "youtube": "YouTube"
        ]
        guard let name = platform.flatMap({ names[$0.lowercased()] }) else { return openPost }
        return "View on \(name)"
    }
    static let reminderTriggered = "Reminder triggered"
    static let reminderNote = "Reminder Note"
    static let viewed = "Viewed"
    static let notYetViewed = "Not yet viewed"
    static func journalTitle(_ date: String) -> String { "Journal — \(date)" }
    static let fileNotHere = "The file is on the device that captured it."
    static let pagesLabel = "Pages"
    static let duration = "Duration"
}

// Copy for Snoozed & reminders, Archived and Insights (`reminder.panel*`,
// `empty.archived*`, `insights.*`).
extension InboxCopy {
    static let upcoming = "Upcoming"
    static let past = "Past"
    static let panelEmpty = "No upcoming reminders."
    static let panelFooter = "Tap a reminder to open its task or the capture. Items return to Inbox when their time comes, with a notification."
    static let snoozedCapture = "Snoozed capture"
    static let unsnooze = "Back to inbox"
    static let archivedNone = "No archived items"
    static let archivedNoMatches = "No matching archived items"
    static let searchArchived = "Search archived"
    static let clearSearch = "Clear search"
    static let archivedFooter = "Tap opens a read-only detail with Restore and Delete permanently. Delete asks for confirmation."
    static let deleteShort = "Delete"
    static let captured = "Captured"
    static func capturedThisWeek(_ count: Int) -> String { "+\(count) this week" }
    static let processed = "Processed"
    static func processRate(_ rate: Int) -> String { "\(rate)% rate" }
    static let stale = "Stale"
    static let needsAttention = "needs attention"
    static let allClear = "all clear"
    static let avgTimeToFile = "Avg time to file"
    static let captureActivity = "Capture activity"
    static let byType = "By type"
    static let recentFilings = "Recent filings"
    static let noCapturesYet = "No captures yet"
    static let noItemsYet = "No items yet"
    static let noItemsFiled = "No items filed yet"
    static let convertedToTask = "Converted to task"
    static func peak(_ day: String, _ start: String, _ end: String) -> String { "Peak: \(day) \(start)–\(end)" }
}
