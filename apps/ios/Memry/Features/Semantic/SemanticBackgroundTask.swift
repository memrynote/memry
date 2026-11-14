import BackgroundTasks
import Foundation
import MemryCore

// #4512. The background embedder. iOS runs `com.memry.app.semantic.embed`
// while the phone charges; the core decides each step's work and pace, and
// this loop only relays conditions and sleeps.
//
// A cold background launch connects no scene, so no vault opens: the vault
// opens only through the sign-in and vault screens. The task then completes
// with no work and runs again after the next foreground session.

/// What the loop needs from a `BGTask`, so a test can stand in for one.
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
    /// The open vault; nil until one opens this launch.
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

    /// Asks for a run when this vault still has notes to embed.
    func scheduleIfDue() {
        guard let semantic, let vault else { return }
        let status = semantic.status(vault: vault)
        guard status.model == .ready, status.embeddedNotes < status.totalNotes else { return }
        Self.schedule()
    }

    nonisolated static func schedule() {
        do {
            try BGTaskScheduler.shared.submit(request())
        } catch {
            Log.core.notice("the semantic embedder could not be scheduled", .code("semantic.bg.schedule"))
        }
    }

    private func run(_ task: SemanticTaskRun) {
        let step: SemanticStep? = semantic.flatMap { semantic in
            vault.map { vault in { try await semantic.embedStep(vault: vault, conditions: $0) } }
        }
        Self.drive(task, step: step, conditions: SemanticSignals.current, reschedule: Self.schedule)
    }

    /// Steps until the core says finished or stopped, or iOS expires the task.
    /// Expiry completes the task at once: a window in flight writes nothing
    /// until its note's last window commits, so at most that note is lost.
    @discardableResult
    static func drive(
        _ task: SemanticTaskRun,
        step: SemanticStep?,
        conditions: @escaping @MainActor () -> StepConditions,
        reschedule: @escaping @MainActor () -> Void,
        rest: @escaping @Sendable (UInt32) async throws -> Void = { try await Task.sleep(for: .milliseconds($0)) }
    ) -> Task<Void, Never> {
        var completed = false
        let complete = { (success: Bool) in
            guard !completed else { return }
            completed = true
            if !success { reschedule() }
            task.setTaskCompleted(success: success)
        }
        let work = Task { @MainActor in
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
