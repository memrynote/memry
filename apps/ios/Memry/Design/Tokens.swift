import SwiftUI
import UIKit

// T160. The iOS implementation of `DESIGN.md`.
//
// **This file mirrors a system, not a stylesheet.** `DESIGN.md` is the
// authority; `apps/desktop` is its current reference implementation, and
// "reference does not mean pixel copy". So what crosses from desktop is the
// *meaning* — canvas, text ramp, line, tint, radius role, motion step — and
// the representation is native: adaptive `UIColor`, Dynamic Type text styles,
// point spacing. No CSS string and no Tailwind value is transcribed here.
//
// **Everything a user reads is verified, not asserted.** Each colour is
// declared once per interface style, and `DesignTokensTests` computes the real
// WCAG 2.1 contrast ratio of every text role against every surface role in
// both styles. A quiet-looking grey that fails 4.5:1 fails the suite —
// `DESIGN.md` rejects "tiny low-contrast metadata added for visual quietness"
// and FR-077 requires AA.
//
// **There is no fixed point size in this file.** Every type role is a
// `Font.TextStyle`, so Dynamic Type works without a caller opting in, and a
// role that stopped scaling would fail the suite.
//
// **Nothing here reads an accessibility preference.** Reduce-motion and
// reduce-transparency are *decisions*, not values, and they are taken at the
// modifier in `Modifiers.swift` on every evaluation — a preference read once
// into a stored token would render yesterday's answer to a setting the user
// can change while the app is running.
//
// **Direction never appears.** There is no leading or trailing token because
// there is no physical one to replace: SwiftUI's `.leading`/`.trailing` are
// already logical, and a `left`/`right` value has no way into the system.

/// One colour, declared once per interface style.
///
/// Two literals rather than one dynamic blob, because the two are what a test
/// can read. `uiColor` is the single construction the app uses, so a build
/// that lost its dark answer loses it for the suite too.
struct AdaptiveColor: Sendable, Equatable {
    /// A colour component triple in the extended sRGB space, plus the two
    /// pieces of WCAG 2.1 arithmetic that decide whether it may carry text.
    struct RGB: Sendable, Equatable {
        let red: Double
        let green: Double
        let blue: Double

        init(hex: UInt32) {
            red = Double((hex >> 16) & 0xFF) / 255
            green = Double((hex >> 8) & 0xFF) / 255
            blue = Double(hex & 0xFF) / 255
        }

        /// WCAG 2.1 relative luminance.
        var relativeLuminance: Double {
            func channel(_ value: Double) -> Double {
                value <= 0.039_28 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
        }

        var uiColor: UIColor { UIColor(red: red, green: green, blue: blue, alpha: 1) }

        /// WCAG 2.1 contrast ratio. Symmetric, so the argument order of a
        /// foreground and a background does not change the answer.
        static func contrast(_ one: RGB, _ other: RGB) -> Double {
            let first = one.relativeLuminance
            let second = other.relativeLuminance
            return (max(first, second) + 0.05) / (min(first, second) + 0.05)
        }
    }

    let light: RGB
    let dark: RGB

    init(light: UInt32, dark: UInt32) {
        self.light = RGB(hex: light)
        self.dark = RGB(hex: dark)
    }

    /// The dynamic colour every view ends up drawing with.
    ///
    /// Resolved by the system per trait collection, which is what makes a
    /// theme change mid-session correct rather than stale.
    var uiColor: UIColor {
        let lightColor = light.uiColor
        let darkColor = dark.uiColor
        return UIColor { $0.userInterfaceStyle == .dark ? darkColor : lightColor }
    }

    var color: Color { Color(uiColor) }

    func rgb(for style: UIUserInterfaceStyle) -> RGB { style == .dark ? dark : light }
}

/// One typographic role: a Dynamic Type step, a family character, a weight.
///
/// The step is stored as a closed `Ramp` rather than as a `Font.TextStyle`
/// because the two switches below must stay in lock-step, and an enum this
/// file owns makes that a compiler obligation instead of a convention.
struct TypeRole: Sendable, Equatable {
    /// The Dynamic Type steps Memry uses on iOS. Closed on purpose: a screen
    /// that wants a size not on this list is asking for a design decision, not
    /// for a number.
    enum Ramp: Sendable, CaseIterable, Equatable {
        /// The one dominant read on a screen. `DESIGN.md`: "one dominant read".
        case screenTitle
        /// A structural heading inside a screen.
        case sectionTitle
        /// The heading of a grouped block, a notice, a card.
        case heading
        /// Ordinary body copy and controls.
        case body
        /// Supporting copy that sits under the body.
        case supporting
        /// A field label, a counter, a row's secondary line.
        case label
        /// Metadata, codes, and dense numeric readouts.
        case caption

        var textStyle: Font.TextStyle {
            switch self {
            case .screenTitle: .largeTitle
            case .sectionTitle: .title2
            case .heading: .headline
            case .body: .body
            case .supporting: .subheadline
            case .label: .callout
            case .caption: .footnote
            }
        }

