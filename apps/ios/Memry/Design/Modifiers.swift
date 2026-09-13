import SwiftUI

// T160, the half of the tokens that is a decision rather than a value.
//
// **Both preferences are read inside the modifier's own `body`.** That is the
// whole point of the file: `accessibilityReduceMotion` and
// `accessibilityReduceTransparency` are environment values, and a `View` that
// reads one inside a modifier re-evaluates when the user changes it in
// Settings while the app is running. A token, a theme object, or a stored
// `let` captured once renders yesterday's answer to a setting the user changed
// a second ago, and nothing anywhere reports that it did.
//
// **The decision is also a free function**, so the suite can assert the branch
// over the real inputs rather than over a rendered view — SwiftUI exposes no
// way to read back a resolved `Animation` or `ShapeStyle`. The modifiers below
// are the only callers, and they are one line each.

extension Tokens {
    /// The animation for one motion step, or **nothing at all** under
    /// reduce-motion.
    ///
    /// `nil`, not a shorter duration: `DESIGN.md` says "keep the final state
    /// and remove the movement". A 50 ms version of the same slide is still
    /// the movement the user asked not to see.
    static func animation(
        _ motion: Motion,
        _ curve: Curve = .entering,
        reduceMotion: Bool
    ) -> Animation? {
        guard !reduceMotion else { return nil }
        switch curve {
        case .entering: return .easeOut(duration: motion.duration)
        case .leaving: return .easeIn(duration: motion.duration)
        case .moving: return .easeInOut(duration: motion.duration)
        }
    }

    /// What a raised block is filled with.
    ///
    /// An enum rather than a bare `AnyShapeStyle` because SwiftUI offers no way
    /// to read a resolved `ShapeStyle` back out of a view, so a function
    /// returning one can only be asserted by eye. This can be asserted.
    enum BlockFill: Sendable, CaseIterable, Equatable {
        /// The system's blurred material.
        case material
        /// A solid surface, with no blur at all.
        case opaqueSurface

        var shapeStyle: AnyShapeStyle {
            switch self {
            case .material: AnyShapeStyle(.regularMaterial)
            case .opaqueSurface: AnyShapeStyle(Canvas.surface.color)
            }
        }
    }

    /// The fill for a raised block: the system material normally, an opaque
    /// surface under reduce-transparency.
    ///
    /// `DESIGN.md`: "Every blur treatment must also provide a solid
    /// reduced-transparency result where the platform exposes that
    /// preference." iOS exposes it, so a material here without this branch is
    /// the setting being ignored.
    static func blockFill(reduceTransparency: Bool) -> BlockFill {
        reduceTransparency ? .opaqueSurface : .material
    }
}

/// `.animation(...)` with the reduce-motion branch taken every evaluation.
private struct CalmAnimation<Value: Equatable>: ViewModifier {
    let motion: Tokens.Motion
    let curve: Tokens.Curve
    let value: Value

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.animation(
            Tokens.animation(motion, curve, reduceMotion: reduceMotion),
            value: value
        )
    }
}

/// A raised block with the reduce-transparency branch taken every evaluation.
private struct BlockSurface: ViewModifier {
    let radius: CGFloat

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        content.background(
            Tokens.blockFill(reduceTransparency: reduceTransparency).shapeStyle,
            in: .rect(cornerRadius: radius)
        )
    }
}

extension View {
    /// Animate `value` on a documented motion step, honouring reduce-motion.
    func calmAnimation(
        _ motion: Tokens.Motion,
        _ curve: Tokens.Curve = .entering,
        value: some Equatable
    ) -> some View {
        modifier(CalmAnimation(motion: motion, curve: curve, value: value))
    }

    /// Pad and fill a grouped block, honouring reduce-transparency.
    func blockSurface(radius: CGFloat = Tokens.Radius.card) -> some View {
        modifier(BlockSurface(radius: radius))
    }

    /// The Memry primary action: ink fill, not the platform blue and not the
    /// tint, and never below the 44pt touch floor.
    ///
    /// `DESIGN.md` reserves tint-filled actions for creation and commit
    /// moments and says "do not make every primary button orange"; the
    /// platform default is a third colour that is neither of Memry's answers.
    func memryPrimaryAction() -> some View {
        buttonStyle(.borderedProminent)
            .tint(Tokens.Interaction.actionFill.color)
            .controlSize(.large)
            .frame(minHeight: Tokens.Size.minimumHitArea)
    }

    /// A supporting action beside the primary one.
    func memrySecondaryAction() -> some View {
        buttonStyle(.bordered)
            .tint(Tokens.Text.primary.color)
            .controlSize(.large)
            .frame(minHeight: Tokens.Size.minimumHitArea)
    }
}
