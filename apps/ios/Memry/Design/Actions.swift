import SwiftUI

// Every button in the setup flow, in one place.
//
// **Why a `ButtonStyle` and not `.borderedProminent`.** The platform's
// prominent button is a capsule that hugs its label, so "Get started" arrived
// as a small pill floating in the middle of a screen whose whole layout is a
// 24pt column. Memry's action is the width of that column, with the card radius
// `DESIGN.md` gives a block that size. One style, so a change lands on every
// screen rather than on the screens somebody remembered.
//
// **Ink fill, not tint.** `DESIGN.md`: the tint fills selection and creation
// moments, and white on `#f97316` is 2.80:1, which fails AA. The label on the
// fill is `Interaction.actionForeground`, which the token suite measures.
//
// **Pressed is opacity, not movement.** A button that scales is motion under
// the finger; reduce-motion would have to branch it, and there is nothing worth
// branching. Disabled is also opacity, and the label still says what it does.

struct MemryActionStyle: ButtonStyle {
    enum Kind: Equatable {
        /// The one action a screen is asking for.
        case primary
        /// The alternative beside it.
        case secondary
        /// An action that removes something. Red because `DESIGN.md` gives red
        /// one meaning; the label and the system's destructive role carry it
        /// too, so the colour is never the only cue.
        case destructive
        /// A provider's own button: the provider owns the fill and the label
        /// colour, because its brand guidelines do.
        case provider(fill: Color, label: Color, bordered: Bool)
    }

    let kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        ActionLabel(kind: kind, configuration: configuration)
    }

    /// A real `View`, so `@Environment(\.isEnabled)` updates. `makeBody` is not
    /// one, and an environment read there renders the value it had when the
    /// style was built. Not named `Body`: that is `ButtonStyle`'s own
    /// associated type, and a nested type with the name satisfies it by
    /// accident.
    private struct ActionLabel: View {
        let kind: Kind
        let configuration: Configuration

        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(labelColour)
                .frame(maxWidth: .infinity)
                .frame(minHeight: Tokens.Size.actionHeight)
                .background(fill, in: .rect(cornerRadius: Tokens.Radius.card))
                .overlay(border)
                .opacity(configuration.isPressed ? 0.86 : 1)
                .contentShape(.rect)
        }

        /// Disabled is a **quieter fill**, not a faded one.
        ///
        /// Fading the whole button put white at 45 percent over grey, which is
        /// a label nobody can read — and a disabled control still has to say
        /// what it is, because it is the thing the user is deciding about.
        private var labelColour: Color {
            guard isEnabled else { return Tokens.Text.secondary.color }
            switch kind {
            case .primary: return Tokens.Interaction.actionForeground.color
            case .secondary: return Tokens.Text.primary.color
            case .destructive: return Tokens.Interaction.actionForeground.color
            case let .provider(_, label, _): return label
            }
        }

        private var fill: Color {
            guard isEnabled else { return Tokens.Canvas.surfaceActive.color }
            switch kind {
            case .primary: return Tokens.Interaction.actionFill.color
            case .secondary: return Tokens.Canvas.background.color
            case .destructive: return Tokens.Interaction.destructive.color
            case let .provider(fill, _, _): return fill
            }
        }

        @ViewBuilder
        private var border: some View {
            if isBordered {
                RoundedRectangle(cornerRadius: Tokens.Radius.card)
                    .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
            }
        }

        private var isBordered: Bool {
            // A disabled button carries its own fill, and a hairline on top of
            // it would be a second boundary saying nothing.
            guard isEnabled else { return false }
            switch kind {
            case .primary, .destructive: return false
            case .secondary: return true
            case let .provider(_, _, bordered): return bordered
            }
        }
    }
}

/// The way back, in the place iOS puts it.
///
/// **Only where there is something to undo.** A Back that cannot return the app
/// to where it was is a lie, and the auth machine's states are the core's: the
/// screens that own their own step (the welcome pages, the unlock chooser) get
/// one, and a step the core cannot be walked back out of does not.
struct BackButton: View {
    let action: () -> Void

