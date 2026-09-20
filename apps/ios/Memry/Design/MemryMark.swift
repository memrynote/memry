import SwiftUI

// The brand mark, as a shape rather than an asset.
//
// **Why a `Shape` and not an image.** `apps/ios` ships no asset catalogue, and
// a mark that is drawn scales with Dynamic Type, takes a tint from the caller,
// and cannot arrive at the wrong density. The geometry is the same path the
// desktop renderer draws in `vault-onboarding.tsx`, in the same 680 x 547
// viewbox, so the two surfaces cannot drift into two different logos.
//
// **Decorative by default.** Nothing here sets an accessibility label: the mark
// always sits beside the word "Memry", and a screen reader that announced both
// would say the brand twice.
struct MemryMark: Shape {
    /// The source viewbox. Every coordinate below is in it; `path(in:)` scales.
    private static let source = CGSize(width: 680, height: 547)
    private static let barTop: CGFloat = 345
    private static let barRadius: CGFloat = 28
    private static let lobeRadius: CGFloat = 169
    private static let lobeCentreY: CGFloat = 168.5
    private static let leftLobeX: CGFloat = 170
    private static let rightLobeX: CGFloat = 510
    /// Where the two lobes meet, at the bottom of the V between them.
    private static let notch = CGPoint(x: 340, y: 341)

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / Self.source.width, rect.height / Self.source.height)
        let origin = CGPoint(
            x: rect.midX - Self.source.width * scale / 2,
            y: rect.midY - Self.source.height * scale / 2
        )
        func point(_ across: CGFloat, _ down: CGFloat) -> CGPoint {
            CGPoint(x: origin.x + across * scale, y: origin.y + down * scale)
        }

        var path = Path()
        path.addRoundedRect(
            in: CGRect(
                origin: point(0, Self.barTop),
                size: CGSize(
                    width: Self.source.width * scale,
                    height: (Self.source.height - Self.barTop) * scale
                )
            ),
            cornerSize: CGSize(width: Self.barRadius * scale, height: Self.barRadius * scale)
        )

        let radius = Self.lobeRadius * scale
        // Increasing angles sweep through 270 degrees, which is the top half in
        // SwiftUI's y-down space — the two arcs are the mark's upper lobes.
        path.move(to: point(Self.leftLobeX - Self.lobeRadius, Self.lobeCentreY))
        path.addArc(
            center: point(Self.leftLobeX, Self.lobeCentreY),
            radius: radius,
            startAngle: .degrees(180),
            endAngle: .degrees(360),
            clockwise: false
        )
        path.addLine(to: point(Self.rightLobeX - Self.lobeRadius, Self.lobeCentreY))
        path.addArc(
            center: point(Self.rightLobeX, Self.lobeCentreY),
            radius: radius,
            startAngle: .degrees(180),
            endAngle: .degrees(360),
            clockwise: false
        )
        path.addLine(to: point(Self.notch.x, Self.notch.y))
        path.closeSubpath()
        return path
    }
}

/// The mark beside the word, for a launch screen or a screen header.
///
/// One accessibility element carrying the product name, because the mark and
/// the word are one read.
struct BrandLockup: View {
    /// The mark's height. The word is a type role, so it scales on its own;
    /// this is the one thing that has to be told a size.
    var markHeight: CGFloat = 18
    var role: TypeRole = Tokens.Typography.heading

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            MemryMark()
                .fill(Tokens.Tint.base.color)
                .frame(width: markHeight * MemryMark.aspectRatio, height: markHeight)
            Text("Memry")
                .font(role.font)
                .foregroundStyle(Tokens.Text.primary.color)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Memry")
    }
}

extension MemryMark {
    /// Width over height in the source viewbox, so a caller sizes by height
    /// alone and never distorts the mark.
    static let aspectRatio: CGFloat = 680 / 547
}
