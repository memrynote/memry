import Foundation

// Copy for Settings › Inbox and the two notifications (`settings.json`
// `inbox.*`, `system.json` `notification.inboxReview.*`, `inbox.json`
// `reviewNudge.*`, `snoozeDue.*`). Counts only, never capture text.

extension InboxCopy {
    static let dailyReview = "Daily review"
    static let reviewReminder = "Review reminder"
    static let sendTest = "Send test notification"
    static let reviewFooter = "A daily nudge when captures are waiting. Snoozed items also notify when they come back."
    static let testSent = "Test notification sent. If nothing appears, allow notifications for Memry in Settings."
    static let testDenied = "Notifications are off for Memry. Allow them in Settings to get the review reminder."
    static let images = "Images"
    static let embedShort = "Embedded"
    static let askWhenFiling = "Ask when filing"
    static let imagesFooter = "Embedded puts the image inside the linked note. File in the sidebar keeps it as its own file; on this phone it is embedded."

    static func reviewTitle(_ count: Int) -> String {
        count == 1 ? "Time to review 1 item" : "Time to review \(count) items"
    }
    static let reviewBody = "Process today’s captures in one calm pass."
    static let reviewTestTitle = "Time to review your inbox"
    static let reviewTestBody = "This is a test — your daily review reminders will look like this."
    static func snoozeDueTitle(_ count: Int) -> String { count == 1 ? "1 snoozed item" : "\(count) snoozed items" }
    static func snoozeDueBody(_ count: Int) -> String {
        count == 1 ? "Your snoozed item is ready for review" : "Your snoozed items are ready"
    }
}
