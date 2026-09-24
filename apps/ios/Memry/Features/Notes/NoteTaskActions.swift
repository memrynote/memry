import Foundation
import MemryCore
import Observation
import SwiftUI

// TP054. The task writes a note screen makes: ticking a task line, and turning
// a checklist item into a task (FR-058).
//
// **Every rule is the core's** (D5). Completing a task from its line goes
// through `Tasks.complete`, which also ticks the line in every note that holds
// it, rolls a repeating task and completes open subtasks; converting a
// checklist item goes through `Tasks.convertChecklistItem`, which resolves the
// project (parent task line, note, default, Inbox), makes a subtask when the
// item sits under a task line, and rewrites the block. This file only carries
// the call and reports what came back.

/// The task write surface a note screen needs.
protocol NoteTaskWriting: Sendable {
    func complete(taskId: String, localNow: String) async throws
    func uncomplete(taskId: String) async throws
    /// The new task's id, or `nil` when the block is not a convertible
    /// checklist item (no text, already a task, or no project to file it in).
    func convertChecklistItem(noteId: String, blockId: String, localNow: String) async throws
        -> String?
}

/// The production surface: the core's own `Tasks`, over the shell's one serial
/// core queue.
struct CoreNoteTasks: NoteTaskWriting {
    private let vault: Vault
    private let store: any SecureStore
    private let executor: CoreExecutor

    init(vault: Vault, store: any SecureStore, executor: CoreExecutor) {
        self.vault = vault
        self.store = store
        self.executor = executor
    }

    /// Minted per write, for the reason `CoreNotesWriter` gives: a keychain
    /// locked when the write happens is what matters.
    private func tasks() throws -> Tasks {
        try vault.tasks(store: store)
    }

    func complete(taskId: String, localNow: String) async throws {
        _ = try await executor.run { try tasks().complete(id: taskId, localNow: localNow) }
    }

    func uncomplete(taskId: String) async throws {
        _ = try await executor.run { try tasks().uncomplete(id: taskId) }
    }

    func convertChecklistItem(noteId: String, blockId: String, localNow: String) async throws -> String? {
        try await executor.run {
            try tasks().convertChecklistItem(noteId: noteId, blockId: blockId, localNow: localNow)
        }
    }
}

/// The note screen's task writes and their one failure.
@MainActor
@Observable
final class NoteTaskActions {
    private let noteId: String
    private let tasks: (any NoteTaskWriting)?

    /// The last write that did not land, for the screen's alert.
    private(set) var failure: UserFacingError?
    /// Task and block ids with a write in flight, so a second tap on the same
    /// circle cannot race the first.
    private(set) var inFlight: Set<String> = []

    /// The shell's clock, injectable for tests.
    var clock: @Sendable () -> Date = { Date() }

    init(noteId: String, tasks: (any NoteTaskWriting)?) {
        self.noteId = noteId
        self.tasks = tasks
    }

    /// Absent rather than disabled: a vault with no identity to sign with
    /// cannot write a task, and a circle that refuses is worse than a still one.
    var canWrite: Bool { tasks != nil }

    /// Completes (`done`) or reopens one task. `true` when the write landed.
    @discardableResult
    func setDone(_ done: Bool, taskId: String) async -> Bool {
        guard let tasks, !inFlight.contains(taskId) else { return false }
        inFlight.insert(taskId)
        defer { inFlight.remove(taskId) }
        let now = TaskDates.localInstant(clock())
        do {
            if done {
                try await tasks.complete(taskId: taskId, localNow: now)
            } else {
                try await tasks.uncomplete(taskId: taskId)
            }
            Log.core.info("a task line was ticked or reopened from its note")
            return true
        } catch {
            report(error)
            return false
        }
    }

    /// Turns one checklist item into a task; returns the task's id.
    @discardableResult
    func convert(blockId: String) async -> String? {
        guard let tasks, !inFlight.contains(blockId) else { return nil }
        inFlight.insert(blockId)
        defer { inFlight.remove(blockId) }
        let now = TaskDates.localInstant(clock())
        do {
            guard let id = try await tasks.convertChecklistItem(
                noteId: noteId, blockId: blockId, localNow: now
            ) else {
                failure = Self.refused
                return nil
            }
            Log.core.info("a checklist item became a task", .count(1))
            return id
        } catch {
            report(error)
            return nil
        }
    }

    func dismissFailure() { failure = nil }

    /// The core answered "not convertible" rather than failing.
    static let refused = UserFacingError(
        code: "task.convert.refused",
        title: TasksCopy.convertRefusedTitle,
        guidance: TasksCopy.convertRefusedGuidance,
        recourse: .blocked,
        isUserVisible: true
    )

    private func report(_ error: any Error) {
        let mapped = ErrorMapping.userFacing(error)
        Log.core.error("a task write from a note did not land", .code(mapped.code))
        if mapped.isUserVisible { failure = mapped }
    }
}

/// What a task line or a checklist item in the body can do, as closures, so
/// the block views depend on functions rather than on the screen's models.
/// Every member is `nil` when the screen cannot do it.
struct NoteTaskBridge {
    /// Completes (`true`) or reopens (`false`) a task by id.
    var setDone: ((String, Bool) -> Void)?
    /// Opens a task in the Tasks tab.
    var open: ((String) -> Void)?
    /// Turns a checklist item into a task, by block id.
    var convert: ((String) -> Void)?
    /// Nests a block under the one above it (desktop's Tab), by block id.
    var indent: ((String) -> Void)?
    /// Lifts a block one level (Shift-Tab), by block id.
    var outdent: ((String) -> Void)?
    /// Whether a write for this task or block id is in flight.
    var isBusy: (String) -> Bool = { _ in false }
}

extension NoteTaskBridge {
    /// The note screen's bridge: task writes through `tasks`, nesting through
    /// the body editor, opening through the Tasks tab's router. `didChange`
    /// re-reads the note (its lines and task cards) after a write landed.
    @MainActor
    static func note(
        tasks: NoteTaskActions,
        editor: NoteEditorViewModel,
        router: TasksRouter?,
        didChange: @escaping @MainActor () async -> Void
    ) -> NoteTaskBridge {
        var bridge = NoteTaskBridge()
        bridge.open = router.map { router in { router.openTask($0) } }
        bridge.isBusy = { tasks.inFlight.contains($0) }
        if tasks.canWrite {
            bridge.setDone = { id, done in
                Task { @MainActor in
                    if await tasks.setDone(done, taskId: id) { await didChange() }
                }
            }
            bridge.convert = { blockId in
                Task { @MainActor in
                    if await tasks.convert(blockId: blockId) != nil { await didChange() }
                }
            }
        }
        if editor.canEdit {
            bridge.indent = { blockId in
                Task { @MainActor in
                    await editor.indent(blockId)
                    await didChange()
                }
            }
            bridge.outdent = { blockId in
                Task { @MainActor in
                    await editor.outdent(blockId)
                    await didChange()
                }
            }
        }
        return bridge
    }
}

extension EnvironmentValues {
    /// The note screen's task affordances; `nil` outside a note screen.
    @Entry var noteTasks: NoteTaskBridge?
}
