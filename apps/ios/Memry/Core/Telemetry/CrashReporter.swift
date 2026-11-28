import Foundation
import MetricKit

/// MetricKit hands the previous session's crash and hang diagnostics to the
/// next launch. Each crash becomes `app_crashed` and each hang
/// `app_error_seen` (`APP_HANG`), with enough to tell the kinds of kill apart
/// and to find the code again:
///
/// - `errorCode` (the Error Tracking fingerprint) is the Mach exception and
///   signal, then the termination namespace and code when MetricKit gives one:
///   `EXC_CRASH:SIGKILL:FRONTBOARD:0x8badf00d` (a watchdog kill of a hung main
///   thread) groups apart from `EXC_CRASH:SIGKILL:RUNNINGBOARD:0x8badf00d`
///   (a background task held past its time).
/// - `error.message` is a line of tokens: the named code, the watchdog's kind,
///   the build, the top frame in the app's own binary.
/// - `error.stack` is the attributed thread's frames as `binary+offset`, which
///   the build's dSYM symbolicates (`atos -l`), in the `at fn (file)` shape the
///   server turns into Error Tracking frames.
///
/// Nothing MetricKit writes as text leaves the device. The termination reason
/// names the bundle and a pid, and an Objective-C exception's message can
/// carry user content: only the tokens parsed out of them below are sent.
final class CrashReporter: NSObject, MXMetricManagerSubscriber {
    /// What one crash diagnostic says, as plain values.
    struct Crash {
        var exception: Int?
        var code: Int64?
        var signal: Int?
        var terminationReason: String?
        var objcException: String?
        var build: String?
        var callStack: Data?
    }

    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let app = Bundle.main.executableURL?.lastPathComponent ?? "Memry"
        var events: [TelemetryEvent] = []
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                let facts = Crash(
                    exception: crash.exceptionType?.intValue,
                    code: crash.exceptionCode?.int64Value,
                    signal: crash.signal?.intValue,
                    terminationReason: crash.terminationReason,
                    objcException: crash.exceptionReason?.exceptionName,
                    build: crash.metaData.applicationBuildVersion,
                    callStack: crash.callStackTree.jsonRepresentation()
                )
                events.append(Self.crashEvent(facts, app: app))
            }
            for hang in payload.hangDiagnostics ?? [] {
                events.append(Self.hangEvent(
                    durationMs: hang.hangDuration.converted(to: .milliseconds).value,
                    build: hang.metaData.applicationBuildVersion,
                    callStack: hang.callStackTree.jsonRepresentation(),
                    app: app
                ))
            }
        }
        guard !events.isEmpty else { return }
        Task {
            for event in events { await Telemetry.shared.record(event) }
        }
    }

    static func crashEvent(_ crash: Crash, app: String) -> TelemetryEvent {
        var event = TelemetryEvent.make(.appCrashed, surface: .app, action: "unclean_shutdown", result: .failed)
        event.source = "metrickit"
        let code = code(exception: crash.exception, signal: crash.signal)
        let termination = crash.terminationReason.flatMap(Termination.init)
        event.errorCode = [code, termination?.code].compactMap(\.self).joined(separator: ":")
        let frames = frames(crash.callStack)
        var tokens = [code]
        if let termination {
            tokens.append("termination=\(termination.code)")
            if let reason = termination.reason { tokens.append("reason=\(reason)") }
            if let kind = termination.kind { tokens.append("kind=\(kind)") }
        } else if crash.terminationReason != nil {
            tokens.append("termination=unparsed")
        }
        if let value = crash.code { tokens.append("code=0x\(String(UInt64(bitPattern: value), radix: 16))") }
        if let name = crash.objcException.map({ token($0, limit: 32) }), !name.isEmpty { tokens.append("objc=\(name)") }
        event.error = detail(tokens, build: crash.build, frames: frames, app: app)
        return event
    }

    static func hangEvent(durationMs: Double, build: String?, callStack: Data?, app: String) -> TelemetryEvent {
        var event = TelemetryEvent.make(.appErrorSeen, surface: .app, action: "hang", result: .failed)
        event.source = "metrickit"
        event.errorCode = "APP_HANG"
        event.metrics = TelemetryMetrics(durationMs: durationMs)
        event.error = detail(["APP_HANG"], build: build, frames: frames(callStack), app: app)
        return event
    }

    private static func detail(
        _ tokens: [String], build: String?, frames: [Frame], app: String
    ) -> TelemetryErrorDetail {
        var tokens = tokens
        if let build = build.map({ token($0, limit: 16) }), !build.isEmpty { tokens.append("build=\(build)") }
        if let top = frames.first(where: { $0.binary == token(app, limit: 32) }) { tokens.append("top=\(top.name)") }
        let stack = frames.map { "    at \($0.name) (\($0.binary))" }.joined(separator: "\n")
        return TelemetryErrorDetail(message: tokens.joined(separator: " "), stack: stack.isEmpty ? nil : stack)
    }

    static func code(exception: Int?, signal: Int?) -> String {
        let exceptionName = switch exception {
        case 1: "EXC_BAD_ACCESS"
        case 2: "EXC_BAD_INSTRUCTION"
        case 3: "EXC_ARITHMETIC"
        case 5: "EXC_SOFTWARE"
        case 6: "EXC_BREAKPOINT"
        case 10: "EXC_CRASH"
        case 11: "EXC_RESOURCE"
        case 12: "EXC_GUARD"
        case let .some(other): "EXC_\(other)"
        case nil: "EXC_UNKNOWN"
        }
        let signalName = switch signal {
        case 4: "SIGILL"
        case 5: "SIGTRAP"
        case 6: "SIGABRT"
        case 8: "SIGFPE"
        case 9: "SIGKILL"
        case 10: "SIGBUS"
        case 11: "SIGSEGV"
        case let .some(other): "SIG\(other)"
        case nil: "SIGNONE"
        }
        return "\(exceptionName):\(signalName)"
    }

    /// The parts of a termination reason that are safe to send:
    /// `Namespace FRONTBOARD, Code 0x8badf00d scene-update watchdog
    /// transgression: app<…(pid)>…` reads as `FRONTBOARD:0x8badf00d`, reason
    /// `watchdog`, kind `scene_update`.
    struct Termination: Equatable {
        let code: String
        let reason: String?
        let kind: String?

        init?(_ text: String) {
            let namespace = text.firstMatch(of: /Namespace\s+([A-Za-z_]{1,20})/).map { String($0.1).uppercased() }
            guard let raw = text.firstMatch(of: /Code\s+(0x[0-9A-Fa-f]{1,16}|[0-9]{1,20})/).map({ String($0.1) }),
                  let value = raw.hasPrefix("0x") ? UInt64(raw.dropFirst(2), radix: 16) : UInt64(raw)
            else { return nil }
            let hex = "0x" + String(value, radix: 16)
            code = "\(namespace ?? "UNKNOWN"):\(hex)"
            reason = Self.reasons[hex]
            let lower = text.lowercased()
            kind = Self.kinds.first { lower.contains($0.marker) }?.kind
        }

        /// Apple's named termination codes.
        private static let reasons = [
            "0x8badf00d": "watchdog",
            "0xdead10cc": "file_lock_suspended",
            "0xc00010ff": "thermal",
            "0xbaaaaaad": "stackshot",
            "0xdeadfa11": "force_quit",
            "0x2bad45ec": "security"
        ]

        /// Which watchdog fired, from words in the reason. First match wins.
        private static let kinds: [(marker: String, kind: String)] = [
            ("scene-update", "scene_update"),
            ("scene-create", "scene_create"),
            ("background task", "background_task"),
            ("backgroundtask", "background_task"),
            ("background-task", "background_task"),
            ("wall clock", "wall_clock")
        ]
    }

    /// One stack frame: its binary and the offset into the binary's text.
    struct Frame: Equatable {
        let binary: String
        let offset: UInt64

        var name: String { "\(binary)+0x\(String(offset, radix: 16))" }
    }

    static let frameLimit = 24

    /// The frames of `MXCallStackTree.jsonRepresentation()`, innermost first:
    /// the attributed thread's (the crashed or hung one), else the first.
    static func frames(_ json: Data?) -> [Frame] {
        guard let json,
              let tree = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let stacks = tree["callStacks"] as? [[String: Any]],
              let stack = stacks.first(where: { $0["threadAttributed"] as? Bool == true }) ?? stacks.first,
              var frame = (stack["callStackRootFrames"] as? [[String: Any]])?.first
        else { return [] }
        var frames: [Frame] = []
        while frames.count < frameLimit {
            let binary = token(frame["binaryName"] as? String ?? "", limit: 32)
            let offset = (frame["offsetIntoBinaryTextSegment"] as? NSNumber)?.uint64Value ?? 0
            frames.append(Frame(binary: binary.isEmpty ? "unknown" : binary, offset: offset))
            guard let next = (frame["subFrames"] as? [[String: Any]])?.first else { break }
            frame = next
        }
        return frames
    }

    /// The leading run of ASCII letters, digits, `.`, `_` and `-`: a name
    /// such as `NSInvalidArgumentException`, `UIKitCore` or `1017`, cut at the
    /// first space, slash or colon, so no path, message or address follows
    /// it. Short enough that the server's long-secret redaction (a run of 40
    /// such characters) never eats a frame.
    private static func token(_ value: String, limit: Int) -> String {
        let kept = value.unicodeScalars.prefix {
            $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "._-".unicodeScalars.contains($0))
        }
        return String(String.UnicodeScalarView(kept.prefix(limit)))
    }
}
