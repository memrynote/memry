import Foundation
import os

// T142, second half. The shell's only logging path (Constitution II, FR-023).
//
// **The rule is that no key material, no token and no note text is ever passed
// to a logger.** A comment saying so is worth nothing: OSLog's default privacy
// for an interpolated `String` is `.private`, but one caller writing
// `logger.info("\(value, privacy: .public)")` defeats it, and a caller logging
// an error whose `errorDescription` embeds a bearer token defeats it invisibly.
// The generated core enums make that second case concrete — every one of them
// is a `LocalizedError` whose `errorDescription` is `String(reflecting: self)`,
// so `error.localizedDescription` is the raw case *with its associated values*.
//
// So the rule is held by the type system instead:
//
//   * every message is a `StaticString`, which cannot be built from runtime
//     data — `log.info("vault unlocked")` compiles, `log.info("vault \(id)")`
//     does not, because a string interpolation is not a `StaticString`;
//   * the only other thing a caller may pass is a ``LogDetail``, a closed set
//     of four shapes that are provably not secrets: an ``ErrorCode`` (itself a
//     string *literal* only), a count, a duration, a status;
//   * **no entry point on this type accepts a `String`.** There is nowhere to
//     put a phrase, a token, or a note body.
//
// Because every component of a line is a compile-time literal or a number,
// interpolating the finished line with `privacy: .public` is sound by
// construction rather than by review. That is deliberate: a `.private` line
// that reads `<private>` in Console is useless for diagnosing a device, and the
// safety here comes from what can reach the line, not from redacting it after.

/// A stable, payload-free identifier for one error variant.
///
/// Constructible **only** from a string literal, which is what makes it
/// loggable: `ErrorCode("\(token)")` does not compile, because this type is
/// `ExpressibleByStringLiteral` over `StaticString` and deliberately not
/// `ExpressibleByStringInterpolation`. `ErrorMapping` mints one per variant, so
/// an error can reach a log as its identity without its associated values.
struct ErrorCode: Sendable, Hashable, CustomStringConvertible, ExpressibleByStringLiteral {
    typealias UnicodeScalarLiteralType = StaticString
    typealias ExtendedGraphemeClusterLiteralType = StaticString
    typealias StringLiteralType = StaticString

    let description: String

    init(stringLiteral value: StaticString) {
        description = value.description
    }
}

/// The only values that may ride alongside a message.
///
/// Four cases, all closed: an identifier that can only be a literal, and three
/// numbers. Adding a `case note(String)` here would be the one change that
/// breaks the guarantee above, which is why the set is written down rather than
/// left to a `CustomStringConvertible` parameter.
enum LogDetail: Sendable, Hashable {
    /// The variant identity from `ErrorMapping`. Never the error object.
    case code(ErrorCode)
    case count(Int)
    case milliseconds(UInt64)
    /// An HTTP status or an `OSStatus`. A number, never a server message.
    case status(Int)

    var rendered: String {
        switch self {
        case let .code(code): "code=\(code.description)"
        case let .count(value): "count=\(value)"
        case let .milliseconds(value): "ms=\(value)"
        case let .status(value): "status=\(value)"
        }
    }
}

/// Which part of the shell a line came from. One OSLog category each, so
/// Console and `log stream` can filter without a substring match on the text.
enum LogSubsystem: String, Sendable, CaseIterable {
    case app
    case core
    case auth
    case secureStore
    case storage
    case sync
    case transport
    case capture
    case interface
}

/// One logger per subsystem. `Log.core.error("…")` is the whole API.
struct Log: Sendable {
    /// Fixed rather than read from `Bundle.main`, so a line logged from the
    /// test bundle lands in the same subsystem as one logged from the app.
    static let subsystem = "com.memry.ios"

    static let app = Log(.app)
    static let core = Log(.core)
    static let auth = Log(.auth)
    static let secureStore = Log(.secureStore)
    static let storage = Log(.storage)
    static let sync = Log(.sync)
    static let transport = Log(.transport)
    static let capture = Log(.capture)
    static let interface = Log(.interface)

    private let sink: @Sendable (OSLogType, String) -> Void

    init(_ category: LogSubsystem) {
        let logger = Logger(subsystem: Log.subsystem, category: category.rawValue)
        sink = { level, line in
            logger.log(level: level, "\(line, privacy: .public)")
        }
    }

    /// Redirects lines to `sink` instead of OSLog. For tests, which cannot read
    /// the system log back reliably on a simulator. Redirecting cannot widen
    /// what a caller may log: the inputs are still `StaticString` + `LogDetail`.
    init(capturing sink: @escaping @Sendable (OSLogType, String) -> Void) {
        self.sink = sink
    }

    func debug(_ message: StaticString, _ detail: LogDetail? = nil) {
        sink(.debug, Log.line(message, detail))
    }

    func info(_ message: StaticString, _ detail: LogDetail? = nil) {
        sink(.info, Log.line(message, detail))
    }

    /// `OSLogType.default`, which Console calls "Notice": the level that
    /// persists to disk without being an error.
    func notice(_ message: StaticString, _ detail: LogDetail? = nil) {
        sink(.default, Log.line(message, detail))
    }

    func error(_ message: StaticString, _ detail: LogDetail? = nil) {
        sink(.error, Log.line(message, detail))
    }

    func fault(_ message: StaticString, _ detail: LogDetail? = nil) {
        sink(.fault, Log.line(message, detail))
    }

    /// The one place text is assembled. Both halves are compile-time literals
    /// or numbers, so the result cannot contain a secret.
    static func line(_ message: StaticString, _ detail: LogDetail?) -> String {
        guard let detail else { return message.description }
        return "\(message.description) [\(detail.rendered)]"
    }
}
