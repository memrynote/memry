import Foundation
import MemryCore
import Observation

// TP030. The one model every task screen reads: the vault's tasks, projects,
// saved filters and settings, the current page query and its answer, and the
// last undoable change.
//
// **All logic is the core's** (D5). The store holds UI state and hands every
// decision — which tasks a tab shows, how a filter narrows, what completing a
// repeating task produces — to `Tasks`, whose rules are pinned by vectors.
//
// **Writes then sync.** A write is durable locally when the core answers; the
// store refreshes from the core (never patches its own copy), keeps the change
// for Undo, then runs one pull-then-push pass so the edit reaches desktop.
// A failed sync is reported, not retried in a loop: the outbox keeps the row.
//
// Feature screens add operations in `TasksStore+<Feature>.swift` extensions
// built on ``perform(_:_:)``, so no two screens edit this file.

/// A question a screen asks before it writes (e.g. "complete the subtasks
/// too?"). Raised by a store extension, answered by the block that owns the
/// case (subtasks: TP046, repeating: TP045).
enum TasksPrompt: Equatable, Sendable, Identifiable {
    case completeParent(taskId: String)
    case allSubtasksDone(parentId: String)
    case deleteParent(taskId: String)
    case stopRepeating(taskId: String)
    case editRepeating(taskId: String)

    var id: String {
        switch self {
        case let .completeParent(id): "completeParent-\(id)"
        case let .allSubtasksDone(id): "allSubtasksDone-\(id)"
        case let .deleteParent(id): "deleteParent-\(id)"
        case let .stopRepeating(id): "stopRepeating-\(id)"
        case let .editRepeating(id): "editRepeating-\(id)"
        }
    }
}

/// An undoable change with the words its toast shows.
struct TasksUndo: Equatable, Sendable {
    let message: String
    let change: TaskChange
}

@MainActor
@Observable
final class TasksStore {
    // MARK: Data

    private(set) var items: [String: TaskItem] = [:]
    /// Every live task in `position` order.
    private(set) var ordered: [TaskItem] = []
    private(set) var projects: [ProjectItem] = []
    private(set) var savedFilters: [SavedFilterItem] = []
    private(set) var settings: TaskSettingsItem?
    private(set) var result: TaskViewResult?

    // MARK: State

    var state: TasksViewState {
        didSet {
            if state != oldValue { persist() }
        }
    }

    private(set) var failure: UserFacingError?
    private(set) var isLoading = false
    private(set) var isSyncing = false
    /// The last change a toast may undo.
    var undoable: TasksUndo?
    /// A short confirmation the list shows (e.g. "Task completed!").
    var toast: String?
    /// A dialog a block raised and another answers.
    var prompt: TasksPrompt?
    /// Free-form state a feature block may keep between screens, keyed by
    /// the block (extensions cannot add stored properties).
    var scratch: [String: String] = [:]

    // MARK: Dependencies

    let core: any TasksProtocol
    private let executor: CoreExecutor
    private let filler: (any VaultFilling)?
    private let defaults: UserDefaults
    private let stateKey: String
    /// The shell's clock, injectable for tests.
    var clock: @Sendable () -> Date = { Date() }
    /// Calendar `weekStartDay`: 0 Sunday, 1 Monday (desktop's default).
    var weekStartsOn: UInt32 = 1

    init(
        core: any TasksProtocol,
        executor: CoreExecutor = .shared,
        filler: (any VaultFilling)?,
        vaultId: String,
        defaults: UserDefaults = .standard
    ) {
        self.core = core
        self.executor = executor
        self.filler = filler
        self.defaults = defaults
        stateKey = "tasks-view-state.\(vaultId)"
        if let data = defaults.data(forKey: stateKey),
           let saved = try? JSONDecoder().decode(TasksViewState.self, from: data) {
            state = saved
        } else {
            state = TasksViewState()
        }
    }

    // MARK: Reading

    /// Everything, then the page query. The first call also applies the
    /// synced default view when no view state was saved.
    func load() async {
        isLoading = true
        defer { isLoading = false }
        let core = core
        do {
            let loaded = try await executor.run {
                (
                    try core.all(),
                    try core.projects(includeArchived: true),
                    try core.savedFilters(),
                    try core.taskSettings()
                )
            }
            apply(tasks: loaded.0)
            projects = loaded.1
            savedFilters = loaded.2
            settings = loaded.3
            try await query()
            failure = nil
        } catch {
            report(error)
        }
    }

    /// Re-reads tasks and the page query (after a write or a sync).
    func refresh() async {
        let core = core
        do {
            let loaded = try await executor.run {
                (try core.all(), try core.projects(includeArchived: true), try core.savedFilters())
            }
            apply(tasks: loaded.0)
            projects = loaded.1
            savedFilters = loaded.2
            try await query()
        } catch {
            report(error)
        }
    }

