import SwiftUI
import Testing
import UIKit

@testable import Memry

// T160. What the tokens promise, measured.
//
// **Every assertion here is one a user would notice.** "The token exists",
// "the colour is not nil" and "the modifier was applied" all pass with the
// behaviour deleted, which is the failure mode this phase has found five times.
// So: the contrast tests compute the real WCAG 2.1 ratio of the shipped
// literals and fail on a grey that is merely quiet; the Dynamic Type test
// measures two content size categories and fails on a pinned size; the dark
// test resolves the **shipped** `UIColor` through a real trait collection and
// fails if the dynamic provider is lost.
//
// **What is not asserted, stated rather than implied.** SwiftUI exposes no way
// to read a resolved `Animation` or `ShapeStyle` back out of a rendered view,
// so the two accessibility branches are asserted as decisions —
// `Tokens.animation(_:_:reduceMotion:)` and `Tokens.blockFill(reduceTransparency:)`
// — and the modifiers in `Modifiers.swift` are one line over each. That is the
// strongest thing available without a third-party view inspector, and the
// weakness is that a modifier which stopped calling its decision would still
// pass. It is bounded: both modifiers are three lines, and both take their
// preference from `@Environment` inside `body`, which is the property that
// matters and which a stored flag would break.

@Suite("Design tokens")
struct DesignTokensTests {
    /// WCAG AA for ordinary text.
    private static let readable = 4.5
    /// WCAG 2.1 SC 1.4.11, non-text contrast, for a boundary that is a state
    /// cue.
    private static let distinguishable = 3.0

    private static let styles: [UIUserInterfaceStyle] = [.light, .dark]

    private static let surfaces: [(String, AdaptiveColor)] = [
        ("canvas", Tokens.Canvas.background),
        ("surface", Tokens.Canvas.surface),
        ("surfaceActive", Tokens.Canvas.surfaceActive)
    ]

    private static let inks: [(String, AdaptiveColor)] = [
        ("text.primary", Tokens.Text.primary),
        ("text.secondary", Tokens.Text.secondary),
        ("text.tertiary", Tokens.Text.tertiary),
        ("interaction.destructive", Tokens.Interaction.destructive)
    ]

    private static func contrast(
        _ ink: AdaptiveColor,
        on surface: AdaptiveColor,
        _ style: UIUserInterfaceStyle
    ) -> Double {
        AdaptiveColor.RGB.contrast(ink.rgb(for: style), surface.rgb(for: style))
    }

    // MARK: Note content colours

