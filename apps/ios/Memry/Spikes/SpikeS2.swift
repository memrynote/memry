import Foundation
import MemryCore

/// What S2 observed.
struct SpikeS2Report: Sendable {
    /// The `GET /health` leg. **Shell-driven**: no exported core function
    /// issues a request to `/health`, so this leg exercises the `URLSession`
    /// adapter and staging, not the foreign-trait hop. Recorded separately for
    /// exactly that reason.
    var healthStatus = 0
    var healthBody = ""

    /// The Rust-driven leg: the core built the request, called this Swift
    /// `Transport`, and read the answer back.
    var coreDrivenUrl = ""
    var coreDrivenOutcome = ""
    var coreDrivenRequestCount = 0

    /// The cancellation leg.
    var cancelOutcome = ""
    var cancelRequestCount = 0

    var observations: [SpikeCallbackObservation] = []
}

enum SpikeS2 {
    static let stagingBaseUrl = "https://sync-staging.memrynote.com"

    private static func device() -> DeviceDescriptor {
        DeviceDescriptor(
            name: "S2 spike",
            platform: .ios,
            osVersion: "26.5",
            appVersion: "0.1.0",
            vaultId: nil
        )
    }

    static func run() async -> SpikeS2Report {
        var report = SpikeS2Report()
        let log = SpikeObservationLog()

        // Leg 1 — the same adapter object, called directly, against /health.
        let direct = SpikeURLSessionTransport(log: log)
        do {
            let response = try await direct.send(request: HttpRequest(
                method: "GET",
                url: "\(stagingBaseUrl)/health",
                headers: ["accept": "application/json"],
                body: nil,
                timeoutMs: 15_000
            ))
            report.healthStatus = Int(response.status)
            report.healthBody = String(bytes: response.body, encoding: .utf8) ?? "<not utf-8>"
        } catch {
            report.healthStatus = -1
            report.healthBody = String(reflecting: error)
        }

        // Leg 2 — Rust builds the request and calls Swift. The closest
        // unauthenticated route the exported surface can reach; a malformed
        // address is refused by staging before any mail is sent.
        let live = SpikeURLSessionTransport(log: log)
        do {
            let session = try AuthSession(
                transport: live,
                secureStore: SpikeSecureStore(log: log),
                baseUrl: stagingBaseUrl,
                clientPlatform: "ios",
                device: device()
            )
            let state = try await session.requestEmailCode(email: "not-an-email")
            report.coreDrivenOutcome = "returned \(SpikeS1.describe(state))"
        } catch {
            report.coreDrivenOutcome = String(reflecting: error)
        }
        report.coreDrivenUrl = live.sentUrls.first ?? "none"
        report.coreDrivenRequestCount = live.sentUrls.count

        // Leg 3 — the shell cancels the in-flight task. `Cancelled` is not
        // retryable (chapter 00 §0.6), so the core must issue exactly one.
        let cancelling = SpikeURLSessionTransport(log: log, cancelAfterMs: 1)
        do {
            let session = try AuthSession(
                transport: cancelling,
                secureStore: SpikeSecureStore(log: log),
                baseUrl: stagingBaseUrl,
                clientPlatform: "ios",
                device: device()
            )
            _ = try await session.requestEmailCode(email: "not-an-email")
            report.cancelOutcome = "no error — the cancel did not land"
        } catch {
            report.cancelOutcome = String(reflecting: error)
        }
        report.cancelRequestCount = cancelling.sentUrls.count

        report.observations = log.all
        return report
    }
}
