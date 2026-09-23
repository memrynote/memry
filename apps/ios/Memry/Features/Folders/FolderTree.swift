import Foundation
import MemryCore

// T156, the value half. One vault's browse hierarchy, built from two core
// snapshots and nothing else.
//
// **The tree shows every folder a note lives in**, configured or not. This
// replaces spec-defect 124's "configured folders only" (Kaan, reversed after
// seeing a vault whose `books/`, `projects/` and `travel/` all landed in one
// "outside the folder list" heap). `Notes.folders()` is the `folder_config`
// projection, and a folder can hold notes and carry no config record (chapter
// 13 §13.7.10) — which on a vault that grew on desktop is most of them. Such a
// folder, and every ancestor of it, is derived from the notes' own
// `folderPath`, exactly as desktop's tree is derived from the directories on
// disk. A configured folder keeps its own name and icon.
//
// ``VaultOutline/unplacedNotes`` stays, and stays empty: every note with a
// folder now has a folder to sit in. It is kept rather than removed so a note
// the tree somehow cannot place is still drawn, never dropped.
//
// **Every configured folder appears exactly once**, including two the
// projection cannot place: a folder whose `parentPath` has no config row
// (its parent is unconfigured — the same defect-124 case one level up), and a
// folder caught in a parent cycle. Both are promoted to roots rather than
// silently dropped, because a folder that vanishes from a tree is
// indistinguishable from a folder that does not exist.

/// One configured folder, its configured children, and the notes that sit
/// directly in it.
struct FolderNode: Equatable, Sendable, Identifiable {
    let folder: FolderSummary
    let children: [FolderNode]
    /// Notes whose `folderPath` is exactly this folder's path. A note in a
    /// descendant belongs to the descendant, as it does on desktop, where a
    /// note's folder is the directory the file sits in.
    let notes: [NoteSummary]

    var id: String { folder.path }

    /// The row's title. Never empty and never the path: a path is an id, and
    /// `folder_config` is keyed by it (§13.7.10.1), so it identifies content
    /// and reads as noise.
    var title: String { folder.name.isEmpty ? "Folder with a blank name" : folder.name }

    /// Whether the title above is the folder's own name or this file's.
    var isPlaceholderTitle: Bool { folder.name.isEmpty }

    /// This folder's whole subtree, flattened, parent before child.
    var subtreeRows: [FolderRow] { VaultOutline.rows(children, depth: 0) }
}

/// One line of the rendered tree.
///
/// The tree is flattened here rather than rendered recursively: a SwiftUI
/// `View` whose `body` contains itself has an infinitely recursive type and
/// does not compile, and the alternatives all cost either laziness or the
/// indentation that carries the hierarchy.
struct FolderRow: Equatable, Sendable, Identifiable {
    let path: String
    let title: String
    let isPlaceholderTitle: Bool
    /// 0 for a folder at the vault root. Indentation and the VoiceOver level
    /// both come from this.
    let depth: Int
    /// Notes directly in this folder. Not a subtree total — a count that
    /// silently included descendants would not match the screen it labels.
    let noteCount: Int
    let childFolderCount: Int

    var id: String { path }
}

/// Where a route in the browse stack points.
///
/// `Codable` because `NavigationStack(path:)` restores a saved path, and a
/// restored path is exactly the case research R15's `navigationDestination`
/// rule exists for.
struct FolderRoute: Hashable, Codable, Sendable {
    let path: String
}

/// One vault's browse hierarchy.
struct VaultOutline: Equatable, Sendable {
    /// Configured folders at the vault root, plus the two unplaceable cases
    /// described at the top of this file.
    let roots: [FolderNode]
    /// Notes whose `folderPath` is `nil` — the vault root, chapter 13 §13.4's
    /// explicit null.
    let rootNotes: [NoteSummary]
    /// Notes whose folder carries no `folder_config` row. Real notes; the
    /// folder is what is missing, not them (spec-defect 124).
    let unplacedNotes: [NoteSummary]
    /// Every note in the vault, however it was placed. The screen's own counts
    /// must add up to this.
    let noteCount: Int

    /// True only when both core reads succeeded and both were empty. A read
    /// that failed never reaches this type.
    var isEmpty: Bool { roots.isEmpty && rootNotes.isEmpty && unplacedNotes.isEmpty }

    /// The whole tree, flattened, parent before child.
    var folderRows: [FolderRow] { Self.rows(roots, depth: 0) }

    /// One folder by path.
    ///
    /// A pure lookup over the snapshot, which is what lets a restored or
    /// deep-linked route resolve without a single row having been realised.
    func node(at path: String) -> FolderNode? { Self.find(path, in: roots) }

    private static func find(_ path: String, in nodes: [FolderNode]) -> FolderNode? {
        for node in nodes {
            if node.folder.path == path { return node }
            if let hit = find(path, in: node.children) { return hit }
        }
        return nil
    }

