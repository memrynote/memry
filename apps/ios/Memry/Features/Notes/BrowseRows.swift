import Foundation
import MemryCore

// What the browse screen actually renders: one flat array of rows, derived
// from `VaultOutline` plus what the user has opened, sorted and filtered.
//
// **Flat, not recursive.** A SwiftUI view whose `body` contains itself does
// not compile, and the alternatives cost either laziness or the indentation
// that carries the hierarchy. `FolderTree.swift` already flattens folders for
// the same reason; this flattens folders *and* their notes into the one list
// the screen scrolls, so `List` recycles the rows of a vault holding
// thousands.
//
// **A pure function over a snapshot.** Nothing here reaches the core: the
// outline came from two FFI crossings at load, and expanding a folder must
// never cost a third. It is also what makes this testable without a database.
//
// **Search replaces the tree rather than pruning it.** A filtered tree either
// hides a match whose parent does not match, or keeps parents that match
// nothing — both lie about where the notes are. While there is a query, the
// screen is a flat list of matching notes, which is what every native list
// does under a search field.

/// One line of the browse list.
struct BrowseRow: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// A configured folder. `noteCount` is its own notes, never a subtree
        /// total — a count that silently included descendants would not match
        /// the rows it sits beside.
        case folder(path: String, noteCount: Int, isExpanded: Bool)
        case note(NoteSummary)
    }

    let kind: Kind
    let title: String
    /// Rendered as a placeholder rather than as the empty string: an untitled
    /// note and a blank folder name are facts, and the id is not a title.
    let isPlaceholderTitle: Bool
    /// 0 at the vault root. Indentation and the VoiceOver level both read it.
    let depth: Int

    var id: String {
        switch kind {
        case let .folder(path, _, _): "folder:\(path)"
        case let .note(note): "note:\(note.id)"
        }
    }
}

/// How the list is ordered. The three keys desktop offers, and no more.
enum BrowseSort: String, CaseIterable, Identifiable, Sendable {
    case title
    case modified
    case created

    var id: String { rawValue }

    var label: String {
        switch self {
        case .title: "Title"
        case .modified: "Last edited"
        case .created: "Date created"
        }
    }

    /// Folders always sort by name: neither instant exists for a folder, and
    /// inventing one would put them in an order nobody can predict.
    fileprivate func sorted(_ notes: [NoteSummary]) -> [NoteSummary] {
        switch self {
        case .title:
            notes.sorted { lhs, rhs in
                lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
            }
        case .modified:
            // Newest first, and a note with no instant goes last rather than
            // being treated as 1970 (data-model §A.6).
            notes.sorted { first, second in
                (first.modifiedAt ?? .min) > (second.modifiedAt ?? .min)
            }
        case .created:
            notes.sorted { first, second in
                (first.createdAt ?? .min) > (second.createdAt ?? .min)
            }
        }
    }
}

extension VaultOutline {
    /// The tree the screen draws, with `expanded` folders opened.
    func browseRows(expanded: Set<String>, sort: BrowseSort) -> [BrowseRow] {
        Self.rows(of: roots, depth: 0, expanded: expanded, sort: sort)
            + sort.sorted(rootNotes).map { BrowseRow.note($0, depth: 0) }
    }

    /// The notes whose folder carries no `folder_config` row (spec-defect
    /// 124). Their own section, because the tree above cannot contain them and
    /// dropping them would hide real notes.
    func unplacedRows(sort: BrowseSort) -> [BrowseRow] {
        sort.sorted(unplacedNotes).map { BrowseRow.note($0, depth: 0) }
    }

    /// Every note in the vault whose title matches, flat.
    ///
    /// Diacritic- and case-insensitive, because a user searching "torbel"
    /// means "Törbel". Folders are not searched: this screen opens notes, and
    /// a folder hit that expanded to nothing would be a dead row.
    func searchRows(query: String, sort: BrowseSort) -> [BrowseRow] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        let matches = allNotes.filter { note in
            note.title.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
        return sort.sorted(matches).map { BrowseRow.note($0, depth: 0) }
    }

    /// Every note, however it was placed. The counts on screen must add up to
    /// `noteCount`, which is what this is checked against.
    var allNotes: [NoteSummary] {
        Self.notes(of: roots) + rootNotes + unplacedNotes
    }

    private static func notes(of nodes: [FolderNode]) -> [NoteSummary] {
        nodes.flatMap { $0.notes + notes(of: $0.children) }
    }

    private static func rows(
        of nodes: [FolderNode],
        depth: Int,
        expanded: Set<String>,
        sort: BrowseSort
    ) -> [BrowseRow] {
        nodes.flatMap { node -> [BrowseRow] in
            let isExpanded = expanded.contains(node.folder.path)
            let row = BrowseRow(
                kind: .folder(
                    path: node.folder.path,
                    noteCount: node.notes.count,
                    isExpanded: isExpanded
                ),
                title: node.title,
                isPlaceholderTitle: node.isPlaceholderTitle,
                depth: depth
            )
            guard isExpanded else { return [row] }
            // Child folders before notes, the order the tree reads in.
            return [row]
                + rows(of: node.children, depth: depth + 1, expanded: expanded, sort: sort)
                + sort.sorted(node.notes).map { BrowseRow.note($0, depth: depth + 1) }
        }
    }
}

extension BrowseRow {
    /// One note as a row. `depth` is 0 wherever the note is not inside the
    /// tree — a folder screen, a search hit — because indentation there would
    /// claim a hierarchy the screen is not showing.
    static func note(_ note: NoteSummary, depth: Int = 0) -> BrowseRow {
        BrowseRow(
            kind: .note(note),
            title: note.title.isEmpty ? "Untitled note" : note.title,
            isPlaceholderTitle: note.title.isEmpty,
            depth: depth
        )
    }
}
