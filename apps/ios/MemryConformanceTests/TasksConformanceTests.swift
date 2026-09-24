import Foundation
import MemryCore
import Testing

// Spec 004 TP080: `task-parsing.json` and `task-filtering.json` through the
// FFI. The expectations are the committed values the desktop TypeScript
// produced; the actual values come out of `MemryCore`. Nothing here computes
// an expectation.
//
// Reached three ways, all production code paths:
// - the parser free functions (`parseTaskDate`, `predictTaskDate`,
//   `predictTaskTime`, `isTaskTimeInProgress`, `predictTaskRepeat`,
//   `repeatPreview`, `nextRepeatDate`);
// - `Tasks.parseQuickAdd` over a scratch vault holding the vector's projects;
// - the task conformance seam (`taskDueWindowsConformance`,
//   `taskFilteringConformance`) for fixtures no FFI write can mint.

private final class TaskVectorsMarker {}

private enum TaskVectors {
    nonisolated(unsafe) static let parsing = load("task-parsing")
    nonisolated(unsafe) static let filtering = load("task-filtering")

    static func load(_ name: String) -> [String: Any] {
        guard
            let url = Bundle(for: TaskVectorsMarker.self)
                .url(forResource: name, withExtension: "json", subdirectory: "test-vectors"),
            let data = try? Data(contentsOf: url),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            fatalError("\(name).json is not in the test bundle")
        }
        return object
    }

    static func raw(_ name: String) -> String {
        guard
            let url = Bundle(for: TaskVectorsMarker.self)
                .url(forResource: name, withExtension: "json", subdirectory: "test-vectors"),
            let text = try? String(contentsOf: url, encoding: .utf8)
        else {
            fatalError("\(name).json is not in the test bundle")
        }
        return text
    }
}

private func cases(_ object: Any?) -> [[String: Any]] {
    object as? [[String: Any]] ?? []
}

/// JSON equality through `NSObject` comparison of re-serialised values.
private func same(_ lhs: Any?, _ rhs: Any?) -> Bool {
    let normalise: (Any?) -> NSObject = { value in
        guard let value, !(value is NSNull) else { return NSNull() }
        return value as? NSObject ?? NSNull()
    }
    return normalise(lhs).isEqual(normalise(rhs))
}

private func rule(_ json: [String: Any]) -> RepeatRule {
    RepeatRule(
        frequency: json["frequency"] as? String ?? "",
        interval: (json["interval"] as? NSNumber)?.int64Value ?? 1,
        daysOfWeek: (json["daysOfWeek"] as? [NSNumber])?.map(\.int64Value),
        monthlyType: json["monthlyType"] as? String,
        dayOfMonth: (json["dayOfMonth"] as? NSNumber)?.int64Value,
        weekOfMonth: (json["weekOfMonth"] as? NSNumber)?.int64Value,
        dayOfWeekForMonth: (json["dayOfWeekForMonth"] as? NSNumber)?.int64Value,
        endType: json["endType"] as? String ?? "never",
        endDate: json["endDate"] as? String,
        endCount: (json["endCount"] as? NSNumber)?.int64Value,
        completedCount: (json["completedCount"] as? NSNumber)?.int64Value ?? 0,
        createdAt: json["createdAt"] as? String
    )
}

@Suite("task-parsing.json — spec 004 D1, D3, D4")
struct TaskParsingConformanceTests {
    @Test func natural_dates() {
        let all = cases(TaskVectors.parsing["naturalDate"])
        var failures: [String] = []
        for testCase in all {
            let input = testCase["input"] as? String ?? ""
            let now = testCase["now"] as? String ?? ""
            let expected = testCase["expected"] as? [String: Any] ?? [:]
            let actual = parseTaskDate(input: input, now: now)
            if expected["success"] as? Bool == true {
                let ok = actual?.date == expected["date"] as? String
                    && actual?.time == expected["time"] as? String
                    && actual?.displayText == expected["displayText"] as? String
                if !ok { failures.append("\(input) @\(now): \(String(describing: actual))") }
            } else if actual != nil {
                failures.append("\(input) @\(now): expected no date, got \(String(describing: actual))")
            }
        }
        #expect(all.count > 600)
        #expect(failures.isEmpty, "\(failures.count) cases: \(failures.prefix(10))")
    }

    @Test func ghost_completion() {
        let completion = TaskVectors.parsing["completion"] as? [String: Any] ?? [:]
        var failures: [String] = []
        for testCase in cases(completion["date"]) {
            let query = testCase["query"] as? String ?? ""
            let now = testCase["now"] as? String ?? ""
            if predictTaskDate(query: query, now: now) != testCase["predictDateCompletion"] as? String
                || predictTaskTime(query: query, now: now) != testCase["predictTime"] as? String
                || isTaskTimeInProgress(query: query, now: now) != (testCase["isTimeInProgress"] as? Bool ?? false) {
                failures.append("date \(query) @\(now)")
            }
        }
        for testCase in cases(completion["repeat"]) {
            let query = testCase["query"] as? String ?? ""
            if predictTaskRepeat(query: query) != testCase["expected"] as? String {
                failures.append("repeat \(query)")
            }
        }
        #expect(failures.isEmpty, "\(failures)")
    }

