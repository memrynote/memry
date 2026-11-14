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

    /// An open that carries no query, such as a recent: nothing waits.
    func clear() {
        pending = nil
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
    /// No block holds the query literally, or the page read no blocks at
    /// all: the page opens at the top, find closed.
    case top
    /// Find opens with the query, scrolled to the first matching block.
    case find(query: String, blockIndex: Int)

    /// `read` is whether the page's first read of its blocks has finished.
    static func resolve(_ query: String, in blocks: [Block], read: Bool) -> Self {
        guard !blocks.isEmpty else { return read ? .top : .waiting }
        guard let match = NoteFind.matches(of: query, in: blocks).first else { return .top }
        return .find(query: query, blockIndex: match.blockIndex)
    }
}

/// The find panel's text. A search hit sets it as find opens; closing find,
/// by any path, clears it, so the next open starts empty rather than on an
/// earlier search's word.
struct NoteFindQuery: Equatable {
    var text = ""

    mutating func finding(_ open: Bool) {
        if !open { text = "" }
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
    /// The page's first read of its blocks has finished.
    let blocksRead: Bool
    @Binding var finding: Bool
    /// Whether this page answers ⌘F: a journal day off screen does not.
    var answersFind = true

    @State private var query = NoteFindQuery()
    /// Find was opened from the keyboard, so its field takes the typing.
    @State private var focusField = false
    @State private var pendingQuery: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let requests = SearchFindRequests.shared

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content
                // #4354: ⌘F, desktop's find in page, also with the caret
                // in a block.
                .background {
                    if answersFind {
                        Button("Find in note") {
                            focusField = true
                            finding = true
                        }
                            .keyboardShortcut("f", modifiers: .command)
                            .opacity(0)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .safeAreaInset(edge: .top) {
                    if finding {
                        NoteFindPanel(blocks: blocks, query: $query.text, focusField: focusField) { index in
                            proxy.scrollTo(index, anchor: .top)
                        } close: {
                            finding = false
                        }
                    }
                }
                .onChange(of: finding) { _, open in
                    query.finding(open)
                    if !open { focusField = false }
                }
                .onChange(of: requests.pending, initial: true) {
                    if let query = requests.take(for: target) { pendingQuery = query }
                }
                .onChange(of: OpenKey(query: pendingQuery, blocks: blocks.count, read: blocksRead), initial: true) {
                    guard let pendingQuery else { return }
                    switch SearchFindOpening.resolve(pendingQuery, in: blocks, read: blocksRead) {
                    case .waiting:
                        return
                    case .top:
                        self.pendingQuery = nil
                    case let .find(query, blockIndex):
                        self.pendingQuery = nil
                        // The blocks arrive with the note page's phase change,
                        // which animates on `Tokens.Motion.normal`, and a
                        // scroll issued while it runs is dropped. The panel
                        // enters on the same step, and the scroll runs when
                        // that entrance completes.
                        withAnimation(Tokens.animation(.normal, .entering, reduceMotion: reduceMotion)) {
                            self.query.text = query
                            finding = true
                        } completion: {
                            proxy.scrollTo(blockIndex, anchor: .top)
                        }
                    }
                }
        }
    }

    private struct OpenKey: Equatable {
        let query: String?
        let blocks: Int
        let read: Bool
    }
}
