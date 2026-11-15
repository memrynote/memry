import SwiftUI

// #4699. While both panes show, each note page draws its own header row above
// its note: Back while the pane has followed a link, and the page menu at its
// trailing edge, as each of desktop's split panes carries its own controls.
// The system bar spans the whole column, so it keeps only the column's
// controls: the pane controls it held merged there, over the wrong pane.

struct NotesPaneHeader<PageMenu: View>: View {
    let pane: NotesPaneContext
    @ViewBuilder let menu: PageMenu

    private var id: String { "notes.pane.\(pane.slot.rawValue)" }

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            if let trail = pane.router.pane(pane.slot)?.trail, !trail.isEmpty {
                Button("Back", systemImage: "chevron.backward") {
                    pane.router.setTrail(Array(trail.dropLast()), in: pane.slot)
                }
                .labelStyle(.iconOnly)
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
                .accessibilityIdentifier("\(id).back")
            }
            Spacer(minLength: 0)
            menu
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
                .accessibilityIdentifier("\(id).more")
        }
        .padding(.horizontal, Tokens.Space.small)
    }
}
