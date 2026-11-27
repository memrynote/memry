import BackgroundTasks
import Foundation
import MemryCore
import Testing
@testable import Memry

final class FakeTaskRun: SemanticTaskRun, @unchecked Sendable {
    var expirationHandler: (() -> Void)?
    var completions: [Bool] = []

    func setTaskCompleted(success: Bool) { completions.append(success) }
}

final class FakeSemantic: SemanticSearchProtocol, @unchecked Sendable {
    var answer: SemanticStatus

    init(_ answer: SemanticStatus) { self.answer = answer }

    func status(vault _: Vault) -> SemanticStatus { answer }
    func disable(vault _: Vault) async throws {}
    func enable(availableBytes _: UInt64) async throws -> ModelState { answer.model }
    func resume() async throws -> ModelState { answer.model }
    func embedStep(vault _: Vault, conditions _: StepConditions) async throws -> StepOutcome {
        .finished(embedded: answer.embeddedNotes, total: answer.totalNotes)
    }
    func release(reason _: ReleaseReason) {}
}

@MainActor
final class ScriptedSteps {
    private var waiting: CheckedContinuation<StepOutcome, Never>?
    private(set) var calls = 0

    func step(_: StepConditions) async throws -> StepOutcome {
        calls += 1
        return await withCheckedContinuation { waiting = $0 }
    }

    func answer(_ outcome: StepOutcome) async {
        while waiting == nil { await Task.yield() }
        waiting?.resume(returning: outcome)
        waiting = nil
    }
}

@MainActor
struct SemanticBackgroundTaskTests {
    private let cool = StepConditions(thermal: .nominal, externalPower: true)

    @Test func theRequestWaitsForPowerAndNotTheNetwork() {
        let request = SemanticBackgroundTask.request()
        #expect(request.identifier == "com.memry.app.semantic.embed")
        #expect(request.requiresExternalPower)
        #expect(!request.requiresNetworkConnectivity)
        let permitted = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String]
        #expect(permitted?.contains(SemanticBackgroundTask.identifier) == true)
    }

    @Test func everyThermalStateMaps() {
        #expect(Thermal(ProcessInfo.ThermalState.nominal) == .nominal)
        #expect(Thermal(ProcessInfo.ThermalState.fair) == .fair)
        #expect(Thermal(ProcessInfo.ThermalState.serious) == .serious)
        #expect(Thermal(ProcessInfo.ThermalState.critical) == .critical)
    }

    @Test func expiryCompletesTheTaskAtOnceAndReschedules() async {
        let task = FakeTaskRun()
        let steps = ScriptedSteps()
        var reschedules = 0
        var releases = 0
        let work = SemanticBackgroundTask.drive(
            task, step: steps.step, conditions: { cool }, reschedule: { reschedules += 1 }, rest: { _ in }, releaseAfterLastStep: { releases += 1 }
        )
        await steps.answer(.embedded(embedded: 0, total: 3, restMs: 0))
        while steps.calls < 2 { await Task.yield() }

        task.expirationHandler?()
        while task.completions.isEmpty { await Task.yield() }
        #expect(task.completions == [false])
        #expect(reschedules == 1)
        #expect(releases == 0, "the window in flight still holds the model")

        await steps.answer(.embedded(embedded: 1, total: 3, restMs: 0))
        await work.value
        #expect(task.completions == [false])
        #expect(reschedules == 1)
        #expect(steps.calls == 2)
        #expect(releases == 1, "released once the window ended")
    }

    @Test func finishedCompletesWithSuccessAndNoReschedule() async {
        let task = FakeTaskRun()
        let steps = ScriptedSteps()
        var reschedules = 0
        var releases = 0
        let work = SemanticBackgroundTask.drive(
            task, step: steps.step, conditions: { cool }, reschedule: { reschedules += 1 }, rest: { _ in }, releaseAfterLastStep: { releases += 1 }
        )
        await steps.answer(.embedded(embedded: 1, total: 2, restMs: 0))
        await steps.answer(.finished(embedded: 2, total: 2))
        await work.value
        #expect(task.completions == [true])
        #expect(reschedules == 0)
        #expect(releases == 1)
    }

    @Test func tooHotStopsAndReschedules() async {
        let task = FakeTaskRun()
        let steps = ScriptedSteps()
        var reschedules = 0
        var releases = 0
        let work = SemanticBackgroundTask.drive(
            task, step: steps.step, conditions: { cool }, reschedule: { reschedules += 1 }, rest: { _ in }, releaseAfterLastStep: { releases += 1 }
        )
        await steps.answer(.stopped(reason: .tooHot))
        await work.value
        #expect(task.completions == [false])
        #expect(reschedules == 1)
        #expect(releases == 1)
    }

    @Test func aFailedStepCompletesAndReleasesOnce() async {
        let task = FakeTaskRun()
        var reschedules = 0
        var releases = 0
        await SemanticBackgroundTask.drive(
            task, step: { _ in throw CancellationError() }, conditions: { cool },
            reschedule: { reschedules += 1 }, rest: { _ in }, releaseAfterLastStep: { releases += 1 }
        ).value
        #expect(task.completions == [false])
        #expect(reschedules == 1)
        #expect(releases == 1)
    }

    @Test func aReadyModelSchedulesEvenWhenTheCountsReadDone() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("memry-semantic-bg-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try Vault.open(vaultId: "vault-semantic-bg", directory: directory.path)
        let embedder = SemanticBackgroundTask()
        var schedules = 0

        let semantic = FakeSemantic(SemanticStatus(model: .ready, downloadBytes: 1, embeddedNotes: 2, totalNotes: 2))
        embedder.attach(semantic: semantic, vault: vault)
        embedder.scheduleIfReady { schedules += 1 }
        #expect(schedules == 1)

        semantic.answer = SemanticStatus(model: .off, downloadBytes: 1, embeddedNotes: 0, totalNotes: 2)
        embedder.scheduleIfReady { schedules += 1 }
        #expect(schedules == 1, "no model, no run")
    }

    @Test func noOpenVaultCompletesWithNoWork() async {
        let task = FakeTaskRun()
        var reschedules = 0
        var releases = 0
        await SemanticBackgroundTask.drive(
            task, step: nil, conditions: { cool }, reschedule: { reschedules += 1 }, rest: { _ in }, releaseAfterLastStep: { releases += 1 }
        ).value
        #expect(task.completions == [true])
        #expect(reschedules == 0)
        #expect(releases == 1)
    }
}
