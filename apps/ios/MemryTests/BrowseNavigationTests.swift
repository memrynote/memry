import Foundation
import MemryCore
import Testing

@testable import Memry

// T156, research R15's `navigationDestination` rule.
//
// **A `navigationDestination` inside a lazy container is registered only when
// its row is realised.** A deep link or a restored `NavigationStack` path
// therefore resolves against a stack that has never heard of the route, and
// nothing errors — the push simply does not happen. It is a real bug shape,
// and `NotesListView` puts the note rows in a `LazyVStack` on purpose, so the
// rule is load-bearing here rather than decorative.
//
// Two halves are asserted, because neither is enough on its own:
//
//   * the **data** half, here: a route at any depth resolves out of the
//     snapshot alone, with no row having been realised;
//   * the **structural** half, in ``BrowseSourceTests``: the one registration
//     lives in `NotesListView.body`, which contains no lazy container.
//
// The structural half reads the source through `#filePath`, so it runs on a
// simulator or a Mac and genuinely **skips** on a device, where the checkout
// is not present. `.enabled(if:)` skips; `#require` would have failed
// (spec-defect 115).

private func folder(_ path: String, parent: String?) -> FolderSummary {
    FolderSummary(path: path, parentPath: parent, name: path, icon: nil)
}

@Suite("T156 browse navigation")
struct BrowseNavigationTests {
    private var outline: VaultOutline {
        VaultOutline.build(
            folders: [
                folder("Projects", parent: nil),
                folder("Projects/2024", parent: "Projects"),
                folder("Projects/2024/Q1", parent: "Projects/2024")
            ],
            notes: []
        )
    }

    @Test("a route three levels deep resolves from the snapshot, with no row realised")
    func aDeepRouteResolves() {
        let route = FolderRoute(path: "Projects/2024/Q1")
        #expect(outline.node(at: route.path)?.folder.path == route.path)
    }

    @Test("a route into a folder this vault does not hold resolves to nothing, not to an empty folder")
    func anUnknownRouteResolvesToNothing() {
        #expect(outline.node(at: "Archive") == nil)
        // And a folder that is present but holds nothing is a different answer.
        #expect(outline.node(at: "Projects/2024/Q1")?.notes.isEmpty == true)
    }

    @Test("a folder route survives the round trip a restored navigation path makes")
    func aRouteIsCodable() throws {
        let route = FolderRoute(path: "Projects/2024/Q1")
        let data = try JSONEncoder().encode(route)
        #expect(try JSONDecoder().decode(FolderRoute.self, from: data) == route)
    }
}

/// This feature's own sources, located from `#filePath`.
///
/// A separate type from the suite below: a `@Suite` trait that references a
/// static on the suite it is annotating is a circular macro expansion and does
/// not compile.
private enum BrowseSources {
    static var readable: Bool {
        FileManager.default.fileExists(atPath: notesList) &&
            FileManager.default.fileExists(atPath: vaultList)
    }

    /// `<repo>/apps/ios/MemryTests/BrowseNavigationTests.swift`
    private static var featureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Memry/Features", isDirectory: true)
    }

    static var notesList: String {
        featureRoot.appendingPathComponent("Notes/NotesListView.swift").path
    }

    static var vaultList: String {
        featureRoot.appendingPathComponent("Vaults/VaultListView.swift").path
    }

    static func source(_ path: String) throws -> String {
        try String(contentsOfFile: path, encoding: .utf8)
    }

    /// `NotesListView.body`, as written: from the declaration to the first
    /// closing brace at its own indentation.
    static func bodyOfNotesListView(_ source: String) -> String? {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        guard let start = lines.firstIndex(where: { $0.hasPrefix("    var body: some View {") }) else {
            return nil
        }
        guard let end = lines[start...].dropFirst().firstIndex(where: { $0 == "    }" }) else {
            return nil
        }
        return lines[start...end].joined(separator: "\n")
    }
}

/// The structural half. It reads this feature's own sources, so it runs on a
/// simulator and genuinely **skips** on a device, where the checkout is absent.
@Suite("T156 browse source structure")
struct BrowseSourceTests {
    @Test(
        "both navigationDestinations are in NotesListView.body, outside every lazy container",
        .enabled(if: BrowseSources.readable, "the checkout is not present on a device")
    )
    func theDestinationIsOutsideEveryLazyContainer() throws {
        let notesList = try BrowseSources.source(BrowseSources.notesList)
        // Two since T157: `FolderRoute` and `NoteRoute`. The count is the
        // point — it is what catches a third registration added next to the
        // rows it pushes, which is the lazy-container bug R15 is about.
        let calls = notesList.components(separatedBy: ".navigationDestination(").count - 1
        #expect(calls == 2)

        guard let body = BrowseSources.bodyOfNotesListView(notesList) else {
            Issue.record("NotesListView.body could not be located in the source")
            return
        }
        #expect(body.contains(".navigationDestination(for: FolderRoute.self)"))
        #expect(body.contains(".navigationDestination(for: NoteRoute.self)"))
        // The assertion has teeth only because a lazy container really exists
        // in this file; if the rows stopped being lazy, this reminds the next
        // author that the rule is about them.
        #expect(notesList.contains("LazyVStack"))
        for container in ["LazyVStack", "LazyHStack", "LazyVGrid", "LazyHGrid", "List(", "ForEach("] {
            #expect(body.contains(container) == false, "\(container) in NotesListView.body")
        }
    }

    @Test(
        "an opened vault hands off to the browse surface",
        .enabled(if: BrowseSources.readable, "the checkout is not present on a device")
    )
    func theOpenedVaultHandsOff() throws {
        let vaultList = try BrowseSources.source(BrowseSources.vaultList)
        #expect(vaultList.contains("NotesListView("))
    }
}
