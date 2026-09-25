import SwiftUI

// Chrome shared by feature screens (spec 005 RD01p, moved here by spec 006
// IB032 when the Inbox needed them): a sheet's glass-prominent commit, and
// Liquid Glass for chrome the system does not draw itself, with a solid
// surface under Reduce Transparency.

/// A sheet's commit (artboards 11, 13, 19): a glass-prominent checkmark in
/// the tint with an ink glyph (the tint fills and never carries contrast;
/// the system `confirm` role draws a white glyph on it).
struct SheetConfirmButton: View {
    let label: String
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "checkmark")
                .fontWeight(.semibold)
                .foregroundStyle(Tokens.Tint.foreground.color)
        }
        .buttonStyle(.glassProminent)
        .tint(Tokens.Tint.base.color)
        .disabled(!isEnabled)
        .accessibilityLabel(label)
    }
}

/// System Liquid Glass on a piece of chrome the system does not draw itself,
/// or a solid surface with a hairline under Reduce Transparency.
private struct ChromeGlass<S: Shape>: ViewModifier {
    let shape: S
    let tint: Color?
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(tint ?? Tokens.Canvas.background.color, in: shape)
                .overlay { shape.stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline) }
        } else {
            content.glassEffect(tint.map { Glass.regular.tint($0) } ?? .regular, in: shape)
        }
    }
}

extension View {
    /// Liquid Glass on chrome, solid under Reduce Transparency. A `tint`
    /// colours the glass (and is the solid fill when transparency is off).
    func chromeGlass(in shape: some Shape, tint: Color? = nil) -> some View {
        modifier(ChromeGlass(shape: shape, tint: tint))
    }
}

/// A screen's floating "+" (Paper "Add · glass prominent", Tasks 01, Inbox
/// 01): the one primary action, the tint as a fill with an ink glyph.
struct FloatingAddButton: View {
    let label: String
    let hint: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Tint.foreground.color)
                .padding(Tokens.Space.small)
        }
        .buttonStyle(.glassProminent)
        .buttonBorderShape(.circle)
        .tint(Tokens.Tint.base.color)
        .accessibilityLabel(label)
        .accessibilityHint(hint)
        .accessibilityIdentifier(identifier)
    }
}
