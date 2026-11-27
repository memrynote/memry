import Foundation

// Every sentence in-app feedback shows. Wording mirrors desktop's feedback
// dialog (`packages/i18n/src/locales/en/common.json`,
// `phaseF.componentsAppSidebar.feedback*`); the log lines are new copy.
enum FeedbackCopy {
    static let title = "Send feedback"
    static let description = "Tell us what's working, what's broken, or what you wish MemryNote did. We read every message."
    static let placeholder = "Your feedback…"
    static let email = "Email (optional)"
    static let emailHint = "Add your email if you'd like a reply."
    static let emailInvalid = "Check the email address."
    static let attachLogs = "Attach diagnostic logs"
    static let logsFooter = "This app's own log from recent launches: what it did, counts and error codes. It never holds note text, titles, keys or your recovery phrase."
    static let previewLogs = "Preview logs"
    static let logsTitle = "Diagnostic logs"
    static let logsEmpty = "Nothing has been logged yet."
    static func logsSize(lines: Int, bytes: Int) -> String {
        let size = ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
        return "\(lines) lines · \(size) · sent exactly as shown"
    }

    static let whatGetsSent = "What gets sent"
    static let sentMessage = "Your message, exactly as you wrote it"
    static func sentEmailSignedIn(_ email: String?) -> String {
        guard let email else { return "Your account email, so we can reply" }
        return "Your account email (\(email)), so we can reply"
    }
    static let sentEmailOptional = "Your email — only if you add it, and only so we can reply"
    static let sentVersion = "App version, iOS version and \(ThisDevice.noun) model"
    static let sentPlan = "Your plan (free, Plus, Pro or Believer)"
    static let sentLogs = "The diagnostic logs, if you attach them"
    static let sentNote = "Nothing else. Your notes stay on your device."

    static let send = "Send"
    static let sending = "Sending…"
    static let sent = "Thanks for the feedback!"
    static let unavailable = "Feedback can't be sent until MemryNote has finished starting."
    static let done = "Done"
    static let generalFooter = "Report a problem or an idea. You choose whether the diagnostic logs go with it."
}