    var body: some View {
        HStack {
            Button(action: action) {
                Image(systemName: "chevron.backward")
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .frame(
                        width: Tokens.Size.minimumHitArea,
                        height: Tokens.Size.minimumHitArea,
                        alignment: .leading
                    )
                    .contentShape(.rect)
            }
            .accessibilityLabel("Back")
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A provider sign-in button, shaped exactly like Memry's own actions.
///
/// The provider's mark and fill are the provider's; the geometry — full width,
/// card radius, 52pt — is Memry's, so the three ways into an account read as
/// three equals rather than as one product and two adverts.
struct ProviderButton: View {
    enum Provider: Equatable {
        case apple
        case google
    }

    let provider: Provider
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Tokens.Space.small) {
                mark
                Text(title)
            }
        }
        .buttonStyle(MemryActionStyle(kind: kind))
        .accessibilityLabel(title)
    }

    private var title: String {
        switch provider {
        case .apple: "Continue with Apple"
        case .google: "Continue with Google"
        }
    }

    @ViewBuilder
    private var mark: some View {
        switch provider {
        case .apple:
            // The platform ships the mark; nothing here redraws it.
            Image(systemName: "apple.logo")
                .font(Tokens.Typography.heading.font)
                .accessibilityHidden(true)
        case .google:
            GoogleMark()
                .frame(width: 20, height: 20)
                .accessibilityHidden(true)
        }
    }

    private var kind: MemryActionStyle.Kind {
        switch provider {
        case .apple:
            // Apple's guidelines fix this button's colours: black on a light
            // interface, white on a dark one, with the label in the inverse.
            .provider(fill: Self.appleFill.color, label: Self.appleLabel.color, bordered: false)
        case .google:
            // Google's guidelines offer a white button with a hairline; it is
            // also the one that sits next to Memry's own secondary action
            // without shouting over it.
            .provider(
                fill: Tokens.Canvas.background.color,
                label: Tokens.Text.primary.color,
                bordered: true
            )
        }
    }

    private static let appleFill = AdaptiveColor(light: 0x00_00_00, dark: 0xFF_FF_FF)
    private static let appleLabel = AdaptiveColor(light: 0xFF_FF_FF, dark: 0x00_00_00)
}

/// Google's four-colour G.
///
/// **Drawn, because this target ships no asset catalogue.** It is the same
/// geometry as the SVG the desktop renderer uses — one ring of four arcs on a
/// 24-unit grid, plus the bar — expressed as arcs rather than as transcribed
/// cubics, which is the part a reader can check against the numbers below.
/// Swap in Google's own asset before release if their brand review asks for it.
struct GoogleMark: View {
    /// The four arcs, in the order Google draws them, as spans on a y-down
    /// circle where 0 degrees points trailing and 270 points up.
    private static let segments: [(start: Double, end: Double, colour: Color)] = [
        (312, 409, Color(red: 0.259, green: 0.522, blue: 0.957)), // blue, trailing
        (49, 153, Color(red: 0.204, green: 0.659, blue: 0.325)), // green, bottom
        (153, 207, Color(red: 0.984, green: 0.737, blue: 0.020)), // yellow, leading
        (207, 312, Color(red: 0.918, green: 0.263, blue: 0.208)) // red, top
    ]

    var body: some View {
        GeometryReader { proxy in
            let unit = min(proxy.size.width, proxy.size.height) / 24
            ZStack {
                ForEach(Array(Self.segments.enumerated()), id: \.offset) { _, segment in
                    RingSegment(start: segment.start, end: segment.end)
                        .fill(segment.colour)
                }
                // The bar: the blue stroke that turns the ring into a G.
                Rectangle()
                    .fill(Self.segments[0].colour)
                    .frame(width: 10.36 * unit, height: 4.26 * unit)
                    .position(x: 17.18 * unit, y: 12.13 * unit)
            }
        }
    }
}

/// One arc of a ring, as a filled shape rather than a stroked path, so the two
/// radii are the numbers the mark is defined by.
private struct RingSegment: Shape {
    /// Degrees on a y-down circle: 0 trailing, 90 down, 180 leading, 270 up.
    let start: Double
    let end: Double
    private static let outer: CGFloat = 11
    private static let inner: CGFloat = 6.5

    func path(in rect: CGRect) -> Path {
        let unit = min(rect.width, rect.height) / 24
        let centre = CGPoint(x: rect.minX + 12 * unit, y: rect.minY + 12 * unit)
        var path = Path()
        path.addArc(
            center: centre,
            radius: Self.outer * unit,
            startAngle: .degrees(start),
            endAngle: .degrees(end),
            clockwise: false
        )
        path.addArc(
            center: centre,
            radius: Self.inner * unit,
            startAngle: .degrees(end),
            endAngle: .degrees(start),
            clockwise: true
        )
        path.closeSubpath()
        return path
    }
}