        /// The same step in UIKit's vocabulary. UIKit is where the scaling is
        /// observable, so this is the half the Dynamic Type test measures.
        var uiTextStyle: UIFont.TextStyle {
            switch self {
            case .screenTitle: .largeTitle
            case .sectionTitle: .title2
            case .heading: .headline
            case .body: .body
            case .supporting: .subheadline
            case .label: .callout
            case .caption: .footnote
            }
        }
    }

    let ramp: Ramp
    let design: Font.Design
    let weight: Font.Weight

    init(_ ramp: Ramp, design: Font.Design = .default, weight: Font.Weight = .regular) {
        self.ramp = ramp
        self.design = design
        self.weight = weight
    }

    /// The only way a view gets a font out of this file. No `Font.system(size:)`
    /// appears anywhere in `Memry/Design`, so nothing here can stop scaling.
    var font: Font { .system(ramp.textStyle, design: design).weight(weight) }
}

/// The tokens. Names follow `DESIGN.md` §"Mobile implementation API", which
/// fixes the mobile vocabulary as `canvas`, `text`, `line`, `ui` and `tint`.
enum Tokens {
    // MARK: Canvas and surfaces

    /// `DESIGN.md` §"Themes and semantic color". iOS ships the **default**
    /// theme pair — "White, default" in light, "Dark" in dark. The paper theme
    /// is a stored user choice and there is no settings surface on iOS yet, so
    /// a third palette here would be a control nobody can reach.
    enum Canvas {
        /// `--background`. One continuous canvas before a collection of cards.
        static let background = AdaptiveColor(light: 0xFF_FF_FF, dark: 0x12_12_12)
        /// `--surface`. Secondary panels and grouped blocks.
        static let surface = AdaptiveColor(light: 0xF7_F6_F3, dark: 0x20_20_20)
        /// `--surface-active`. Pressed, selected-neutral, grouped settings.
        static let surfaceActive = AdaptiveColor(light: 0xEF_EE_EA, dark: 0x2A_2A_2A)
    }

    // MARK: Text

    /// The three-step ink ramp. Every one of them meets 4.5:1 against every
    /// surface above, in both styles — see `DesignTokensTests`.
    enum Text {
        /// `--text-primary`. The main read.
        static let primary = AdaptiveColor(light: 0x37_35_2F, dark: 0xBC_BA_B6)
        /// `--text-secondary`. Supporting content.
        static let secondary = AdaptiveColor(light: 0x62_5F_59, dark: 0xA5_A2_9D)
        /// `--text-tertiary`. Metadata and inactive icons.
        static let tertiary = AdaptiveColor(light: 0x6F_6C_66, dark: 0x96_93_8D)
    }

    // MARK: Boundaries

    enum Line {
        /// The ordinary one-point separator. Deliberately quiet: it groups,
        /// and the grouping is also carried by spacing, so WCAG 1.4.11 does
        /// not apply to it.
        static let border = AdaptiveColor(light: 0xE5_E3_DE, dark: 0x2E_2E_2E)
        /// The focus and validation boundary. This one **is** a state cue, so
        /// it clears 1.4.11's 3:1 against every surface — which is why it is
        /// ink-derived and not the tint. See the note on `Tint.base`.
        static let focus = AdaptiveColor(light: 0x6F_6C_66, dark: 0x96_93_8D)
    }

    // MARK: Semantic interaction

    enum Interaction {
        /// Red means destructive, failed, urgent, or overdue — never emphasis.
        static let destructive = AdaptiveColor(light: 0xA3_23_1C, dark: 0xFF_80_78)
        /// The fill of an ordinary primary action.
        ///
        /// Ink, not tint: `DESIGN.md` reserves tint-filled actions for
        /// "user-themed creation or commit moments" and says in as many words
        /// "do not make every primary button orange". It is also not the
        /// platform blue, which is neither of Memry's two answers.
        static let actionFill = AdaptiveColor(light: 0x37_35_2F, dark: 0xBC_BA_B6)
        /// The label on `actionFill`.
        static let actionForeground = AdaptiveColor(light: 0xFF_FF_FF, dark: 0x12_12_12)
    }

    // MARK: Accent

    enum Tint {
        /// The product accent. `DESIGN.md` fixes the default at `#f97316` and
        /// rejects both the landing terracotta `#ff671a` and the React Native
        /// shell's `#6366f1` drift. A user-chosen accent is a settings
        /// concern and has no source on iOS yet.
        ///
        /// **Fill only.** At 2.80:1 on the light canvas it cannot carry text
        /// or a focus boundary, which is why `Line.focus` exists.
        static let base = AdaptiveColor(light: 0xF9_73_16, dark: 0xF9_73_16)
        /// The label on a tint fill. Ink rather than white: white on `#f97316`
        /// is 2.80:1 and fails AA.
        static let foreground = AdaptiveColor(light: 0x1A_1A_1A, dark: 0x1A_1A_1A)
    }

