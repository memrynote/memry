import Foundation
import Testing

@testable import Memry

// B0, gate G3a. These are spikes, not product tests: they exist to produce the
// notes in `specs/002-native-foundation-ios/research.md` §Addenda, and each one
// prints what it observed so the note can quote a real run rather than a claim.
//
// S4 is absent on purpose. It asks whether Argon2id at 64 MiB ops 3 OOMs on a
// physical iPhone 15; the simulator runs `aarch64-apple-ios-sim` on the host
// CPU and exercises neither the device's memory pressure nor the device's
// libsodium, so a green run here would be evidence for nothing.

@Suite("S1 — UniFFI XCFramework hello-world and callback threading")
struct SpikeS1Tests {
    @Test("a single exported function returns, and an error crosses as a variant")
    func helloWorld() {
        var report = SpikeS1Report()
        SpikeS1.helloWorld(into: &report)
        #expect(!report.coreVersion.isEmpty)
        #expect(report.typedErrorIsRecoveryError)
        SpikeReport.emit("S1/hello", [report.helloWorld, "typedError=\(report.typedError)"])
    }

    @Test("a foreign-trait callback logs its thread and may re-enter the core")
    func callbackThreading() async {
        let report = await SpikeS1.run()
        SpikeReport.emit("S1/threading", [
            "states=\(report.statesWalked.joined(separator: " -> "))",
            "refresh=\(report.refreshOutcome)",
            "elapsed=\(String(format: "%.2f", report.elapsedSeconds))s",
            "reentrantRefreshTimedOut=\(report.reentrantRefreshTimedOut)"
        ] + report.observations.map {
            """
            \($0.seam).\($0.method) | thread=\($0.threadDescription) \
            main=\($0.isMainThread) qos=\($0.qualityOfService) \
            reentrant=\($0.reentrantResult ?? "-")
            """
        })

        #expect(report.statesWalked == ["SignedOut", "AwaitingOtp", "SetupPending", "Registered", "Registered"])
        #expect(!report.observations.isEmpty)
        // The question research §E carries: which thread does Rust call back on?
        #expect(report.observations.allSatisfy { !$0.isMainThread })
        // The failure mode `@unchecked Sendable` hides: a callback that calls
        // back into the core while the core holds a lock.
        let underFlightLock = report.observations.filter { $0.method.contains("refreshToken") }
        #expect(!underFlightLock.isEmpty)
        #expect(!report.reentrantRefreshTimedOut)
    }
}

@Suite("S2 — async foreign-trait transport over URLSession", .serialized)
struct SpikeS2Tests {
    @Test("the core calls Swift's URLSession and reads staging's answer back")
    func roundTrip() async {
        let report = await SpikeS2.run()
        SpikeReport.emit("S2", [
            "GET /health (shell-driven) -> \(report.healthStatus) \(report.healthBody)",
            "core-driven url=\(report.coreDrivenUrl) requests=\(report.coreDrivenRequestCount)",
            "core-driven outcome=\(report.coreDrivenOutcome)",
            "cancel outcome=\(report.cancelOutcome) requests=\(report.cancelRequestCount)"
        ] + report.observations.map { "\($0.seam).\($0.method) | thread=\($0.threadDescription)" })

        #expect(report.healthStatus == 200)
        #expect(report.healthBody.contains("ok"))
        #expect(report.coreDrivenRequestCount == 1)
        #expect(report.coreDrivenUrl == "\(SpikeS2.stagingBaseUrl)/auth/otp/request")
        #expect(report.coreDrivenOutcome.contains("Status") || report.coreDrivenOutcome.contains("400"))
        // `Cancelled` is not retryable (chapter 00 §0.6): exactly one request.
        #expect(report.cancelRequestCount == 1)
        #expect(report.cancelOutcome.contains("Cancelled"))
    }
}

@Suite("S3 — WKWebView opaque origin")
struct SpikeS3Tests {
    @MainActor
    @Test("the bridge document is a secure context on one of R10's two origins")
    func secureContext() async {
        let opaque = await SpikeS3.run(in: SpikeS3.makeWebView())
        emit("about:blank (R10 decision)", opaque)

        // R10's only named fallback, taken here because the opaque origin
        // measured false. Its admissibility condition is the storage assertion
        // below, not the secure context alone.
        let handler = SpikeSchemeHandler(html: SpikeS3.html)
        let fallback = await SpikeS3.runFallback(
            in: SpikeS3.makeFallbackWebView(handler: handler, denyingStorage: false)
        )
        emit("memry:// (R10 fallback, WKURLSchemeHandler)", fallback)

        // R10's admissibility condition for the fallback, which a real origin
        // does not satisfy on its own.
        let denied = await SpikeS3.runFallback(
            in: SpikeS3.makeFallbackWebView(handler: handler, denyingStorage: true)
        )
        emit("memry:// + storage denied at document start", denied)

        #expect(opaque.failure == nil)
        #expect(fallback.failure == nil)
        #expect(denied.failure == nil)
        // The opaque origin persists nothing, which is the half that held.
        #expect(opaque.localStorageThrows && opaque.sessionStorageThrows && opaque.indexedDbUnavailable)
        // S3 passes when *some* origin gives the bundle SubtleCrypto.
        #expect(opaque.passes || fallback.passes)
        // And the origin that does must still refuse storage (R10's cost note).
        if !opaque.passes {
            #expect(denied.passes)
            #expect(denied.localStorageThrows)
            #expect(denied.sessionStorageThrows)
            #expect(denied.indexedDbUnavailable)
        }
    }

    @MainActor
    private func emit(_ label: String, _ report: SpikeS3Report) {
        SpikeReport.emit("S3 \(label)", [
            "origin=\(report.origin)",
            "isSecureContext=\(report.isSecureContext) crypto.subtle=\(report.hasCryptoSubtle)",
            "localStorage throws=\(report.localStorageThrows)",
            "sessionStorage throws=\(report.sessionStorageThrows)",
            "indexedDB unavailable=\(report.indexedDbUnavailable)",
            "failure=\(report.failure ?? "none")"
        ])
    }

    @MainActor
    @Test("the inputAccessoryView override returns the SwiftUI toolbar, and nil when hidden")
    func accessoryView() {
        let webView = SpikeS3.makeWebView()
        let first = webView.inputAccessoryView
        #expect(first != nil)
        // R16: cache the instance, or the bar flickers on every transition.
        #expect(webView.inputAccessoryView === first)
        webView.showsMemryToolbar = false
        #expect(webView.inputAccessoryView == nil)
    }
}

/// Spike output has to be readable in the `xcodebuild` log, because that log is
/// what the §Addenda note quotes.
enum SpikeReport {
    static func emit(_ label: String, _ lines: [String]) {
        FileHandle.standardError.write(Data(
            (["[spike \(label)]"] + lines.map { "  \($0)" }).joined(separator: "\n").appending("\n").utf8
        ))
    }
}
