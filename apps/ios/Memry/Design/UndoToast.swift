import SwiftUI

// The undo toast every feature raises after a write (spec 005 RD15, moved here
// by spec 006 IB032 for the Inbox's archive and bulk toasts).

/// The undo toast's capsule (Tasks artboard 15, Inbox artboard 17): a dark glass capsule with a check,
/// the message, and Undo in a lighter capsule when there is one.
///
/// It is drawn in the dark palette in both appearances, so it reads as a
/// transient layer over the canvas; every colour inside is a token's dark
/// half, which is what `DesignTokensTests` measures for contrast. (The dark
/// halves are read directly: an `AdaptiveColor` resolves through UIKit's
/// trait collection, which a SwiftUI `colorScheme` override does not reach.)
struct UndoToastCard: View {
    let message: String
    let undoTitle: String
    let undoHint: String
    /// `<prefix>`, `<prefix>.message`, `<prefix>.undo` for UI tests.
    let identifier: String
    let undo: (() -> Void)?

    private static func dark(_ color: AdaptiveColor) -> Color { Color(uiColor: color.dark.uiColor) }

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: "checkmark.circle.fill")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Self.dark(Tokens.Task.complete))
                .accessibilityHidden(true)
            Text(message)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Self.dark(Tokens.Text.primary))
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("\(identifier).message")
            if let undo {
                Button(action: undo) {
                    Text(undoTitle)
                        .font(Tokens.Typography.supporting.font.weight(.semibold))
                        .foregroundStyle(Self.dark(Tokens.Text.tint))
                        .padding(.horizontal, Tokens.Space.medium)
                        .frame(minHeight: Tokens.Size.pill)
                        .background(Self.dark(Tokens.Text.primary).opacity(Tokens.Palette.chipFillAlpha), in: .capsule)
                        .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint(undoHint)
                .accessibilityIdentifier("\(identifier).undo")
            }
        }
        .padding(.leading, Tokens.Space.inset)
        .padding(.trailing, undo == nil ? Tokens.Space.inset : Tokens.Space.tight)
        .frame(minHeight: Tokens.Size.minimumHitArea + Tokens.Space.tight)
        .chromeGlass(in: .capsule, tint: Self.dark(Tokens.Canvas.surfaceActive))
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}