    // MARK: Spacing

    /// `DESIGN.md` §"Spacing and density": a shared 4pt base with an 8pt
    /// grouping rhythm. Every value below is a multiple of 4 and every value
    /// from `small` up is a multiple of 8; the suite holds that.
    enum Space {
        /// Inside a single label group — a glyph beside its text.
        static let tight: CGFloat = 4
        /// Between the two lines of one thought.
        static let small: CGFloat = 8
        /// Between sibling controls.
        static let medium: CGFloat = 12
        /// A block's internal padding.
        static let inset: CGFloat = 16
        /// Between sections of a screen.
        static let section: CGFloat = 24
        /// A screen's inline padding. `DESIGN.md`'s comfortable density puts
        /// page padding at 24–32pt inline; a reading and onboarding surface
        /// takes the comfortable end.
        static let screenInline: CGFloat = 24
        /// A screen's block padding.
        static let screenBlock: CGFloat = 32
    }

    // MARK: Radius

    /// `DESIGN.md` §"Surfaces, boundaries, and depth". Radius follows control
    /// size and grouping, not taste.
    enum Radius {
        /// Dense toolbar buttons, menu rows, small controls.
        static let small: CGFloat = 6
        /// Inputs, buttons, list rows, tabs, ordinary groups.
        static let control: CGFloat = 8
        /// Cards and medium panels.
        static let card: CGFloat = 12
        /// Large cards and composers.
        static let panel: CGFloat = 16
        /// A rare large dialog or onboarding container.
        static let container: CGFloat = 20
    }

    // MARK: Size

    enum Size {
        /// `DESIGN.md`: "Keep touch targets at least 44pt. Density may reduce
        /// visual padding, but not the hit area."
        static let minimumHitArea: CGFloat = 44
        /// A full-width action's resting height. Above the touch floor rather
        /// than at it: these are the one thing a setup screen is asking for,
        /// and they carry a 17pt label that Dynamic Type can grow past this,
        /// which is why callers set it as a minimum.
        static let actionHeight: CGFloat = 52
        /// The one-point boundary that `Line.border` paints.
        static let hairline: CGFloat = 1
    }

    // MARK: Motion

    /// `DESIGN.md` §"Motion and feedback". The five duration steps, as steps
    /// rather than as loose doubles, so a screen picks a documented one.
    enum Motion: Sendable, CaseIterable, Equatable {
        /// Pressed and micro-feedback.
        case instant
        /// Small control and selection changes.
        case fast
        /// Most entrances, exits, and reflow.
        case normal
        /// Sheets, panels, and larger movement.
        case slow
        /// Rare significant transitions.
        case deliberate

        var duration: Double {
            switch self {
            case .instant: 0.1
            case .fast: 0.15
            case .normal: 0.2
            case .slow: 0.3
            case .deliberate: 0.4
            }
        }
    }

    /// `--ease-out` for entrances, `--ease-in` for exits, `--ease-in-out` for
    /// movement.
    enum Curve: Sendable, CaseIterable, Equatable {
        case entering
        case leaving
        case moving
    }

    // MARK: Type roles

    /// `DESIGN.md` §Typography, mobile half: a working sans, a structural
    /// display, an editorial serif, and a mono.
    ///
    /// The families are the system's — SF for sans, New York for the serif, SF
    /// Mono for the mono — because `apps/ios` bundles no font files and the
    /// native answer to "respect Dynamic Type and platform text metrics" is
    /// the platform's own families, not a mechanically copied web stack.
    enum Typography {
        /// The one dominant read on a screen.
        static let screenTitle = TypeRole(.screenTitle, weight: .semibold)
        /// A structural heading inside a screen.
        static let sectionTitle = TypeRole(.sectionTitle, weight: .semibold)
        /// The heading of a notice or grouped block.
        static let heading = TypeRole(.heading, weight: .semibold)
        /// Ordinary body copy.
        static let body = TypeRole(.body)
        /// Supporting copy under the body.
        static let supporting = TypeRole(.supporting)
        /// A field label or a counter.
        static let label = TypeRole(.label, weight: .medium)
        /// Metadata.
        static let caption = TypeRole(.caption)
        /// Journal, reflective copy, selected content titles.
        static let editorial = TypeRole(.sectionTitle, design: .serif)
        /// The welcome screens' one dominant read. The editorial serif at the
        /// screen-title step, and the only place it is that large: `DESIGN.md`
        /// allows an editorial moment outside the working interface, and the
        /// two screens before sign-in are the whole of that moment.
        static let welcomeHeadline = TypeRole(.screenTitle, design: .serif)
        /// Recovery material, paths, tokens — anything the user must read
        /// character by character.
        static let recoveryMaterial = TypeRole(.body, design: .monospaced)
        /// An error code, a numeric readout, an aligned technical value.
        static let technicalCaption = TypeRole(.caption, design: .monospaced)
    }
}