    static func rows(_ nodes: [FolderNode], depth: Int) -> [FolderRow] {
        nodes.flatMap { node in
            [
                FolderRow(
                    path: node.folder.path,
                    title: node.title,
                    isPlaceholderTitle: node.isPlaceholderTitle,
                    depth: depth,
                    noteCount: node.notes.count,
                    childFolderCount: node.children.count
                )
            ] + rows(node.children, depth: depth + 1)
        }
    }
}

// MARK: - Building it

extension VaultOutline {
    /// Folds `folders()` and `list()` into one hierarchy.
    ///
    /// Called once per load, off two snapshots. Nothing here reaches the core,
    /// so a row can be rendered without a second FFI crossing — `list()` costs
    /// a crossing and must never be per row.
    static func build(folders: [FolderSummary], notes: [NoteSummary]) -> VaultOutline {
        let index = FolderIndex(folders + derivedFolders(configured: folders, notes: notes))
        let placement = NotePlacement(notes: notes, configured: index.paths)
        var visited: Set<String> = []
        var roots = sortedByTitle(index.rootPaths, index).compactMap {
            node($0, index, placement, &visited)
        }
        // A configured folder the walk above never reached is caught in a
        // parent cycle. It is promoted rather than dropped: this tree may omit
        // a folder nobody configured, and may omit nothing else.
        for path in index.order where !visited.contains(path) {
            if let stranded = node(path, index, placement, &visited) { roots.append(stranded) }
        }
        return VaultOutline(
            roots: roots,
            rootNotes: placement.rootNotes,
            unplacedNotes: placement.unplaced,
            noteCount: notes.count
        )
    }

    private static func node(
        _ path: String,
        _ index: FolderIndex,
        _ placement: NotePlacement,
        _ visited: inout Set<String>
    ) -> FolderNode? {
        guard let folder = index.byPath[path], visited.insert(path).inserted else { return nil }
        var children: [FolderNode] = []
        for child in sortedByTitle(index.childrenOf[path] ?? [], index) {
            if let node = node(child, index, placement, &visited) { children.append(node) }
        }
        return FolderNode(folder: folder, children: children, notes: placement.byFolder[path] ?? [])
    }
}

extension VaultOutline {
    /// A folder for every note path, and every ancestor of one, that has no
    /// `folder_config` row. Parent before child, so the index keeps the core's
    /// ordering promise; the last path segment is the name, as on disk.
    static func derivedFolders(
        configured: [FolderSummary],
        notes: [NoteSummary]
    ) -> [FolderSummary] {
        var known = Set(configured.map(\.path))
        var derived: [FolderSummary] = []
        let paths = Set(notes.compactMap(\.folderPath)).sorted()
        for path in paths {
            let segments = path.split(separator: "/").map(String.init)
            for depth in segments.indices {
                let current = segments[...depth].joined(separator: "/")
                guard !current.isEmpty, known.insert(current).inserted else { continue }
                let parent = depth == 0 ? nil : segments[..<depth].joined(separator: "/")
                derived.append(
                    FolderSummary(path: current, parentPath: parent, name: segments[depth], icon: nil)
                )
            }
        }
        return derived
    }
}

/// Siblings in the order a reader scans for them: by name, as desktop's file
/// tree lists directories. The config's order is parent-before-child, which
/// says nothing about siblings, and derived folders have no order at all.
private func sortedByTitle(_ paths: [String], _ index: FolderIndex) -> [String] {
    paths.sorted { left, right in
        let leftName = index.byPath[left]?.name ?? left
        let rightName = index.byPath[right]?.name ?? right
        return leftName.localizedStandardCompare(rightName) == .orderedAscending
    }
}

/// The `folder_config` projection, indexed. Core order is preserved throughout:
/// `folders()` promises parent before child and this does not re-sort it.
private struct FolderIndex {
    private(set) var byPath: [String: FolderSummary] = [:]
    private(set) var order: [String] = []
    private(set) var childrenOf: [String: [String]] = [:]
    private(set) var rootPaths: [String] = []

    var paths: Set<String> { Set(order) }

    init(_ folders: [FolderSummary]) {
        for folder in folders where byPath[folder.path] == nil {
            byPath[folder.path] = folder
            order.append(folder.path)
        }
        for path in order {
            guard let folder = byPath[path] else { continue }
            // A parent that is not itself configured makes this folder a root.
            // Hanging it off a folder the tree does not contain would hide it.
            if let parent = folder.parentPath, parent != path, byPath[parent] != nil {
                childrenOf[parent, default: []].append(path)
            } else {
                rootPaths.append(path)
            }
        }
    }
}

/// Where each note goes. Three destinations, and every note reaches exactly
/// one of them — the count is asserted rather than assumed.
private struct NotePlacement {
    private(set) var byFolder: [String: [NoteSummary]] = [:]
    private(set) var rootNotes: [NoteSummary] = []
    private(set) var unplaced: [NoteSummary] = []

    init(notes: [NoteSummary], configured: Set<String>) {
        for note in notes {
            guard let path = note.folderPath else {
                rootNotes.append(note)
                continue
            }
            if configured.contains(path) {
                byFolder[path, default: []].append(note)
            } else {
                unplaced.append(note)
            }
        }
    }
}
