import MemryCore
import SwiftUI

/// Scrolls a note page to the heading a `[[Note#Heading]]` link named, once,
/// when the body's blocks first arrive, and to each heading the inspector's
/// outline picks (#4347).
///
/// A body row's identity is its block's index (`NoteBlockList.Row.id`), so the
/// first matching heading's index is the scroll target. A heading the note no
/// longer has leaves the page at the top, as desktop does.
struct NoteHeadingScroll: ViewModifier {
    let heading: String?
    let blocks: [Block]
    /// The block index the outline asked for; cleared once scrolled to.
    @Binding var jump: Int?

    @State private var scrolled = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content
                .onChange(of: blocks.count, initial: true) {
                    guard !scrolled, let heading, let index = WikiTarget.headingIndex(heading, in: blocks) else { return }
                    scrolled = true
                    // One turn of the run loop, so the rows exist to scroll to.
                    Task { @MainActor in proxy.scrollTo(index, anchor: .top) }
                }
                .onChange(of: jump) { _, index in
                    guard let index else { return }
                    jump = nil
                    withAnimation(Tokens.animation(.normal, .moving, reduceMotion: reduceMotion)) {
                        proxy.scrollTo(index, anchor: .top)
                    }
                }
        }
    }
}