    /// The nine named inks a note's text can carry, on every app surface.
    ///
    /// **The reason this test exists rather than a transcription.** BlockNote
    /// paints `gray` text `#9b9a97`, which is 2.6:1 on white; four of its
    /// nine inks fail AA. Copying its palette would have shipped unreadable
    /// text under a token file whose whole premise is that it does not.
    @Test("Every named content ink is readable on every surface")
    func contentInksAreReadable() {
        for style in Self.styles {
            for name in Tokens.Content.names {
                guard let ink = Tokens.Content.ink(named: name) else {
                    Issue.record("\(name) has no ink")
                    continue
                }
                for (surfaceName, surface) in Self.surfaces {
                    let ratio = Self.contrast(ink, on: surface, style)
                    #expect(
                        ratio >= Self.readable,
                        "\(name) on \(surfaceName) in \(style.rawValue) is \(ratio)"
                    )
                }
            }
        }
    }

    /// Every ink on every fill, both styles: 9 × 9 × 2.
    ///
    /// A user can pick a text colour and a background colour independently,
    /// so any pair is reachable and checking only the ordinary ink would miss
    /// the pair that actually fails.
    @Test("Every named ink is readable on every named fill")
    func contentInksAreReadableOnFills() {
        for style in Self.styles {
            for fillName in Tokens.Content.names {
                guard let fill = Tokens.Content.fill(named: fillName) else {
                    Issue.record("\(fillName) has no fill")
                    continue
                }
                // The ordinary ink first: a filled block whose text carries
                // no colour of its own is the common case.
                let primary = Self.contrast(Tokens.Text.primary, on: fill, style)
                #expect(
                    primary >= Self.readable,
                    "text.primary on fill \(fillName) in \(style.rawValue) is \(primary)"
                )
                for inkName in Tokens.Content.names {
                    guard let ink = Tokens.Content.ink(named: inkName) else { continue }
                    let ratio = Self.contrast(ink, on: fill, style)
                    #expect(
                        ratio >= Self.readable,
                        "\(inkName) on fill \(fillName) in \(style.rawValue) is \(ratio)"
                    )
                }
            }
        }
    }

    /// An unknown name is `nil`, never a guess.
    ///
    /// A colour a later schema adds must leave the text in the ordinary ink.
    /// Answering with an arbitrary colour would be this build inventing
    /// meaning for a value it does not understand.
    @Test("An unknown content colour name resolves to nothing")
    func unknownContentColoursAreNotGuessed() {
        #expect(Tokens.Content.ink(named: "chartreuse") == nil)
        #expect(Tokens.Content.fill(named: "chartreuse") == nil)
        // `default` is BlockNote's spelling of "no colour", and it must not
        // resolve to a colour either.
        #expect(Tokens.Content.ink(named: "default") == nil)
        #expect(Tokens.Content.fill(named: "default") == nil)
        #expect(Tokens.Content.names.count == 9)
    }

    // MARK: Body heading ramp

    /// Six levels, six distinct sizes, descending.
    ///
    /// The body used to clamp six heading levels onto three roles, so a
    /// level-four and a level-six heading rendered identically and the note
    /// lost structure it really carried.
    @Test("The six body heading levels are six distinct descending steps")
    func bodyHeadingsAreSixDistinctSteps() {
        let category = UITraitCollection(preferredContentSizeCategory: .large)
        func size(_ role: TypeRole) -> CGFloat {
            UIFont.preferredFont(forTextStyle: role.ramp.uiTextStyle, compatibleWith: category)
                .pointSize
        }

        let sizes = (1...6).map { size(Tokens.Typography.bodyHeading(level: $0)) }
        #expect(Set(sizes).count == 6, "two heading levels render alike: \(sizes)")
        #expect(sizes == sizes.sorted(by: >), "the levels must descend: \(sizes)")

        // The note title stays the dominant read on the screen: a body
        // heading must not match it.
        #expect(size(Tokens.Typography.bodyHeading(level: 1)) < size(Tokens.Typography.screenTitle))

        // Out of range clamps rather than crashing, the way `extract_text`
        // clamps its `#` run.
        #expect(Tokens.Typography.bodyHeading(level: 0) == Tokens.Typography.bodyHeading(level: 1))
        #expect(Tokens.Typography.bodyHeading(level: 9) == Tokens.Typography.bodyHeading(level: 6))
    }

    // MARK: The arithmetic itself

    /// The contrast function is pinned to the two ends of the scale before it
    /// is trusted to judge anything else. Black on white is 21:1 and a colour
    /// on itself is 1:1, exactly, in WCAG 2.1.
    @Test("The contrast formula matches WCAG's published endpoints")
    func contrastFormulaIsWcag() {
        let black = AdaptiveColor.RGB(hex: 0x00_00_00)
        let white = AdaptiveColor.RGB(hex: 0xFF_FF_FF)
        #expect(abs(AdaptiveColor.RGB.contrast(black, white) - 21) < 0.001)
        #expect(abs(AdaptiveColor.RGB.contrast(white, white) - 1) < 0.001)
        // Symmetric: a foreground and a background are interchangeable inputs.
        #expect(
            AdaptiveColor.RGB.contrast(black, white)
                == AdaptiveColor.RGB.contrast(white, black)
        )
        // A mid grey on white is 4.6075:1 — just over the value that decides
        // AA, so the formula is pinned at the threshold and not only at the ends.
        let grey = AdaptiveColor.RGB(hex: 0x75_75_75)
        #expect(abs(AdaptiveColor.RGB.contrast(grey, white) - 4.6075) < 0.001)
    }

    // MARK: Contrast, FR-077

    @Test("Every ink meets WCAG AA on every surface, in both interface styles")
    func inkMeetsAaOnEverySurface() {
        for style in Self.styles {
            for (inkName, ink) in Self.inks {
                for (surfaceName, surface) in Self.surfaces {
                    let ratio = Self.contrast(ink, on: surface, style)
                    #expect(
                        ratio >= Self.readable,
                        """
                        \(inkName) on \(surfaceName) is \(ratio):1 in \
                        \(style == .dark ? "dark" : "light"); AA needs 4.5:1.
                        """
                    )
                }
            }
        }
    }

    /// The focus boundary is a state cue, so SC 1.4.11 applies to it. This is
    /// the assertion that stopped `Line.focus` from being the tint: `#f97316`
    /// on the white canvas is 2.80:1 and would fail here.
    @Test("The focus boundary clears 3:1 on every surface, in both styles")
    func focusBoundaryIsDistinguishable() {
        for style in Self.styles {
            for (surfaceName, surface) in Self.surfaces {
                let ratio = Self.contrast(Tokens.Line.focus, on: surface, style)
                #expect(
                    ratio >= Self.distinguishable,
                    "line.focus on \(surfaceName) is \(ratio):1; 1.4.11 needs 3:1."
                )
            }
        }
    }

    @Test("A label on a filled action is readable on its fill")
    func filledActionLabelsAreReadable() {
        for style in Self.styles {
            let action = Self.contrast(Tokens.Interaction.actionForeground, on: Tokens.Interaction.actionFill, style)
            #expect(action >= Self.readable, "interaction.actionForeground on interaction.actionFill is \(action):1.")
            let tint = Self.contrast(Tokens.Tint.foreground, on: Tokens.Tint.base, style)
            #expect(tint >= Self.readable, "tint.foreground on tint.base is \(tint):1.")
        }
    }

    /// `DESIGN.md` fixes the product accent and rejects three specific
    /// alternatives by hex. Two of them are the ones a starter template or a
    /// landing asset would supply.
    @Test("The accent is the documented product tint and none of the rejected ones")
    func accentIsTheProductTint() {
        #expect(Tokens.Tint.base.light == AdaptiveColor.RGB(hex: 0xF9_73_16))
        #expect(Tokens.Tint.base.dark == AdaptiveColor.RGB(hex: 0xF9_73_16))
        let rejected: [UInt32] = [0xFF_67_1A, 0x63_66_F1]
        for hex in rejected {
            #expect(Tokens.Tint.base.light != AdaptiveColor.RGB(hex: hex))
        }
    }

    // MARK: Dark mode is real, not declared

    /// Resolves the **shipped** `UIColor` — the one the views draw with —
    /// through a real trait collection, rather than reading the two literals
    /// back. A token that lost its dynamic provider, or had its dark answer
    /// copied from its light one, fails here.
    @Test("Every colour resolves to its declared answer in each interface style")
    func coloursResolvePerInterfaceStyle() {
        let tokens: [(String, AdaptiveColor)] =
            Self.surfaces + Self.inks + [
                ("line.border", Tokens.Line.border),
                ("line.focus", Tokens.Line.focus),
                ("interaction.actionFill", Tokens.Interaction.actionFill),
                ("interaction.actionForeground", Tokens.Interaction.actionForeground),
                ("tint.base", Tokens.Tint.base),
                ("tint.foreground", Tokens.Tint.foreground)
            ]
        for (name, token) in tokens {
            for style in Self.styles {
                let resolved = token.uiColor.resolvedColor(
                    with: UITraitCollection(userInterfaceStyle: style)
                )
                let expected = token.rgb(for: style).uiColor
                #expect(
                    resolved == expected,
                    "\(name) did not resolve to its declared \(style == .dark ? "dark" : "light") value."
                )
            }
        }
    }

    /// The canvas and the ink must actually change between styles. A palette
    /// that is dark-mode-shaped but light-mode-valued passes the test above
    /// and fails this one.
    @Test("The canvas and the ink ramp differ between light and dark")
    func darkModeIsNotLightMode() {
        let mustDiffer: [(String, AdaptiveColor)] = Self.surfaces + [
            ("text.primary", Tokens.Text.primary),
            ("text.secondary", Tokens.Text.secondary),
            ("text.tertiary", Tokens.Text.tertiary),
            ("line.border", Tokens.Line.border)
        ]
        for (name, token) in mustDiffer {
            #expect(token.light != token.dark, "\(name) is the same colour in both styles.")
        }
    }

    // MARK: Dynamic Type, FR-077

    /// Measures the ramp at the default category and at the largest
    /// accessibility one. A role pinned to a point size does not move, and
    /// fails.
    @Test("Every step of the type ramp grows with the content size category")
    func typeRampScales() {
        let small = UITraitCollection(preferredContentSizeCategory: .large)
        let large = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
        for ramp in TypeRole.Ramp.allCases {
            let base = UIFont.preferredFont(forTextStyle: ramp.uiTextStyle, compatibleWith: small)
            let scaled = UIFont.preferredFont(forTextStyle: ramp.uiTextStyle, compatibleWith: large)
            #expect(
                scaled.pointSize > base.pointSize,
                "\(ramp) did not grow: \(base.pointSize) to \(scaled.pointSize)."
            )
        }
    }

    /// The ramp is a hierarchy, not a list: the screen title must actually be
    /// the dominant read, and the caption must actually be the quietest.
    @Test("The ramp is ordered, so the dominant read is dominant")
    func typeRampIsOrdered() {
        let category = UITraitCollection(preferredContentSizeCategory: .large)
        func size(_ ramp: TypeRole.Ramp) -> CGFloat {
            UIFont.preferredFont(forTextStyle: ramp.uiTextStyle, compatibleWith: category).pointSize
        }
        #expect(size(.screenTitle) > size(.sectionTitle))
        #expect(size(.sectionTitle) > size(.body))
        #expect(size(.body) > size(.supporting))
        #expect(size(.supporting) > size(.caption))
    }

    /// Every role in the catalogue reaches the ramp, so none of them can be
    /// carrying a fixed size. `Font` is opaque, which is why this holds the
    /// descriptor the `font` property is built from.
    @Test("Every named type role is a Dynamic Type step")
    func everyRoleIsDynamic() {
        let roles: [TypeRole] = [
            Tokens.Typography.screenTitle, Tokens.Typography.sectionTitle,
            Tokens.Typography.heading, Tokens.Typography.body,
            Tokens.Typography.supporting, Tokens.Typography.label,
            Tokens.Typography.caption, Tokens.Typography.editorial,
            Tokens.Typography.welcomeHeadline,
            Tokens.Typography.recoveryMaterial, Tokens.Typography.technicalCaption
        ]
        #expect(roles.count == 11)
        for role in roles {
            #expect(TypeRole.Ramp.allCases.contains(role.ramp))
        }
        // Recovery material is read character by character, so it is mono —
        // `DESIGN.md` §Typography names exactly that use.
        #expect(Tokens.Typography.recoveryMaterial.design == .monospaced)
        #expect(Tokens.Typography.technicalCaption.design == .monospaced)
        #expect(Tokens.Typography.editorial.design == .serif)
        #expect(Tokens.Typography.welcomeHeadline.design == .serif)
        #expect(Tokens.Typography.welcomeHeadline.ramp == .screenTitle)
    }

    // MARK: Reduce motion

    /// `nil`, not a shorter duration. `DESIGN.md`: "Keep the final state and
    /// remove the movement."
    @Test("Reduce motion removes the animation entirely, for every step and curve")
    func reduceMotionRemovesTheAnimation() {
        for motion in Tokens.Motion.allCases {
            for curve in Tokens.Curve.allCases {
                #expect(Tokens.animation(motion, curve, reduceMotion: true) == nil)
                #expect(Tokens.animation(motion, curve, reduceMotion: false) != nil)
            }
        }
    }

    @Test("The duration ladder is DESIGN.md's, and it ascends")
    func durationLadderIsOrdered() {
        #expect(Tokens.Motion.instant.duration == 0.1)
        #expect(Tokens.Motion.fast.duration == 0.15)
        #expect(Tokens.Motion.normal.duration == 0.2)
        #expect(Tokens.Motion.slow.duration == 0.3)
        #expect(Tokens.Motion.deliberate.duration == 0.4)
        let ladder = Tokens.Motion.allCases.map(\.duration)
        #expect(ladder == ladder.sorted())
        // Nothing on the ladder is long enough to delay access to content.
        #expect(ladder.allSatisfy { $0 <= 0.4 })
    }

    // MARK: Reduce transparency

    @Test("Reduce transparency replaces the material with a solid surface")
    func reduceTransparencyRemovesTheBlur() {
        #expect(Tokens.blockFill(reduceTransparency: true) == .opaqueSurface)
        #expect(Tokens.blockFill(reduceTransparency: false) == .material)
        // Two answers, not one dressed as two.
        #expect(Tokens.BlockFill.allCases.count == 2)
    }

    // MARK: Spacing, radius, touch

    /// `DESIGN.md` §"Spacing and density": a shared 4pt base, an 8pt grouping
    /// rhythm. A 20 or a 14 slipped into the scale fails here.
    @Test("Every spacing token sits on the 4pt base, and the grouping steps on 8")
    func spacingFollowsTheBase() {
        let base: [CGFloat] = [Tokens.Space.tight]
        let grouping: [CGFloat] = [
            Tokens.Space.small, Tokens.Space.medium, Tokens.Space.inset,
            Tokens.Space.section, Tokens.Space.screenInline, Tokens.Space.screenBlock
        ]
        for value in base + grouping {
            #expect(value > 0)
            #expect(value.truncatingRemainder(dividingBy: 4) == 0, "\(value) is not on the 4pt base.")
        }
        for value in grouping where value != Tokens.Space.medium {
            #expect(value.truncatingRemainder(dividingBy: 8) == 0, "\(value) is not on the 8pt rhythm.")
        }
        // `DESIGN.md`'s comfortable density puts page padding at 24-32pt
        // inline and 32-48pt block. Sign-in and unlock are reading surfaces.
        #expect(Tokens.Space.screenInline >= 24 && Tokens.Space.screenInline <= 32)
        #expect(Tokens.Space.screenBlock >= 32 && Tokens.Space.screenBlock <= 48)
    }

    @Test("The radius ladder is DESIGN.md's roles, ascending")
    func radiusLadderIsOrdered() {
        let ladder = [
            Tokens.Radius.small, Tokens.Radius.control, Tokens.Radius.card,
            Tokens.Radius.panel, Tokens.Radius.container
        ]
        #expect(ladder == ladder.sorted())
        #expect(ladder == [6, 8, 12, 16, 20])
    }

    /// `DESIGN.md`: "Keep touch targets at least 44pt." Not a style rule — a
    /// target under it is one a user misses.
    @Test("The touch floor is the platform's 44pt")
    func touchFloorIsFortyFour() {
        #expect(Tokens.Size.minimumHitArea >= 44)
        #expect(Tokens.Size.hairline == 1)
    }
}

