import Foundation
import MemryCore
import Synchronization

@testable import Memry

// A real vault for task tests (spec 004 Phase 3+). The task rules are the
// core's and pinned by vectors; a Swift test that faked them would test the
// fake. So every task screen test runs against a scratch `Vault` on disk and
// the real `Tasks` surface, with an in-memory keychain holding a signing key.

/// An in-memory keychain with a device signing key already in it.
final class TaskTestKeychain: SecureStore, @unchecked Sendable {
    private let entries = Mutex<[SecureStoreKey: Data]>([:])

    init() {
        var key = Data(count: 64)
        for index in 0 ..< 64 { key[index] = UInt8(truncatingIfNeeded: index &* 37 &+ 11) }
        entries.withLock { $0[.deviceSigningKey] = key }
    }

    func get(key: SecureStoreKey) throws -> Data? { entries.withLock { $0[key] } }
    func set(key: SecureStoreKey, value: Data) throws { entries.withLock { $0[key] = value } }
    func delete(key: SecureStoreKey) throws { entries.withLock { $0[key] = nil } }
    func clear() throws { entries.withLock { $0 = [:] } }
}

/// A scratch vault, its task surface and a store over it.
@MainActor
struct TasksTestVault {
    let vault: Vault
    let tasks: Tasks
    let store: TasksStore

    /// Wednesday 2026-01-14 12:00 local, the vectors' reference day.
    nonisolated static let referenceNow: Date = {
        var components = DateComponents()
        components.year = 2026
        components.month = 1
        components.day = 14
        components.hour = 12
        return Calendar(identifier: .gregorian).date(from: components) ?? Date()
    }()

    init(filler: (any VaultFilling)? = nil) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("memry-tasks-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        vault = try Vault.open(vaultId: "vault-test", directory: directory.path)
        tasks = try vault.tasks(store: TaskTestKeychain())
        let defaults = UserDefaults(suiteName: "tasks-test-\(UUID().uuidString)") ?? .standard
        store = TasksStore(core: tasks, filler: filler, vaultId: "vault-test", defaults: defaults)
        store.clock = { TasksTestVault.referenceNow }
    }

    /// A project with desktop's default statuses; returns its id.
    func project(_ name: String = "Agent Test Project") throws -> String {
        try tasks.createProject(
            draft: ProjectDraft(name: name, description: nil, color: nil, icon: nil, statuses: nil)
        )
    }

    /// A task with the given fields; returns its id.
    func task(
        _ title: String,
        project: String,
        due: String? = nil,
        parent: String? = nil,
        priority: Int64 = 0
    ) throws -> String {
        let change = try tasks.create(input: NewTaskInput(
            title: title,
            projectId: project,
            statusId: nil,
            parentId: parent,
            priority: priority,
            description: nil,
            dueDate: due,
            dueTime: nil,
            startDate: nil,
            repeat: nil,
            repeatFrom: nil,
            tags: [],
            linkedNoteIds: [],
            linkedCanvasIds: [],
            sourceNoteId: nil,
            position: nil
        ))
        return change.created.first ?? ""
    }
}