    @Test func recurrence_next_and_preview() {
        let recurrence = TaskVectors.parsing["recurrence"] as? [String: Any] ?? [:]
        let configs = recurrence["configs"] as? [String: [String: Any]] ?? [:]
        var failures: [String] = []
        for testCase in cases(recurrence["next"]) {
            guard let name = testCase["config"] as? String, let config = configs[name] else { continue }
            let from = testCase["from"] as? String ?? ""
            let actual = nextRepeatDate(rule: rule(config), from: from)
            if actual != testCase["expected"] as? String { failures.append("next \(name) from \(from): \(actual ?? "nil")") }
        }
        for testCase in cases(recurrence["occurrences"]) {
            guard let name = testCase["config"] as? String, let config = configs[name] else { continue }
            let count = (testCase["count"] as? NSNumber)?.uint32Value ?? 0
            let actual = repeatPreview(rule: rule(config), start: testCase["start"] as? String ?? "", count: count)
            if actual != (testCase["expected"] as? [String] ?? []) { failures.append("occurrences \(name): \(actual)") }
        }
        #expect(failures.isEmpty, "\(failures)")
    }

    @Test func due_windows_views_and_counts() throws {
        let section = TaskVectors.parsing["dueWindows"] as? [String: Any] ?? [:]
        let data = try JSONSerialization.data(withJSONObject: section)
        let actualText = taskDueWindowsConformance(sectionJson: String(decoding: data, as: UTF8.self))
        let actual = try JSONSerialization.jsonObject(with: Data(actualText.utf8))
        #expect(same(actual, section["at"]))
    }

    @MainActor
    @Test func quick_add_over_a_vault_holding_the_vectors_projects() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tp080-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let vault = try Vault.open(vaultId: "conformance", directory: directory.path)
        let tasks = try vault.tasks(store: ConformanceKeychain())
        var idsByVectorId: [String: String] = [:]
        for project in cases(TaskVectors.parsing["quickAddProjects"]) {
            let name = project["name"] as? String ?? ""
            let id = try tasks.createProject(
                draft: ProjectDraft(name: name, description: nil, color: nil, icon: nil, statuses: nil)
            )
            if project["isArchived"] as? Bool == true {
                try tasks.setProjectArchived(id: id, archived: true)
            }
            idsByVectorId[project["id"] as? String ?? ""] = id
        }
        var failures: [String] = []
        for testCase in cases(TaskVectors.parsing["quickAdd"]) {
            let input = testCase["input"] as? String ?? ""
            // `+<id>` resolves a project by its id, and a vault here can only
            // hold core-minted ids. That branch is asserted by the Rust harness
            // over the same function (`task_parse_vectors.rs`); every
            // name-based case runs here.
            if idsByVectorId.keys.contains(where: { $0.hasPrefix("p-") && input.contains("+\($0)") }) {
                continue
            }
            let expected = testCase["expected"] as? [String: Any] ?? [:]
            let parsed = try tasks.parseQuickAdd(input: input, now: testCase["now"] as? String ?? "")
            let expectedProject = (expected["projectId"] as? String).flatMap { idsByVectorId[$0] }
            let spans = parsed.spans.map { ["start": Int($0.start), "end": Int($0.end), "kind": $0.kind] as [String: Any] }
            let ok = parsed.title == expected["title"] as? String
                && parsed.dueDate == expected["dueDate"] as? String
                && parsed.dueTime == expected["dueTime"] as? String
                && parsed.projectId == expectedProject
                && parsed.tags == (expected["tags"] as? [String] ?? [])
                && parsed.noteTitles == (expected["noteTitles"] as? [String] ?? [])
                && (parsed.repeat == nil) == (expected["repeat"] is NSNull || expected["repeat"] == nil)
                && same(spans, expected["spans"])
            if !ok { failures.append(input) }
        }
        #expect(failures.isEmpty, "\(failures)")
    }
}

@Suite("task-filtering.json — spec 004 TP015")
struct TaskFilteringConformanceTests {
    @Test func every_section_through_the_seam() throws {
        let file = TaskVectors.filtering
        let actualText = taskFilteringConformance(fileJson: TaskVectors.raw("task-filtering"))
        let actual = try JSONSerialization.jsonObject(with: Data(actualText.utf8)) as? [String: Any] ?? [:]

        let dimensions = file["dimensions"] as? [String: Any] ?? [:]
        let computed = actual["dimensions"] as? [String: Any] ?? [:]
        for (name, value) in dimensions {
            let expected = cases(value).map { $0["expected"] as Any }
            #expect(same(computed[name], expected), "dimension \(name)")
        }
        for section in ["sorts", "groups", "applied"] {
            let expected = cases(file[section]).map { $0["expected"] as Any }
            #expect(same(actual[section], expected), "\(section)")
        }
    }
}

/// A keychain holding only a device signing key, for the scratch vault.
private final class ConformanceKeychain: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [SecureStoreKey: Data] = [.deviceSigningKey: Data((0 ..< 64).map { UInt8($0) })]

    func get(key: SecureStoreKey) throws -> Data? { lock.withLock { entries[key] } }
    func set(key: SecureStoreKey, value: Data) throws { lock.withLock { entries[key] = value } }
    func delete(key: SecureStoreKey) throws { _ = lock.withLock { entries.removeValue(forKey: key) } }
    func clear() throws { lock.withLock { entries.removeAll() } }
}
