import Foundation
import MemryCore
import Testing
@testable import Memry

@MainActor
final class FakeTaskRun: SemanticTaskRun {
    var expirationHandler: (() -> Void)?
    var completions: [Bool] = []

    func setTaskCompleted(success: Bool) { completions.append(success) }
}

/// A step the test answers one call at a time.
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
        let work = SemanticBackgroundTask.drive(
            task, step: steps.step, conditions: { cool }, reschedule: { reschedules += 1 }, rest: { _ in }
        )
        await steps.answer(.embedded(embedded: 0, total: 3, restMs: 0))
        while steps.calls < 2 { await Task.yield() }

        task.expirationHandler?()
        while task.completions.isEmpty { await Task.yield() }
        #expect(task.completions == [false])
        #expect(reschedules == 1)

        // The window in flight finishes after expiry and completes nothing again.
        await steps.answer(.embedded(embedded: 1, total: 3, restMs: 0))
        await work.value
        #expect(task.completions == [false])
        #expect(reschedules == 1)
        #expect(steps.calls == 2)
    }

    @Test func finishedCompletesWithSuccessAndNoReschedule() async {
        let task = FakeTaskRun()
        let steps = ScriptedSteps()
        var reschedules = 0
        let work = SemanticBackgroundTask.drive(
            task, step: steps.step, conditions: { cool }, reschedule: { reschedules += 1 }, rest: { _ in }
        )
        await steps.answer(.embedded(embedded: 1, total: 2, restMs: 0))
        await steps.answer(.finished(embedded: 2, total: 2))
        await work.value
        #expect(task.completions == [true])
        #expect(reschedules == 0)
    }

    @Test func tooHotStopsAndReschedules() async {
        let task = FakeTaskRun()
        let steps = ScriptedSteps()
        var reschedules = 0
        let work = SemanticBackgroundTask.drive(
            task, step: steps.step, conditions: { cool }, reschedule: { reschedules += 1 }, rest: { _ in }
        )
        await steps.answer(.stopped(reason: .tooHot))
        await work.value
        #expect(task.completions == [false])
        #expect(reschedules == 1)
    }

    @Test func noOpenVaultCompletesWithNoWork() async {
        let task = FakeTaskRun()
        var reschedules = 0
        await SemanticBackgroundTask.drive(
            task, step: nil, conditions: { cool }, reschedule: { reschedules += 1 }, rest: { _ in }
        ).value
        #expect(task.completions == [true])
        #expect(reschedules == 0)
    }
}
