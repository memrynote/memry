import SwiftUI

// The screen a state that is not a form gets: a mark, a title, a second
// sentence, and at most two ways on.
//
// **It exists because four screens were writing it out.** The expired setup,
// the expired session, the revoked device and the build that cannot reach a
// server are one shape with four sets of words, and four copies of the shape
// is four places for the spacing to drift.
//
// **The second sentence is not optional.** `DESIGN.md`: "An error the user
// cannot act on still gets a second sentence" — say what happens next without
// them, that the notes are safe, that the sync will retry. So `detail` is a
// plain `String` and not an optional.
//
// **Red only where red means something.** `Tone.destructive` marks a state
// where something was taken away; everything else is ink, because red does not
// mean emphasis.
struct NoticeScreen<Actions: View>: View {
    enum Tone: Equatable {
        case neutral
        case destructive
    }

    let symbol: String
    var tone: Tone = .neutral
    let title: String
    let detail: String
    @ViewBuilder var actions: Actions

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                Spacer(minLength: Tokens.Space.section)
                mark
                VStack(alignment: .leading, spacing: Tokens.Space.small) {
                    Text(title)
                        .font(Tokens.Typography.screenTitle.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .accessibilityAddTraits(.isHeader)
                    Text(detail)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Two sentences are one thought; VoiceOver should not stop
                // between them and lose the half that says what happens next.
                .accessibilityElement(children: .combine)
                VStack(alignment: .leading, spacing: Tokens.Space.medium) { actions }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.screenBlock)
        }
        .background(Tokens.Canvas.background.color)
    }

    /// A restrained container, which `DESIGN.md` allows in exactly this case:
    /// "an empty, success, setup, or recovery state when it explains that
    /// state". It is decoration on top of a title that already reads.
    private var mark: some View {
        Image(systemName: symbol)
            .font(Tokens.Typography.sectionTitle.font)
            .foregroundStyle(
                tone == .destructive
                    ? Tokens.Interaction.destructive.color
                    : Tokens.Text.primary.color
            )
            .frame(width: Tokens.Size.actionHeight, height: Tokens.Size.actionHeight)
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
            .accessibilityHidden(true)
    }
}