    /// Asks the core for the current tab/scope/filter/sort.
    func query() async throws {
        let core = core
        let query = TaskViewQuery(
            tab: state.tab.rawValue,
            projectId: state.projectId,
            filtersJson: state.filters.json,
            sortJson: state.sort.json,
            now: localNow(),
            weekStartsOn: weekStartsOn
        )
        result = try await executor.run { try core.view(query: query) }
    }

    /// Changes the page state and re-queries.
    func update(_ change: (inout TasksViewState) -> Void) async {
        change(&state)
        do { try await query() } catch { report(error) }
    }

    private func apply(tasks: [TaskItem]) {
        ordered = tasks
        items = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: Writing

    /// Runs one core write, refreshes, remembers it for Undo, then syncs.
    ///
    /// - Parameter message: the toast; `nil` for an edit that needs none.
    @discardableResult
    func perform(
        _ message: String?,
        _ work: @escaping @Sendable (any TasksProtocol) throws -> TaskChange
    ) async -> TaskChange? {
        let core = core
        do {
            let change = try await executor.run { try work(core) }
            if let message {
                undoable = TasksUndo(message: message, change: change)
                toast = message
            }
            failure = nil
            await refresh()
            scheduleSync()
            return change
        } catch {
            report(error)
            return nil
        }
    }

    /// Runs a core write that returns something other than a change (projects,
    /// filters, settings), then refreshes and syncs.
    @discardableResult
    func run<T: Sendable>(_ work: @escaping @Sendable (any TasksProtocol) throws -> T) async -> T? {
        let core = core
        do {
            let value = try await executor.run { try work(core) }
            failure = nil
            await refresh()
            scheduleSync()
            return value
        } catch {
            report(error)
            return nil
        }
    }

    /// Reads without refreshing or syncing.
    func read<T: Sendable>(_ work: @escaping @Sendable (any TasksProtocol) throws -> T) async -> T? {
        let core = core
        do {
            return try await executor.run { try work(core) }
        } catch {
            report(error)
            return nil
        }
    }

    /// Reverts the last undoable change.
    /// Two changes as one undo: `undo` reverts `changed` last-first and
    /// brings back everything in `removed`.
    nonisolated static func merge(_ first: TaskChange?, _ second: TaskChange?) -> TaskChange {
        TaskChange(
            changed: (first?.changed ?? []) + (second?.changed ?? []),
            created: (first?.created ?? []) + (second?.created ?? []),
            deleted: (first?.deleted ?? []) + (second?.deleted ?? []),
            removed: (first?.removed ?? []) + (second?.removed ?? [])
        )
    }

    func undo() async {
        guard let undoable else { return }
        self.undoable = nil
        toast = nil
        let change = undoable.change
        await perform(nil) { try $0.undo(change: change) }
    }

    func settingsChanged(_ updated: TaskSettingsItem) {
        settings = updated
    }

    // MARK: Sync

    private var syncTask: Task<Void, Never>?

    /// One pull-then-push pass, coalesced: writes in quick succession share it.
    func scheduleSync() {
        guard filler != nil else { return }
        syncTask?.cancel()
        syncTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    /// Pull then push now (pull-to-refresh, foreground).
    func sync() async {
        guard let filler, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            _ = try await filler.syncNow()
            Log.sync.info("task sync pass finished")
        } catch {
            report(error)
        }
        await refresh()
    }

    // MARK: Clock

    /// The shell's local wall clock, `YYYY-MM-DDTHH:MM:SS`, as every core
    /// calendar question takes it.
    func localNow() -> String {
        TaskDates.localInstant(clock())
    }

    /// Today's `YYYY-MM-DD` in the user's zone.
    func today() -> String {
        TaskDates.key(clock())
    }

    // MARK: Errors

    func report(_ error: any Error) {
        let mapped = ErrorMapping.userFacing(error)
        Log.core.error("a task operation failed", .code(mapped.code))
        if mapped.isUserVisible { failure = mapped }
    }

    func clearFailure() { failure = nil }

    private func persist() {
        if let data = try? JSONEncoder().encode(state) {
            defaults.set(data, forKey: stateKey)
        }
    }
}

/// Local calendar conversions every task screen shares.
enum TaskDates {
    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = format
        return formatter
    }

    static func localInstant(_ date: Date) -> String {
        formatter("yyyy-MM-dd'T'HH:mm:ss").string(from: date)
    }

    static func key(_ date: Date) -> String {
        formatter("yyyy-MM-dd").string(from: date)
    }

    /// A stored `YYYY-MM-DD` (or a timestamp's day) as a local date.
    static func date(_ key: String) -> Date? {
        formatter("yyyy-MM-dd").date(from: String(key.prefix(10)))
    }

    /// An instant as desktop writes one (`toISOString`).
    static func iso(_ date: Date) -> String {
        date.formatted(
            Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: TimeZone(secondsFromGMT: 0) ?? .gmt)
        )
    }
}
