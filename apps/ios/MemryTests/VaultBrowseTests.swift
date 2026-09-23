import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T156. The browse hierarchy, and the two rules with teeth.
//
// **An empty vault, an empty folder and a failed read are three screens.** The
// reader behind `GET /sync/vaults` once `filter_map`-ed a row away and told an
// account holding four vaults it had none; a note list that renders a failed
// read as "no notes yet" is the same bug with a different noun. Each of the
// three is asserted on its own, in both directions.
//
// **Kaan's spec-defect 124 decision, and the thing it must not become.** The
// tree shows only configured folders — a folder with no `folder_config` row is
// absent. The notes in it are not: they stay visible, and this file asserts
// both halves of that in one test so an implementation that hid them fails.

/// A scripted reader. It answers what a test wrote down and counts its calls,
/// so "one crossing per load" is an assertion rather than a comment.
private final class ScriptedNotes: NotesReading, @unchecked Sendable {
    private let folderAnswer: Result<[FolderSummary], any Error>
    private let noteAnswer: Result<[NoteSummary], any Error>
    private let calls = Mutex<[String]>([])

    init(
        folders: Result<[FolderSummary], any Error> = .success([]),
        notes: Result<[NoteSummary], any Error> = .success([])
    ) {
        folderAnswer = folders
        noteAnswer = notes
    }

    var callLog: [String] { calls.withLock { $0 } }

    func folders() async throws -> [FolderSummary] {
        calls.withLock { $0.append("folders") }
        return try folderAnswer.get()
    }

    func list() async throws -> [NoteSummary] {
        calls.withLock { $0.append("list") }
        return try noteAnswer.get()
    }

    /// T157 widened `NotesReading`. **This fake records the call and throws**
    /// rather than answering benignly (`contracts/core-api.md`, the fake
    /// rule): nothing in this suite reads a note, so a browse screen that
    /// started reading one must be visible here rather than silently
    /// satisfied. A fake that behaves correctly is how this project shipped
    /// five bugs behind a green suite in Phase 3.
    func read(id _: String) async throws -> NoteDetail? {
        calls.withLock { $0.append("read") }
        throw NotScripted()
    }
}

private struct NotScripted: Error {}

private struct VaultUnreadable: Error {}

private func folder(_ path: String, parent: String? = nil, name: String? = nil) -> FolderSummary {
    FolderSummary(
        path: path,
        parentPath: parent,
        name: name ?? String(path.split(separator: "/").last ?? ""),
        icon: nil
    )
}

private func note(_ id: String, in folderPath: String? = nil, title: String? = nil) -> NoteSummary {
    NoteSummary(
        id: id,
        title: title ?? "Note \(id)",
        folderPath: folderPath,
        emoji: nil,
        createdAt: nil,
        modifiedAt: nil
    )
}

@MainActor
@Suite("T156 vault browse")
struct VaultBrowseTests {
    @Test("a vault that holds nothing is empty, and is never reported as a failure")
    func anEmptyVaultIsEmpty() async {
        let model = VaultBrowseViewModel(reader: ScriptedNotes())
        await model.loadIfNeeded()
        #expect(model.phase == .empty)
        #expect(model.outline == nil)
    }

    @Test("a folder read that fails is unreadable, never an empty vault")
    func aFailedFolderReadIsNeverAnEmptyVault() async {
        let model = VaultBrowseViewModel(
            reader: ScriptedNotes(folders: .failure(VaultUnreadable()), notes: .success([note("a")]))
        )
        await model.loadIfNeeded()
        #expect(model.phase != .empty)
        guard case .unreadable = model.phase else {
            Issue.record("a failed folder read must render as a failure")
            return
        }
    }

    @Test("a note read that fails is unreadable, never an empty vault")
    func aFailedNoteReadIsNeverAnEmptyVault() async {
        let model = VaultBrowseViewModel(
            reader: ScriptedNotes(folders: .success([folder("Projects")]), notes: .failure(VaultUnreadable()))
        )
        await model.loadIfNeeded()
        #expect(model.phase != .empty)
        guard case .unreadable = model.phase else {
            Issue.record("a failed note read must render as a failure")
            return
        }
    }

    @Test("a failed read stays retryable, so the retry button is a real attempt")
    func aFailedReadIsRetried() async {
        let reader = ScriptedNotes(folders: .failure(VaultUnreadable()))
        let model = VaultBrowseViewModel(reader: reader)
        await model.loadIfNeeded()
        await model.loadIfNeeded()
        #expect(reader.callLog == ["folders", "folders"])
    }

    @Test("a folder with notes and no config row appears in the tree, holding them")
    func unconfiguredFolderNotesStayVisible() async {
        // `Projects` is configured. `Archive` holds a note and has no
        // `folder_config` row, which chapter 13 §13.7.10 allows.
        let reader = ScriptedNotes(
            folders: .success([folder("Projects")]),
            notes: .success([note("a", in: "Projects"), note("b", in: "Archive")])
        )
        let model = VaultBrowseViewModel(reader: reader)
        await model.loadIfNeeded()
        guard let outline = model.outline else {
            Issue.record("the outline should have loaded")
            return
        }
        // Derived from the note's own path, as desktop derives its tree from
        // the directories on disk.
        #expect(Set(outline.folderRows.map(\.path)) == ["Projects", "Archive"])
        #expect(outline.node(at: "Archive")?.notes.map(\.id) == ["b"])
        #expect(outline.unplacedNotes.isEmpty)
        #expect(outline.noteCount == 2)
    }

