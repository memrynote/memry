import SwiftUI

// #4699. While both panes show, each note page draws its own header row above
// its note: Back while the pane has followed a link, and the page menu at its
// trailing edge, as each of desktop's split panes carries its own controls.
// The system bar spans the whole column, so it keeps only the column's
// controls: the pane controls it held merged there, over the wrong pane.

struct NotesPaneHeader<PageMenu: View>: View {
    let pane: NotesPaneContext
    /// A cover runs under the header with the edge blur hidden, so the
    /// controls carry glass there, as the system bar's do.
    let overCover: Bool
    @ViewBuilder let menu: PageMenu

    private var id: String { "notes.pane.\(pane.slot.rawValue)" }

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            if let trail = pane.router.pane(pane.slot)?.trail, !trail.isEmpty {
                control(
                    Button("Back", systemImage: "chevron.backward") {
                        pane.router.setTrail(Array(trail.dropLast()), in: pane.slot)
                    }
                    .labelStyle(.iconOnly)
                )
                .accessibilityIdentifier("\(id).back")
            }
            Spacer(minLength: 0)
            control(menu.menuStyle(.button))
                .accessibilityIdentifier("\(id).more")
        }
        .padding(.horizontal, Tokens.Space.small)
    }

    /// The text colour, not the tint, which is under 3:1 on the canvas
    /// (WCAG 1.4.11). Both panes have the same two controls, so the hint
    /// names the pane for VoiceOver.
    @ViewBuilder
    private func control(_ view: some View) -> some View {
        let styled = view
            .foregroundStyle(Tokens.Text.primary.color)
            .accessibilityHint(NotesPaneCopy.pane(pane.slot))
        Group {
            if overCover {
                styled.buttonStyle(.glass).buttonBorderShape(.circle)
            } else {
                styled.buttonStyle(.borderless)
            }
        }
        .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
    }
}
