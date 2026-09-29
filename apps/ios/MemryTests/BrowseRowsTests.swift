import Foundation
import MemryCore
import Testing

@testable import Memry

// The browse list is a pure function over a snapshot, so it is asserted over
// real `VaultOutline` values rather than through a rendered view.
//
// What these hold: a closed folder shows nothing of its contents, an open one
// shows children before its own notes, search is flat and diacritic-blind, and
// no note is ever dropped — the failure that once told an account holding four
// vaults it had none is the same failure a filtered tree makes with notes.

@Suite("Browse rows")
struct BrowseRowsTests {
    private static func folder(_ path: String, parent: String? = nil) -> FolderSummary {
        FolderSummary(path: path, parentPath: parent, name: path.split(separator: "/").last.map(String.init) ?? path, icon: nil)
    }

    private static func note(
        _ id: String,
        _ title: String,
        folder: String? = nil,
        modified: Int64? = nil
    ) -> NoteSummary {
        NoteSummary(
            id: id,
            title: title,
            folderPath: folder,
            emoji: nil,
            createdAt: nil,
            modifiedAt: modified
        )
    }

    private static var outline: VaultOutline {
        .build(
            folders: [folder("Work"), folder("Work/Interviews", parent: "Work")],
            notes: [
                note("n1", "Quarterly review", folder: "Work", modified: 200),
                note("n2", "Aurelie", folder: "Work/Interviews"),
                note("n3", "Quick capture", modified: 100),
                note("n4", "Törbel field data", folder: "Ghost")
            ]
        )
    }

    @Test("A closed folder contributes one row and no contents")
    func closedFolderHidesItsNotes() {
        let rows = Self.outline.browseRows(expanded: [], sort: .nameAscending)
        // `Ghost` has no config row and is derived from its note's path.
        #expect(rows.map(\.id) == ["folder:Ghost", "folder:Work", "note:n3"])
        guard case let .folder(_, _, noteCount, hasContents, isExpanded) = rows[1].kind else {
            Issue.record("first row is not a folder")
            return
        }
        #expect(noteCount == 1)
        #expect(hasContents)
        #expect(isExpanded == false)
    }

    @Test("Name Z to A reverses folders and notes; time modes keep folders A to Z")
    func nameDescendingReversesFolders() {
        let descending = Self.outline.browseRows(expanded: [], sort: .nameDescending)
        #expect(descending.map(\.id) == ["folder:Work", "folder:Ghost", "note:n3"])
        let byTime = Self.outline.browseRows(expanded: [], sort: .modifiedOldest)
        #expect(byTime.map(\.id) == ["folder:Ghost", "folder:Work", "note:n3"])
    }

    @Test("Oldest first still puts a note with no instant last")
    func missingInstantSortsLastOldestFirst() {
        let outline = VaultOutline.build(
            folders: [],
            notes: [Self.note("a", "A"), Self.note("b", "B", modified: 200), Self.note("c", "C", modified: 100)]
        )
        #expect(outline.browseRows(expanded: [], sort: .modifiedOldest).map(\.id) == ["note:c", "note:b", "note:a"])
        #expect(outline.browseRows(expanded: [], sort: .modifiedNewest).map(\.id) == ["note:b", "note:c", "note:a"])
    }

    @Test("An open folder shows child folders before its own notes")
    func openFolderOrdersChildrenFirst() {
        let rows = Self.outline.browseRows(expanded: ["Work"], sort: .nameAscending)
        #expect(
            rows.map(\.id)
                == ["folder:Ghost", "folder:Work", "folder:Work/Interviews", "note:n1", "note:n3"]
        )
        // The child sits one level in; indentation is the only thing carrying
        // the hierarchy in a flat list.
        #expect(rows[2].depth == 1)
        #expect(rows[3].depth == 1)
    }

    @Test("A note whose folder has no record sits in a folder derived from its path")
    func unplacedNotesAreKept() {
        let outline = Self.outline
        let rows = outline.browseRows(expanded: ["Ghost"], sort: .nameAscending)
        #expect(rows.prefix(2).map(\.id) == ["folder:Ghost", "note:n4"])
        #expect(outline.unplacedRows(sort: .nameAscending).isEmpty)
        #expect(outline.allNotes.count == outline.noteCount)
    }

    @Test("Search is flat, case-insensitive and diacritic-insensitive")
    func searchIgnoresCaseAndDiacritics() {
        let rows = Self.outline.searchRows(query: "torbel", sort: .nameAscending)
        #expect(rows.map(\.id) == ["note:n4"])
        #expect(rows[0].depth == 0)
    }

    @Test("An empty query matches nothing rather than everything")
    func blankQueryReturnsNoRows() {
        #expect(Self.outline.searchRows(query: "   ", sort: .nameAscending).isEmpty)
    }

    @Test("Sorting by last edited puts a note with no instant last")
    func missingInstantSortsLast() {
        let sorted = Self.outline.browseRows(expanded: ["Work", "Work/Interviews"], sort: .modifiedNewest)
        let notes = sorted.compactMap { row -> String? in
            guard case let .note(note) = row.kind else { return nil }
            return note.id
        }
        // n1 (200) before n3 (100); n2 carries no instant and goes after the
        // notes it is listed with rather than being read as 1970.
        #expect(notes == ["n2", "n1", "n3"])
    }

    @Test("An untitled note says so instead of rendering blank")
    func untitledNoteIsNamed() {
        let row = BrowseRow.note(Self.note("n9", ""))
        #expect(row.title == "Untitled note")
        #expect(row.isPlaceholderTitle)
    }
}
