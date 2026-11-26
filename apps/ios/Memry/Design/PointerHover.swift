import SwiftUI

// #4356. System controls, `.borderless` buttons and list links already answer a
// pointer. A `.plain` button, an `onTapGesture` row or chip, or a custom glyph
// gives no feedback until it asks for one, and it asks here so every surface
// picks one of the same three treatments.

enum PointerHover {
    /// A full-width row: the pointer becomes a highlight in the row's shape.
    case row
    /// A chip or card that draws its own fill: it lifts under the pointer.
    case card(radius: CGFloat)
    /// A bare glyph button: the pointer becomes a highlight behind it.
    case glyph
}

private struct PointerHoverModifier: ViewModifier {
    let kind: PointerHover

    func body(content: Content) -> some View {
        switch kind {
        case .row:
            content
                .contentShape(.hoverEffect, .rect(cornerRadius: Tokens.Radius.small))
                .hoverEffect(.highlight)
        case let .card(radius):
            content
                .contentShape(.hoverEffect, .rect(cornerRadius: radius))
                .hoverEffect(.lift)
        case .glyph:
            content
                .contentShape(.hoverEffect, .capsule)
                .hoverEffect(.highlight)
        }
    }
}

extension View {
    /// The pointer's hover feedback for a custom tappable view.
    func pointerHover(_ kind: PointerHover) -> some View {
        modifier(PointerHoverModifier(kind: kind))
    }
}
