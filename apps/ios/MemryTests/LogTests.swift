import Foundation
import MemryCore
import Testing
import os

@testable import Memry

// T142, second half. The claim under test is FR-023 and Constitution II: no key
// material, no token and no note text can be passed to the logger.
//
// Most of that claim is held at compile time and cannot be asserted from here —
// `log.info("phrase \(phrase)")` is a compile error because a string
// interpolation is not a `StaticString`, and `ErrorCode` is expressible from a
// literal only, so neither can be written in the first place. What *is*
// testable is the other half: that the pieces which do reach a line are
// incapable of carrying a secret, and that the realistic route by which one
// would leak — an error object whose associated values hold it — does not.

/// Collects what a `Log` would have handed OSLog.
private final class Sink: @unchecked Sendable {
    private let lock = NSLock()
    private var captured: [(OSLogType, String)] = []

    var lines: [(level: OSLogType, text: String)] {
        lock.withLock { captured.map { (level: $0.0, text: $0.1) } }
    }

    func log() -> Log {
        Log(capturing: { level, text in
            self.lock.withLock { self.captured.append((level, text)) }
        })
    }
}

private let secrets = [
    "abandon ability able about above absent absorb abstract absurd abuse access accident",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtZW1yeSJ9.Zm9yLXRlc3RzLW9ubHk",
    "Dentist on Thursday, and tell Mum about the house.",
    "c2VjcmV0LXZhdWx0LWtleS1ieXRlcy1ub3QtcmVhbA=="
]

@Suite("Log")
struct LogTests {
    // MARK: - What a line is made of

    @Test("a message with no detail is the message")
    func lineWithoutDetail() {
        #expect(Log.line("vault unlocked", nil) == "vault unlocked")
    }

    @Test("each detail renders as a labelled scalar and nothing else")
    func lineWithEachDetail() {
        #expect(Log.line("pull finished", .count(94)) == "pull finished [count=94]")
        #expect(Log.line("pull finished", .milliseconds(32_000)) == "pull finished [ms=32000]")
        #expect(Log.line("push refused", .status(400)) == "push refused [status=400]")
        #expect(Log.line("push refused", .code("api.statusRefused")) == "push refused [code=api.statusRefused]")
    }

    @Test("every level reaches the sink as itself")
    func levelsAreDistinct() {
        let sink = Sink()
        let log = sink.log()
        log.debug("a")
        log.info("b")
        log.notice("c")
        log.error("d")
        log.fault("e")
        let levels = sink.lines.map { $0.level.rawValue }
        let expected: [OSLogType] = [.debug, .info, .default, .error, .fault]
        #expect(levels == expected.map { $0.rawValue })
        #expect(sink.lines.map { $0.text } == ["a", "b", "c", "d", "e"])
    }

    @Test("subsystem categories are distinct and named")
    func categoriesAreDistinct() {
        let names = LogSubsystem.allCases.map(\.rawValue)
        #expect(Set(names).count == names.count)
        #expect(names.allSatisfy { !$0.isEmpty })
        #expect(Log.subsystem == "com.memry.ios")
    }

    // MARK: - The claim

    /// The realistic leak: a caller logs "the error", the error's
    /// `errorDescription` is `String(reflecting: self)`, and the associated
    /// values ride along. The only handle `ErrorMapping` gives a caller is a
    /// literal code, so there is nothing to log but the identity.
    @Test("an error carrying a secret cannot put it in the log")
    func secretsInErrorsNeverReachALine() {
        let sink = Sink()
        let log = sink.log()
        for secret in secrets {
            let carriers: [any Error] = [
                CryptoError.InvalidParameter(what: secret),
                RecoveryError.UnknownWord(word: secret),
                AuthError.MalformedToken(what: secret),
                ApiError.Unauthorized(code: secret, message: secret),
                ApiError.Status(status: 400, code: secret, message: secret),
                CrdtError.Undecodable(docId: secret, what: secret),
                StorageError.Failed(what: secret),
                TransportError.SocketClosed(code: 1006, reason: secret)
            ]
            for error in carriers {
                log.error("core call failed", .code(ErrorMapping.userFacing(error).code))
            }
        }
        #expect(sink.lines.count == secrets.count * 8)
        for line in sink.lines {
            for secret in secrets {
                #expect(!line.text.contains(secret), "a secret reached the log: \(line.text)")
            }
            #expect(!line.text.contains("MemryCore"))
        }
    }

    /// Belt and braces on the same claim from the other side: whatever a caller
    /// passes, a finished line is only literals and digits. A future
    /// `LogDetail` case carrying free text would fail this.
    @Test("a finished line holds nothing but literals and numbers")
    func linesAreBareIdentifiers() {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .=[]_-")
        let details: [LogDetail] = [
            .code("secureStore.locked"), .count(-1), .milliseconds(0), .status(503)
        ]
        for detail in details {
            let line = Log.line("seam reported", detail)
            #expect(line.allSatisfy(allowed.contains), "unexpected characters in: \(line)")
            #expect(line.hasPrefix("seam reported ["))
        }
    }

    @Test("an error code is a literal identifier, never a payload")
    func errorCodesAreIdentifiers() {
        let code: ErrorCode = "crypto.outOfMemory"
        #expect(code.description == "crypto.outOfMemory")
        #expect(code == ErrorMapping.userFacing(CryptoError.OutOfMemory(requestedBytes: 1)).code)
        #expect(code != ErrorMapping.userFacing(CryptoError.DecryptionFailed).code)
    }
}
