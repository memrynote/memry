import MemryCore
import Observation
import SwiftUI

/// A page find can open on: a note by id, a journal day by date.
enum FindTarget: Hashable, Sendable {
    case note(String)
    case journalDay(String)
}

/// The query a search hit hands the page it opens (#4317).
///
/// Memory only and taken once, so the query never rides in a restorable route
/// (`NoteRoute`, `JournalRoute`) and a relaunch never reopens find.
@MainActor
@Observable
final class SearchFindRequests {
    static let shared = SearchFindRequests()

    struct Request: Equatable {
        let target: FindTarget
        let query: String
    }

    private(set) var pending: Request?

    func open(_ target: FindTarget, query: String) {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        pending = query.isEmpty ? nil : Request(target: target, query: query)
    }

    /// The query waiting for `target`, cleared as it is read.
    func take(for target: FindTarget) -> String? {
        guard let request = pending, request.target == target else { return nil }
        pending = nil
        return request.query
    }
}

/// What a page does with a search hit's query once its blocks are read.
enum SearchFindOpening: Equatable {
    /// The blocks are not here yet.
    case waiting
    /// No block holds the query literally: the page opens at the top, find
    /// closed.
    case top
    /// Find opens with the query, scrolled to the first matching block.
    case find(query: String, blockIndex: Int)

    static func resolve(_ query: String, in blocks: [Block]) -> Self {
        guard !blocks.isEmpty else { return .waiting }
        guard let match = NoteFind.matches(of: query, in: blocks).first else { return .top }
        return .find(query: query, blockIndex: match.blockIndex)
    }
}

/// Find in page for a note or a journal day: the panel over the page, a tapped
/// match scrolling to its block, and a search hit's query opening it once.
///
/// A body row's identity is its block's index (`NoteBlockList.Row.id`), as in
/// `NoteHeadingScroll`, so a match's `blockIndex` is the scroll target.
struct NoteFindScroll: ViewModifier {
    let target: FindTarget
    let blocks: [Block]
    @Binding var finding: Bool

    @State private var query = ""
    @State private var pendingQuery: String?
    private let requests = SearchFindRequests.shared

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content
                .safeAreaInset(edge: .top) {
                    if finding {
                        NoteFindPanel(blocks: blocks, query: $query) { index in
                            proxy.scrollTo(index, anchor: .top)
                        } close: {
                            finding = false
                        }
                    }
                }
                .onChange(of: requests.pending, initial: true) {
                    if let query = requests.take(for: target) { pendingQuery = query }
                }
                .onChange(of: OpenKey(query: pendingQuery, blocks: blocks.count), initial: true) {
                    guard let pendingQuery else { return }
                    switch SearchFindOpening.resolve(pendingQuery, in: blocks) {
                    case .waiting:
                        return
                    case .top:
                        self.pendingQuery = nil
                    case let .find(query, blockIndex):
                        self.pendingQuery = nil
                        self.query = query
                        finding = true
                        // After the push settles: a scroll in the turn the
                        // blocks arrive is dropped and the page stays at the
                        // top (seen on the simulator), while a tapped match,
                        // later, scrolls.
                        Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(400))
                            proxy.scrollTo(blockIndex, anchor: .top)
                        }
                    }
                }
        }
    }

    private struct OpenKey: Equatable {
        let query: String?
        let blocks: Int
    }
}
