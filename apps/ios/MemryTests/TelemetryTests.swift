import Foundation
import MemryCore
import Testing
@testable import Memry

// The telemetry queue: what a flush sends, and what stays queued after each
// answer the core can give. The wire itself is proven against the real
// server by `crates/memry-core/tests/telemetry_send.rs` and a staging run.

private actor RecordingSender: TelemetrySending {
    var answers: [TelemetryDelivery]
    private(set) var bodies: [Data] = []

    init(answers: [TelemetryDelivery]) { self.answers = answers }

    func sendTelemetry(batchJson: Data) async -> TelemetryDelivery {
        bodies.append(batchJson)
        return answers.isEmpty ? .accepted : answers.removeFirst()
    }
}

private func makeTelemetry(enabled: Bool = true) async -> (Telemetry, URL) {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("telemetry-\(UUID().uuidString).json")
    let telemetry = Telemetry(store: TelemetryQueueStore(url: url))
    let context = TelemetryContext(
        installId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        appVersion: "0.1.0",
        buildChannel: "staging",
        locale: "en-US",
        timezoneOffsetMinutes: 180
    )
    await telemetry.start(context: context, allowed: true, enabled: enabled, previousVersion: nil)
    return (telemetry, url)
}

private func json(_ data: Data) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

struct TelemetryTests {
    @Test func aFlushSendsTheContractBatchAndClearsTheQueue() async throws {
        let (telemetry, _) = await makeTelemetry()
        let sender = RecordingSender(answers: [.accepted])
        await telemetry.attach(sender: sender)
        await telemetry.setAuthState(.signedIn)

        await telemetry.flush()

        let body = try #require(await sender.bodies.first)
        let batch = try json(body)
        #expect(batch["schemaVersion"] as? Int == 1)
        #expect(batch["platform"] as? String == "ios")
        #expect(batch["buildChannel"] as? String == "staging")
        #expect(batch["authState"] as? String == "signed_in")
        let events = try #require(batch["events"] as? [[String: Any]])
        #expect(events.map { $0["name"] as? String } == ["app_started"])
        let occurredAt = try #require(events.first?["occurredAt"] as? String)
        #expect(occurredAt.hasSuffix("Z"))
        #expect(await telemetry.pending.isEmpty)
    }

    @Test func aRetryLaterKeepsTheBatchAndARejectionDropsIt() async throws {
        let (telemetry, _) = await makeTelemetry()
        let sender = RecordingSender(answers: [.retryLater, .rejected])
        await telemetry.attach(sender: sender)

        await telemetry.flush()
        #expect(await telemetry.pending.count == 1)

        await telemetry.flush()
        #expect(await telemetry.pending.isEmpty)
    }

    @Test func theQueueSurvivesARelaunch() async throws {
        let (telemetry, url) = await makeTelemetry()
        await telemetry.becameInactive()

        let relaunched = Telemetry(store: TelemetryQueueStore(url: url))
        #expect(await relaunched.pending.map(\.name) == [.appStarted, .appBackgrounded])
    }

    @Test func optingOutDropsTheQueueAndRecordsNothing() async throws {
        let (telemetry, url) = await makeTelemetry()
        await telemetry.setEnabled(false)
        await telemetry.record(TelemetryEvent.make(.noteCreated, surface: .notes, action: "created"))

        #expect(await telemetry.pending.isEmpty)
        #expect(await Telemetry(store: TelemetryQueueStore(url: url)).pending.isEmpty)
    }

    @Test func aBuildThatDoesNotReportIgnoresTheSwitch() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("telemetry-\(UUID().uuidString).json")
        let telemetry = Telemetry(store: TelemetryQueueStore(url: url))
        let context = TelemetryContext(
            installId: "11111111-1111-4111-8111-111111111111",
            sessionId: "22222222-2222-4222-8222-222222222222",
            appVersion: "0.1.0",
            buildChannel: "staging",
            locale: "en-US",
            timezoneOffsetMinutes: 0
        )
        await telemetry.start(context: context, allowed: false, enabled: true, previousVersion: nil)
        await telemetry.setEnabled(true)
        await telemetry.record(TelemetryEvent.make(.noteCreated, surface: .notes, action: "created"))

        #expect(await telemetry.pending.isEmpty)
    }

    @Test func aVersionChangeReportsTheUpdate() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("telemetry-\(UUID().uuidString).json")
        let telemetry = Telemetry(store: TelemetryQueueStore(url: url))
        let context = TelemetryContext(
            installId: "11111111-1111-4111-8111-111111111111",
            sessionId: "22222222-2222-4222-8222-222222222222",
            appVersion: "0.2.0",
            buildChannel: "production",
            locale: "en-US",
            timezoneOffsetMinutes: 0
        )
        await telemetry.start(context: context, allowed: true, enabled: true, previousVersion: "0.1.0")

        let update = try #require(await telemetry.pending.last)
        #expect(update.name == .appUpdateInstalled)
        #expect(update.dimensions == ["from_version": "0.1.0"])
    }

    @Test func aDimensionThatCouldCarryContentIsDropped() {
        #expect(TelemetryEvent.dimension(.value, "notes/secret.md") == nil)
        #expect(TelemetryEvent.dimension(.value, "k@example.com") == nil)
        #expect(TelemetryEvent.dimension(.setting, "clockFormat") == ["setting": "clockFormat"])
    }

    @Test func aCrashIsCodedByExceptionAndSignal() {
        #expect(CrashReporter.code(exception: 1, signal: 11) == "EXC_BAD_ACCESS:SIGSEGV")
        #expect(CrashReporter.code(exception: nil, signal: nil) == "EXC_UNKNOWN:SIGNONE")
    }
}
