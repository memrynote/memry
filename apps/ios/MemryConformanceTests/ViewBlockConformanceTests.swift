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

    @Test("a note row opens its note by id, so twin and empty titles open the right note; a task row opens no note")
    func noteRowsOpenById() {
        let query = ViewBlockQuery(source: .tag("work", andTags: []))
        let notes = [
            NoteSummary(id: "n-1", title: "Plan", folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil),
            NoteSummary(id: "n-2", title: "Plan", folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil),
            NoteSummary(id: "n-3", title: "", folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil),
        ]
        let noteTags = ["n-1": ["work"], "n-2": ["work"], "n-3": ["work"]]

        let rows = query.rows(notes: notes, noteTags: noteTags, tasks: [task("t-1", tags: ["work"])])

        #expect(rows.map(\.noteRoute) == [NoteRoute(id: "n-1"), NoteRoute(id: "n-2"), NoteRoute(id: "n-3"), nil])
    }

    @Test("a tagged journal day is a row as on desktop: it ranks by its own change time, and opens its day even under an older id")
    func journalRows() {
        let query = ViewBlockQuery(source: .tag("fitness", andTags: []), order: [.init(key: .modified, descending: true)], limit: 2)
        let notes = [note("deload", modified: 2_000), note("weigh-in", modified: 1_000)]
        let days = [NoteSummary(id: "legacy-day", title: "2026-10-04", folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: 3_000)]
        let noteTags = ["deload": ["fitness"], "weigh-in": ["fitness"], "legacy-day": ["daily", "fitness"]]

        let rows = query.rows(notes: notes, noteTags: noteTags, journals: days, tasks: [])

        #expect(rows.map(\.id) == ["legacy-day", "deload"])
        #expect(rows.map(\.kind) == [.journal, .note])
        #expect(rows.first?.noteRoute == NoteRoute(id: "j2026-10-04"))
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

    @Test("a folder source exists when configured or holding a note, and a gone one shows desktop's folderMissing copy")
    func folderMissing() {
        let configured = [FolderSummary(path: "projects", parentPath: nil, name: "projects", icon: nil)]
        let notes = [note("a", folder: "books/fiction")]

        #expect(ViewBlockQuery.folderExists("", configured: [], notes: []))
        #expect(ViewBlockQuery.folderExists("projects", configured: configured, notes: notes))
        #expect(ViewBlockQuery.folderExists("books", configured: configured, notes: notes))
        #expect(!ViewBlockQuery.folderExists("archive", configured: configured, notes: notes))
        #expect(!ViewBlockQuery.folderExists("book", configured: configured, notes: notes))
        #expect(ViewBlockCopy.folderMissing == "This folder is not in the vault any more. Pick another source.")
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

/// Desktop's `/view` starter fence.
private let starterFence = "{\n  \"source\": {\n    \"kind\": \"vault\"\n  },\n  \"layout\": \"list\",\n  \"order\": [\n    {\n      \"property\": \"modified\",\n      \"direction\": \"desc\"\n    }\n  ],\n  \"limit\": 10\n}"

/// The starter, then one change, as desktop patches it.
private func edited(_ change: (inout ViewQueryDraft) -> Void) -> ViewQueryDraft {
    var draft = ViewQueryDraft.starter
    change(&draft)
    return draft
}

/// The query sheet writes what desktop's view builder writes for the same
/// picks: `/view`'s starter, then `updateViewBlockDefinition` with the
/// source menu's or a header control's patch. Literals printed by
/// `serializeViewBlockDefinition` / `updateViewBlockDefinition`.
@Suite("view query sheet conformance")
struct ViewQuerySheetConformanceTests {
    @Test("each pick writes desktop's fence bytes", arguments: [
        (ViewQueryDraft.starter, starterFence),
        (edited { $0.sourceKind = .tag; $0.tag = "mb-live" },
         "{\n  \"source\": {\n    \"kind\": \"tag\",\n    \"tag\": \"mb-live\"\n  },\n  \"layout\": \"list\",\n  \"order\": [\n    {\n      \"property\": \"modified\",\n      \"direction\": \"desc\"\n    }\n  ],\n  \"limit\": 10\n}"),
        (edited { $0.sourceKind = .folder; $0.folder = "projects/web" },
         "{\n  \"source\": {\n    \"kind\": \"folder\",\n    \"path\": \"projects/web\"\n  },\n  \"layout\": \"list\",\n  \"order\": [\n    {\n      \"property\": \"modified\",\n      \"direction\": \"desc\"\n    }\n  ],\n  \"limit\": 10\n}"),
        (edited { $0.sourceKind = .tag; $0.tag = "work"; $0.andTags = ["urgent", "q4"] },
         "{\n  \"source\": {\n    \"kind\": \"tag\",\n    \"tag\": \"work\",\n    \"andTags\": [\n      \"urgent\",\n      \"q4\"\n    ]\n  },\n  \"layout\": \"list\",\n  \"order\": [\n    {\n      \"property\": \"modified\",\n      \"direction\": \"desc\"\n    }\n  ],\n  \"limit\": 10\n}"),
        (edited { $0.layout = .table; $0.sort = .title; $0.descending = false },
         "{\n  \"source\": {\n    \"kind\": \"vault\"\n  },\n  \"layout\": \"table\",\n  \"order\": [\n    {\n      \"property\": \"title\",\n      \"direction\": \"asc\"\n    }\n  ],\n  \"limit\": 10\n}"),
        (edited { $0.layout = .grid; $0.sort = nil; $0.limit = nil },
         "{\n  \"source\": {\n    \"kind\": \"vault\"\n  },\n  \"layout\": \"grid\"\n}"),
        (edited { $0.sourceKind = .tag; $0.tag = "a\"b\\c/d é\u{01}" },
         "{\n  \"source\": {\n    \"kind\": \"tag\",\n    \"tag\": \"a\\\"b\\\\c/d é\\u0001\"\n  },\n  \"layout\": \"list\",\n  \"order\": [\n    {\n      \"property\": \"modified\",\n      \"direction\": \"desc\"\n    }\n  ],\n  \"limit\": 10\n}"),
    ])
    func picks(_ draft: ViewQueryDraft, _ fence: String) {
        #expect(draft.fenceText == fence)
        #expect(ViewBlockFence(text: fence) != .code, "a view made on this device draws as rows here")
    }

    @Test("an edit keeps the fence's own key order and appends new keys, as desktop's update does")
    func editKeepsKeyOrder() throws {
        let limitOnly = "{\n  \"source\": {\n    \"kind\": \"vault\"\n  },\n  \"limit\": 5\n}"
        var draft = try #require(ViewQueryDraft(fence: limitOnly))
        #expect(draft.fenceText == limitOnly, "an untouched edit writes the same bytes")
        draft.layout = .grid
        #expect(draft.fenceText == "{\n  \"source\": {\n    \"kind\": \"vault\"\n  },\n  \"limit\": 5,\n  \"layout\": \"grid\"\n}")
    }

    @Test("a fence drawn as code opens no sheet, so no key of it is dropped")
    func codeFenceIsNotEditable() {
        #expect(ViewQueryDraft(fence: #"{"source":{"kind":"vault"},"filters":"title contains \"a\""}"#) == nil)
    }

    @Test("a folder or tag source without a pick writes nothing")
    func incompleteSource() {
        #expect(edited { $0.sourceKind = .folder }.fenceText == nil)
        #expect(edited { $0.sourceKind = .tag; $0.tag = " " }.fenceText == nil)
    }
}
