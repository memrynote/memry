import MemryCore
import SwiftUI

/// Scrolls a note page to the heading a `[[Note#Heading]]` link named, once,
/// when the body's blocks first arrive.
///
/// A body row's identity is its block's index (`NoteBlockList.Row.id`), so the
/// first matching heading's index is the scroll target. A heading the note no
/// longer has leaves the page at the top, as desktop does.
struct NoteHeadingScroll: ViewModifier {
    let heading: String?
    let blocks: [Block]

    @State private var scrolled = false

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content.onChange(of: blocks.count, initial: true) {
                guard !scrolled, let heading, let index = WikiTarget.headingIndex(heading, in: blocks) else { return }
                scrolled = true
                // One turn of the run loop, so the rows exist to scroll to.
                Task { @MainActor in proxy.scrollTo(index, anchor: .top) }
            }
        }
    }
}
