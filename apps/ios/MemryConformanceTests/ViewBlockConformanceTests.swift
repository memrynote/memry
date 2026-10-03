import Foundation
import MemryCore
@testable import Memry
import Testing

// Fence text is the bytes desktop's `serializeViewBlockDefinition` writes
// (`packages/shared/src/view-block.ts`), and the row rules are its
// `listTagItems`, folder `LIKE` and `sortNotes`. A fence this build cannot
// answer in full must come back `.code`, never as rows for part of it.

private func note(
    _ id: String, folder: String? = nil, created: Int64? = nil, modified: Int64? = nil
) -> NoteSummary {
    NoteSummary(id: id, title: id, folderPath: folder, emoji: nil, createdAt: created, modifiedAt: modified)
}

private func task(_ id: String, tags: [String], done: Bool = false) -> TaskItem {
    TaskItem(
        id: id, title: id, description: nil, projectId: "inbox", statusId: nil, parentId: nil,
        priority: 0, position: 0, dueDate: nil, dueTime: nil, startDate: nil,
        repeat: nil, isRepeating: false, repeatFrom: nil, sourceNoteId: nil,
        completedAt: done ? "2099-01-01T00:00:00.000Z" : nil, archivedAt: nil, tags: tags,
        linkedNoteIds: [], linkedCanvasIds: [], createdAt: nil, modifiedAt: nil, statusType: nil, isDone: false
    )
}

@Suite("view block conformance")
struct ViewBlockConformanceTests {
    @Test("desktop's fences parse to the query desktop reads")
    func answeredFences() {
        let starterView = "{\n  \"source\": {\n    \"kind\": \"vault\"\n  },\n  \"layout\": \"list\",\n  \"order\": [\n    {\n      \"property\": \"modified\",\n      \"direction\": \"desc\"\n    }\n  ],\n  \"limit\": 10\n}"
        #expect(ViewBlockFence(text: starterView) == .rows(ViewBlockQuery(
            source: .vault, order: [.init(key: .modified, descending: true)], limit: 10
        )))

        let tagTable = "{\n  \"source\": {\n    \"kind\": \"tag\",\n    \"tag\": \"mb-live\"\n  },\n  \"layout\": \"table\"\n}"
        #expect(ViewBlockFence(text: tagTable) == .rows(ViewBlockQuery(source: .tag("mb-live", andTags: []))))

        let folderTitle = "{\n  \"source\": {\n    \"kind\": \"folder\",\n    \"path\": \"projects\"\n  },\n  \"order\": [\n    {\n      \"property\": \"title\",\n      \"direction\": \"asc\"\n    }\n  ]\n}"
        #expect(ViewBlockFence(text: folderTitle) == .rows(ViewBlockQuery(
            source: .folder("projects"), order: [.init(key: .title, descending: false)]
        )))

        let andTags = "{\n  \"source\": {\n    \"kind\": \"tag\",\n    \"tag\": \"work\",\n    \"andTags\": [\n      \"urgent\"\n    ]\n  },\n  \"limit\": 5\n}"
        #expect(ViewBlockFence(text: andTags) == .rows(ViewBlockQuery(
            source: .tag("work", andTags: ["urgent"]), limit: 5
        )))

        #expect(ViewBlockFence(text: #"{"source":{"kind":"vault"}}"#) == .rows(ViewBlockQuery(source: .vault)))
    }

    @Test("a fence this build cannot answer in full stays code", arguments: [
        "",
        #"{"source":"#,
        #"{"source":{"kind":"project","id":"x"}}"#,
        "{\n  \"source\": {\n    \"kind\": \"journal\"\n  },\n  \"layout\": \"chart\",\n  \"chart\": {}\n}",
        #"{"source":{"kind":"folder","path":"books"},"view":"Reading"}"#,
        #"{"source":{"kind":"vault"},"filters":"created after \"2099-01-01\""}"#,
        #"{"source":{"kind":"vault"},"order":[{"property":"wordCount","direction":"desc"}]}"#,
        #"{"source":{"kind":"vault"},"order":[{"property":"modified","direction":"down"}]}"#,
        #"{"source":{"kind":"vault"},"groupBy":"folder"}"#,
        #"{"source":{"kind":"vault"},"layout":"kanban"}"#,
        #"{"source":{"kind":"vault"},"limit":0}"#,
        #"{"source":{"kind":"vault"},"limit":2.5}"#,
        #"{"source":{"kind":"tag","tag":" "}}"#,
        #"{"source":{"kind":"tag","tag":"work","andTags":["urgent",3]}}"#,
        #"{"source":{"kind":"vault","scope":"archived"}}"#,
    ])
    func unansweredFences(_ text: String) {
        #expect(ViewBlockFence(text: text) == .code)
    }

    @Test("a tag lists its family's notes, then its tasks, narrowed by every ANDed tag; a task is done once completed, whatever its status")
    func tagRows() {
        let query = ViewBlockQuery(source: .tag("Work", andTags: ["urgent"]))
        let notes = [note("plan"), note("shop"), note("memo")]
        let noteTags = [
            "plan": ["work/meetings", "urgent"],
            "shop": ["workshop", "urgent"],
            "memo": ["work"],
        ]
        let tasks = [task("call", tags: ["WORK", "urgent/today"], done: true), task("file", tags: ["work"])]

        let rows = query.rows(notes: notes, noteTags: noteTags, tasks: tasks)

        #expect(rows.map(\.id) == ["plan", "call"])
        #expect(rows.map(\.kind) == [.note, .task(done: true)])
    }

    @Test("a folder holds its subfolders' notes, oldest change first when the fence names no order")
    func folderRows() {
        let query = ViewBlockQuery(source: .folder("projects"))
        let notes = [
            note("b", folder: "projects/web", modified: 300),
            note("a", folder: "projects", modified: 100),
            note("c", folder: "projects-old", modified: 50),
            note("d", folder: nil, modified: 10),
        ]

        let rows = query.rows(notes: notes, noteTags: [:], tasks: [task("t", tags: [])])

        #expect(rows.map(\.id) == ["a", "b"])
    }

    @Test("order sorts empties last in either direction, then the limit applies")
    func orderAndLimit() {
        let notes = [
            note("n2", created: nil),
            note("n10", created: 200),
            note("N1", created: 100),
        ]

        let byTitle = ViewBlockQuery(source: .vault, order: [.init(key: .title, descending: false)])
        #expect(byTitle.rows(notes: notes, noteTags: [:], tasks: []).map(\.id) == ["N1", "n2", "n10"])

        let newest = ViewBlockQuery(source: .vault, order: [.init(key: .created, descending: true)], limit: 2)
        #expect(newest.rows(notes: notes, noteTags: [:], tasks: []).map(\.id) == ["n10", "N1"])

        let oldest = ViewBlockQuery(source: .vault, order: [.init(key: .created, descending: false)])
        #expect(oldest.rows(notes: notes, noteTags: [:], tasks: []).map(\.id) == ["N1", "n10", "n2"])
    }
}
