import Foundation
import MemryCore
import Observation

// In-app feedback, desktop's "Send feedback" dialog on iOS. The submission is
// `FeedbackSubmitSchema` (`packages/contracts/src/feedback-api.ts`) and goes to
// the same `POST /feedback` route through the core, which adds the session's
// bearer so the server can name the account and plan from the token. The
// diagnostic log rides along only when the user turns it on.

/// The JSON body. Optional fields that are `nil` are left out, as desktop does.
struct FeedbackPayload: Encodable, Equatable {
    let message: String
    let email: String?
    let appVersion: String
    let appBuild: String
    let platform: String
    let osVersion: String
    let deviceModel: String
    let logs: String?
}

@MainActor
@Observable
final class FeedbackModel {
    enum Status: Equatable {
        case editing
        case sending
        case sent
        case failed(UserFacingError)
    }

    /// `FEEDBACK_LOGS_MAX_CHARS`. The log is ASCII, so bytes and characters agree.
    static let logsLimit = 512 * 1024
    /// `FeedbackSubmitSchema.message`.
    static let messageLimit = 5000

    var message = ""
    var replyEmail = ""
    /// Off until the user turns it on: the log leaves the phone only by choice.
    var includeLogs = false
    private(set) var status: Status = .editing

    let signedIn: Bool
    private let facts: DeviceFacts
    private let readLogs: @Sendable () -> String
    private let send: @Sendable (Data) async throws -> Void

    init(
        signedIn: Bool,
        facts: DeviceFacts = .current(),
        readLogs: @escaping @Sendable () -> String = { DiagnosticLog.shared.contents() },
        send: @escaping @Sendable (Data) async throws -> Void
    ) {
        self.signedIn = signedIn
        self.facts = facts
        self.readLogs = readLogs
        self.send = send
    }

    var trimmedMessage: String { message.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedEmail: String { replyEmail.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The server's own email check (`services/email.ts`), so a typo is caught
    /// here rather than as a refused submission.
    var emailIsValid: Bool {
        trimmedEmail.isEmpty || trimmedEmail.wholeMatch(of: /[^\s@]+@[^\s@]+\.[^\s@]+/) != nil
    }

    var canSend: Bool {
        !trimmedMessage.isEmpty && trimmedMessage.count <= Self.messageLimit && emailIsValid && status != .sending
    }

    /// Exactly the text that is attached: the newest `logsLimit` bytes.
    func logsToSend() -> String {
        let all = readLogs()
        guard all.utf8.count > Self.logsLimit else { return all }
        let tail = all.utf8.suffix(Self.logsLimit)
        // Start on a whole line so the first one is not cut in half.
        let text = String(decoding: tail, as: UTF8.self)
        guard let newline = text.firstIndex(of: "\n") else { return text }
        return String(text[text.index(after: newline)...])
    }

    func payload() -> FeedbackPayload {
        let logs = includeLogs ? logsToSend() : ""
        return FeedbackPayload(
            message: trimmedMessage,
            // Signed in, the server takes the reply address from the account.
            email: signedIn || trimmedEmail.isEmpty ? nil : trimmedEmail,
            appVersion: facts.appVersion,
            appBuild: facts.appBuild,
            platform: facts.platform,
            osVersion: facts.osVersion,
            deviceModel: facts.deviceModel,
            logs: logs.isEmpty ? nil : logs
        )
    }

    func submit() async {
        guard canSend else { return }
        status = .sending
        do {
            let body = try JSONEncoder().encode(payload())
            try await send(body)
            Log.interface.notice("feedback sent")
            message = ""
            replyEmail = ""
            includeLogs = false
            status = .sent
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.interface.error("feedback could not be sent", .code(mapped.code))
            status = .failed(mapped)
        }
    }

    /// Typing again after a result puts the form back in play. The reset
    /// that follows a send empties the message too, and must not hide the
    /// confirmation, so an empty message changes nothing.
    func edited() {
        guard !message.isEmpty, status != .sending else { return }
        status = .editing
    }
}