    @Test("every note reaches exactly one place in the hierarchy")
    func everyNoteIsPlacedExactlyOnce() async {
        let notes = [
            note("root"), note("configured", in: "Projects"), note("stranded", in: "Archive")
        ]
        let reader = ScriptedNotes(folders: .success([folder("Projects")]), notes: .success(notes))
        let model = VaultBrowseViewModel(reader: reader)
        await model.loadIfNeeded()
        guard let outline = model.outline else {
            Issue.record("the outline should have loaded")
            return
        }
        let inFolders = outline.roots.flatMap(\.notes).map(\.id)
        let placed = outline.rootNotes.map(\.id) + outline.unplacedNotes.map(\.id) + inFolders
        #expect(Set(placed) == Set(notes.map(\.id)))
        #expect(placed.count == outline.noteCount)
    }

    @Test("a configured folder with no notes is a folder, not an empty vault")
    func anEmptyFolderIsNotAnEmptyVault() async {
        let reader = ScriptedNotes(folders: .success([folder("Projects")]))
        let model = VaultBrowseViewModel(reader: reader)
        await model.loadIfNeeded()
        #expect(model.phase != .empty)
        guard let outline = model.outline else {
            Issue.record("a configured folder should have loaded")
            return
        }
        #expect(outline.folderRows.map(\.noteCount) == [0])
        #expect(outline.node(at: "Projects")?.notes.isEmpty == true)
        #expect(outline.node(at: "Projects")?.children.isEmpty == true)
    }

    @Test("a folder whose parent carries no config row still appears")
    func anOrphanedFolderIsStillShown() {
        // `Archive` has no row, so `Archive/2024` cannot hang off it. Dropping
        // it would hide a folder someone did configure.
        let outline = VaultOutline.build(
            folders: [folder("Archive/2024", parent: "Archive")],
            notes: []
        )
        #expect(outline.folderRows.map(\.path) == ["Archive/2024"])
        #expect(outline.folderRows.map(\.depth) == [0])
    }

    @Test("a parent cycle leaves every configured folder visible exactly once")
    func aCycleStillShowsEveryFolder() {
        let outline = VaultOutline.build(
            folders: [folder("a", parent: "b"), folder("b", parent: "a")],
            notes: []
        )
        #expect(outline.folderRows.map(\.path).sorted() == ["a", "b"])
        #expect(outline.folderRows.count == 2)
    }

    @Test("the tree is parent before child, with a depth per level")
    func theTreeIsParentBeforeChild() {
        let outline = VaultOutline.build(
            folders: [
                folder("Projects"),
                folder("Projects/2024", parent: "Projects"),
                folder("Projects/2024/Q1", parent: "Projects/2024"),
                folder("Reading")
            ],
            notes: [note("a", in: "Projects/2024")]
        )
        #expect(outline.folderRows.map(\.path) == [
            "Projects", "Projects/2024", "Projects/2024/Q1", "Reading"
        ])
        #expect(outline.folderRows.map(\.depth) == [0, 1, 2, 0])
        // The count labels the folder it sits on, never the subtree.
        #expect(outline.folderRows.map(\.noteCount) == [0, 1, 0, 0])
    }

    @Test("a blank folder name renders as a placeholder rather than a blank row")
    func aBlankFolderNameIsNamed() {
        let outline = VaultOutline.build(folders: [folder("Projects", name: "")], notes: [])
        #expect(outline.folderRows.first?.isPlaceholderTitle == true)
        #expect(outline.folderRows.first?.title.isEmpty == false)
        // And a folder that has a name keeps it.
        let named = VaultOutline.build(folders: [folder("Projects", name: "Projects")], notes: [])
        #expect(named.folderRows.first?.isPlaceholderTitle == false)
        #expect(named.folderRows.first?.title == "Projects")
    }

    @Test("both snapshots are read once per load, never once per row")
    func bothSnapshotsAreReadOnce() async {
        let notes = (0..<50).map { note("n\($0)", in: "Projects") }
        let reader = ScriptedNotes(folders: .success([folder("Projects")]), notes: .success(notes))
        let model = VaultBrowseViewModel(reader: reader)
        await model.loadIfNeeded()
        await model.loadIfNeeded()
        _ = model.outline?.folderRows
        #expect(reader.callLog == ["folders", "list"])
    }

    @Test("a note at the vault root is not confused with a note in an unconfigured folder")
    func rootNotesAndStrandedNotesAreDifferent() {
        let outline = VaultOutline.build(
            folders: [],
            notes: [note("root"), note("stranded", in: "Archive")]
        )
        #expect(outline.rootNotes.map(\.id) == ["root"])
        #expect(outline.node(at: "Archive")?.notes.map(\.id) == ["stranded"])
        #expect(outline.isEmpty == false)
    }

    @Test("a nested unconfigured folder brings its ancestors, and a configured one keeps its name")
    func nestedFoldersAreDerivedWithTheirAncestors() {
        let outline = VaultOutline.build(
            folders: [FolderSummary(path: "books", parentPath: nil, name: "Reading", icon: "📚")],
            notes: [note("deep", in: "books/2026/fiction")]
        )
        #expect(outline.folderRows.map(\.path) == ["books", "books/2026", "books/2026/fiction"])
        #expect(outline.folderRows.map(\.depth) == [0, 1, 2])
        #expect(outline.roots.first?.title == "Reading")
        #expect(outline.node(at: "books/2026/fiction")?.notes.map(\.id) == ["deep"])
    }
}
