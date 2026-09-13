import Foundation
import MemryCore

/// What S1 observed. Plain Swift on purpose: the test target reads this without
/// linking `MemryCore`.
struct SpikeS1Report: Sendable {
    var coreVersion = ""
    var helloWorld = ""
    /// The typed error `validateRecoveryPhrase` threw, reflected. A *variant*,
    /// not a rendered string, is the thing S1 has to show crossing the FFI.
    var typedError = ""
    var typedErrorIsRecoveryError = false
    var statesWalked: [String] = []
    var refreshOutcome = ""
    var observations: [SpikeCallbackObservation] = []
    var elapsedSeconds = 0.0
    /// Set when the nested, re-entrant `refresh()` never came back inside the
    /// watchdog window — the deadlock S1 exists to look for.
    var reentrantRefreshTimedOut = false
}

/// Holds the session so a callback can call back into it. The core constructs
/// nothing until `AuthSession.init` returns, so the reference cannot be passed
/// into the store it is built with.
private final class SessionBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: AuthSession?
    var session: AuthSession? {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

enum SpikeS1 {
    static func describe(_ state: AuthState) -> String {
        switch state {
        case .signedOut: return "SignedOut"
        case .awaitingOtp: return "AwaitingOtp"
        case .awaitingProviderToken: return "AwaitingProviderToken"
        case .setupPending: return "SetupPending"
        case .setupExpired: return "SetupExpired"
        case .registered: return "Registered"
        case .refreshing: return "Refreshing"
        case .sessionExpired: return "SessionExpired"
        case .revoked: return "Revoked"
        }
    }

    /// The hello-world half: one exported function in, one typed error out.
    static func helloWorld(into report: inout SpikeS1Report) {
        report.coreVersion = coreVersion()
        report.helloWorld = "coreVersion() = \(report.coreVersion)"
        do {
            _ = try validateRecoveryPhrase(phrase: "not a recovery phrase")
            report.typedError = "no error thrown — unexpected"
        } catch let error as RecoveryError {
            report.typedErrorIsRecoveryError = true
            report.typedError = String(reflecting: error)
        } catch {
            report.typedError = "non-RecoveryError: \(String(reflecting: error))"
        }
    }

    /// The threading half. Walks `AuthSession` to `Registered` over a stub
    /// transport, then calls `refresh()` — the one exported path that reaches
    /// `TokenManager::refresh`, which holds its `flight` mutex across the
    /// `SecureStore` and `Transport` callbacks below.
    static func run() async -> SpikeS1Report {
        var report = SpikeS1Report()
        helloWorld(into: &report)

        let log = SpikeObservationLog()
        let box = SessionBox()
        let started = Date()
        let timedOut = TimeoutFlag()

        let store = SpikeSecureStore(log: log) { key, _ in
            guard let session = box.session else { return "session not constructed yet" }
            // Re-entrant call #1: a different core lock (`state`), taken and
            // released inside `state()`.
            var note = "state()=\(describe(session.state()))"
            // Re-entrant call #2, only under the callback that runs with
            // `flight` held: ask the core to refresh *again* from inside its
            // own refresh. Watchdogged so a deadlock ends the test instead of
            // hanging it.
            if key == .refreshToken {
                note += "; nested refresh() -> \(nestedRefresh(session, timedOut))"
            }
            return note
        }

        let transport = SpikeStubTransport(log: log, replies: [
            "/auth/otp/request": (200, #"{"success":true,"expiresIn":600}"#),
            "/auth/otp/verify": (
                200,
                #"{"success":true,"setupToken":"\#(SpikeToken.mint(jti: "setup-1", type: "setup"))"}"#
            ),
            "/auth/devices": (200, """
                {"success":true,"deviceId":"spike-device",\
                "accessToken":"\(SpikeToken.mint(jti: "access-1", type: "access"))",\
                "refreshToken":"\(SpikeToken.mint(jti: "refresh-1", type: "refresh"))"}
                """),
            "/auth/refresh": (200, """
                {"accessToken":"\(SpikeToken.mint(jti: "access-2", type: "access"))",\
                "refreshToken":"\(SpikeToken.mint(jti: "refresh-2", type: "refresh"))",\
                "expiresIn":900}
                """)
        ])

        do {
            let session = try AuthSession(
                transport: transport,
                secureStore: store,
                baseUrl: "https://stub.invalid",
                clientPlatform: "ios",
                device: DeviceDescriptor(
                    name: "S1 spike",
                    platform: .ios,
                    osVersion: "26.5",
                    appVersion: "0.1.0",
                    vaultId: nil
                )
            )
            box.session = session
            report.statesWalked.append(describe(session.state()))
            report.statesWalked.append(describe(try await session.requestEmailCode(email: "spike@example.invalid")))
            report.statesWalked.append(describe(try await session.verifyEmailCode(code: "000000")))
            report.statesWalked.append(describe(try await session.registerDevice()))
            report.statesWalked.append(describe(try await session.refresh()))
            report.refreshOutcome = "refresh() returned \(report.statesWalked.last ?? "?")"
        } catch {
            report.refreshOutcome = "threw \(String(reflecting: error))"
        }

        report.elapsedSeconds = Date().timeIntervalSince(started)
        report.observations = log.all
        report.reentrantRefreshTimedOut = timedOut.value
        return report
    }

    private static func nestedRefresh(_ session: AuthSession, _ flag: TimeoutFlag) -> String {
        let semaphore = DispatchSemaphore(value: 0)
        let result = ResultBox()
        Task.detached {
            do {
                result.value = "returned \(describe(try await session.refresh()))"
            } catch {
                result.value = "threw \(String(reflecting: error))"
            }
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + 5) == .timedOut {
            flag.value = true
            return "DID NOT RETURN within 5s (deadlock)"
        }
        return result.value
    }
}

private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = "no result"
    var value: String {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}

private final class TimeoutFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