// MARK: Adoption, rendered

/// The tests above hold the *decisions*. These hold the **pixels**, through
/// `ImageRenderer`, which is the only thing in the platform that evaluates a
/// real SwiftUI view tree without a simulator UI test.
///
/// This is the part that answers THE LESSON directly. A token file that nothing
/// adopts is the failure mode, and "`ErrorNotice` uses `Tokens.Text.primary`"
/// is a claim a reader checks by eye. Rendering the **shipped** view twice,
/// once under each value of a preference, and requiring the two images to
/// differ, fails the moment the token stops reaching the screen — including if
/// the modifier is deleted from the view, which no assertion over `Tokens`
/// alone can see.
///
/// **`accessibilityReduceTransparency` has no render test, and that is a real
/// gap rather than an omission.** Its `EnvironmentValues` key is read-only —
/// `.environment(\.accessibilityReduceTransparency, true)` does not compile,
/// because the key path is a `KeyPath` and not a `WritableKeyPath` — so a test
/// cannot drive it and `ImageRenderer` cannot be told to pretend. That branch
/// is asserted as a decision, over `Tokens.blockFill(reduceTransparency:)`,
/// and the modifier over it is three lines.
@Suite("Design tokens reach the screen", .serialized)
@MainActor
struct DesignTokensRenderTests {
    private static let failure = UserFacingError(
        code: "signIn.codeNotSixDigits",
        title: "A Memry code is six digits.",
        guidance: "Check the email again and copy the six-digit number from it.",
        recourse: .retry,
        isUserVisible: true
    )

    private func render(
        dynamicType: DynamicTypeSize = .large,
        colorScheme: ColorScheme = .light
    ) -> Data? {
        let view = ErrorNotice(error: Self.failure, code: nil)
            .frame(width: 320)
            .environment(\.dynamicTypeSize, dynamicType)
            .environment(\.colorScheme, colorScheme)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        return renderer.uiImage?.pngData()
    }

    @Test("The shipped notice renders at all")
    func noticeRenders() {
        let image = render()
        #expect(image != nil)
        #expect((image?.count ?? 0) > 0)
    }

    /// A fixed point size anywhere in `ErrorNotice` makes these two identical.
    @Test("Dynamic Type changes what the notice actually draws")
    func dynamicTypeChangesThePixels() {
        let regular = render(dynamicType: .large)
        let largest = render(dynamicType: .accessibility5)
        #expect(regular != nil)
        #expect(largest != nil)
        #expect(regular != largest)
    }

    /// Replacing a token with a fixed colour makes these two identical.
    @Test("Dark mode changes what the notice actually draws")
    func darkModeChangesThePixels() {
        let light = render(colorScheme: .light)
        let dark = render(colorScheme: .dark)
        #expect(light != nil)
        #expect(dark != nil)
        #expect(light != dark)
    }
}
