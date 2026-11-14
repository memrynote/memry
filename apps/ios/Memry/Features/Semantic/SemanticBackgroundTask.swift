import BackgroundTasks
import Foundation
import MemryCore
import UIKit

protocol SemanticTaskRun: AnyObject {
    var expirationHandler: (() -> Void)? { get set }
    func setTaskCompleted(success: Bool)
}

extension BGTask: SemanticTaskRun {}

typealias SemanticStep = @MainActor (StepConditions) async throws -> StepOutcome

@MainActor
final class SemanticBackgroundTask {
    static let shared = SemanticBackgroundTask()
    nonisolated static let identifier = "com.memry.app.semantic.embed"

    private var semantic: (any SemanticSearchProtocol)?
    private weak var vault: Vault?

    func attach(semantic: (any SemanticSearchProtocol)?, vault: Vault) {
        self.semantic = semantic
        self.vault = vault
    }

    /// Before launch finishes (`BGTaskScheduler` rejects later registrations).
    nonisolated static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            // Delivered on the main queue (`using: .main`).
            nonisolated(unsafe) let task = task
            MainActor.assumeIsolated { shared.run(task) }
        }
    }

    nonisolated static func request() -> BGProcessingTaskRequest {
        let request = BGProcessingTaskRequest(identifier: identifier)
        request.requiresExternalPower = true
        request.requiresNetworkConnectivity = false
        return request
    }

    func scheduleIfReady(schedule: () -> Void = SemanticBackgroundTask.schedule) {
        guard let semantic, let vault, semantic.status(vault: vault).model == .ready else { return }
        schedule()
    }

    nonisolated static func schedule() {
        do {
            try BGTaskScheduler.shared.submit(request())
        } catch {
            Log.core.notice("the semantic embedder could not be scheduled", .code("semantic.bg.schedule"))
        }
    }

    private func run(_ task: SemanticTaskRun) {
        var step: SemanticStep?
        if let semantic, let vault {
            step = { try await semantic.embedStep(vault: vault, conditions: $0) }
        }
        Self.drive(task, step: step, conditions: SemanticSignals.current, reschedule: Self.schedule) { [semantic] in
            guard UIApplication.shared.applicationState != .active else { return }
            semantic?.release(reason: .background)
        }
    }

    @discardableResult
    static func drive(
        _ task: SemanticTaskRun,
        step: SemanticStep?,
        conditions: @escaping @MainActor () -> StepConditions,
        reschedule: @escaping @MainActor () -> Void,
        rest: @escaping @Sendable (UInt32) async throws -> Void = { try await Task.sleep(for: .milliseconds($0)) },
        releaseAfterLastStep: @escaping @MainActor () -> Void
    ) -> Task<Void, Never> {
        var completed = false
        let complete = { (success: Bool) in
            guard !completed else { return }
            completed = true
            if !success { reschedule() }
            task.setTaskCompleted(success: success)
        }
        let work = Task { @MainActor in
            defer { releaseAfterLastStep() }
            guard let step else { return complete(true) }
            while !Task.isCancelled {
                do {
                    switch try await step(conditions()) {
                    case let .embedded(_, _, restMs): try await rest(restMs)
                    case .finished: return complete(true)
                    case .stopped(.modelNotReady), .stopped(.unavailable): return complete(true)
                    case .stopped: return complete(false)
                    }
                } catch is CancellationError {
                    break
                } catch {
                    Log.core.error("a semantic embed step failed", .code(ErrorMapping.userFacing(error).code))
                    break
                }
            }
            complete(false)
        }
        task.expirationHandler = {
            Task { @MainActor in
                work.cancel()
                complete(false)
            }
        }
        return work
    }
}
