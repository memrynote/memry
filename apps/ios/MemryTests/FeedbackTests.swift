import Foundation
import os
import Testing

@testable import Memry

// In-app feedback: what the submission carries (`FeedbackSubmitSchema`) and
// the on-disk diagnostic log it attaches when the user opts in.

private let facts = DeviceFacts(
    appVersion: "1.4.0", appBuild: "1042", platform: "iOS", osVersion: "26.1.0", deviceModel: "iPhone17,3"
)

private final class Outbox: @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [Data] = []
    var sent: [Data] { lock.withLock { bodies } }
    func append(_ body: Data) { lock.withLock { bodies.append(body) } }
}

private struct Refused: Error {}

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("feedback-tests-\(UUID().uuidString)")
}

@MainActor
@Suite("Feedback")
struct FeedbackTests {
    private func model(
        signedIn: Bool = false,
        logs: String = "line one\nline two\n",
        outbox: Outbox = Outbox(),
        fails: Bool = false
    ) -> FeedbackModel {
        FeedbackModel(signedIn: signedIn, facts: facts, readLogs: { logs }) { body in
            if fails { throw Refused() }
            outbox.append(body)
        }
    }

    private func json(_ body: Data) throws -> [String: String] {
        try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
    }

    @Test func logs_stay_on_the_phone_until_the_user_turns_them_on() async throws {
        let outbox = Outbox()
        let feedback = model(outbox: outbox)
        feedback.message = "  First sync never finishes  "

        await feedback.submit()

        let body = try json(try #require(outbox.sent.first))
        #expect(body == [
            "message": "First sync never finishes",
            "appVersion": "1.4.0",
            "appBuild": "1042",
            "platform": "iOS",
            "osVersion": "26.1.0",
            "deviceModel": "iPhone17,3",
        ])
        #expect(feedback.status == .sent)
        #expect(feedback.message.isEmpty)
        feedback.edited()
        #expect(feedback.status == .sent, "clearing the form keeps the confirmation")
        feedback.message = "one more thing"
        feedback.edited()
        #expect(feedback.status == .editing)
    }

    @Test func turning_logs_on_attaches_exactly_the_preview() async throws {
        let outbox = Outbox()
        let feedback = model(outbox: outbox)
        feedback.message = "hi"
        feedback.includeLogs = true

        await feedback.submit()

        let body = try json(try #require(outbox.sent.first))
        #expect(body["logs"] == feedback.logsToSend())
        #expect(body["logs"] == "line one\nline two\n")
        #expect(feedback.includeLogs == false, "the next report asks again")
    }

    @Test func a_log_past_the_cap_sends_its_newest_whole_lines() {
        let line = String(repeating: "x", count: 99) + "\n"
        let all = "first line\n" + String(repeating: line, count: FeedbackModel.logsLimit / 100 + 10)
        let feedback = model(logs: all)

        let sent = feedback.logsToSend()

        #expect(sent.utf8.count <= FeedbackModel.logsLimit)
        #expect(sent.hasPrefix("x"))
        #expect(sent.hasSuffix(line))
        #expect(!sent.contains("first line"))
    }

    @Test func the_typed_email_goes_only_when_signed_out() {
        let signedOut = model()
        signedOut.message = "hi"
        signedOut.replyEmail = " me@example.com "
        let signedIn = model(signedIn: true)
        signedIn.message = "hi"
        signedIn.replyEmail = "me@example.com"

        #expect(signedOut.payload().email == "me@example.com")
        #expect(signedIn.payload().email == nil, "the server names the account from the token")
    }

    @Test func send_waits_for_a_message_and_a_valid_email() {
        let feedback = model()
        #expect(!feedback.canSend)
        feedback.message = "   \n "
        #expect(!feedback.canSend)
        feedback.message = "hi"
        feedback.replyEmail = "not-an-email"
        #expect(!feedback.canSend)
        feedback.replyEmail = "me@example.com"
        #expect(feedback.canSend)
    }

    @Test func a_refused_send_keeps_the_message_and_shows_why() async {
        let feedback = model(fails: true)
        feedback.message = "hi"

        await feedback.submit()

        guard case .failed = feedback.status else {
            Issue.record("expected a failure, got \(feedback.status)")
            return
        }
        #expect(feedback.message == "hi")
    }
}

@Suite("Diagnostic log")
struct DiagnosticLogTests {
    @Test func lines_carry_a_utc_stamp_level_and_subsystem() throws {
        let log = DiagnosticLog(directory: temporaryDirectory())
        let date = try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse("2026-11-19T03:47:12.500Z")

        log.markLaunch(facts, at: date)
        log.append(.default, .sync, Log.line("a first sync started", nil), at: date)
        log.append(.error, .sync, Log.line("a first sync did not finish", .code("api.rateLimited")), at: date)

        #expect(log.contents() == """
            2026-11-19T03:47:12.500Z --- launch 1.4.0 (1042) iOS 26.1.0 iPhone17,3 ---
            2026-11-19T03:47:12.500Z notice sync a first sync started
            2026-11-19T03:47:12.500Z error sync a first sync did not finish [code=api.rateLimited]

            """)
    }

    @Test func an_earlier_launch_is_still_there_after_a_relaunch() {
        let directory = temporaryDirectory()
        let first = DiagnosticLog(directory: directory)
        first.append(.default, .sync, "from the first launch")
        first.flush()

        let second = DiagnosticLog(directory: directory)
        second.append(.default, .sync, "from the second launch")

        let contents = second.contents()
        #expect(contents.contains("from the first launch"))
        #expect(contents.contains("from the second launch"))
    }

    @Test func the_log_stays_bounded_and_keeps_the_newest_lines() {
        let limit = 1024
        let log = DiagnosticLog(directory: temporaryDirectory(), limit: limit)
        for index in 0..<200 {
            log.append(.info, .app, "line \(index) " + String(repeating: "y", count: 40))
        }

        let contents = log.contents()
        #expect(contents.utf8.count <= 2 * (limit + 100))
        #expect(contents.contains("line 199 "))
        #expect(!contents.contains("line 0 "))
    }
}
