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
        /// A note body's own level-one heading.
        ///
        /// Below `screenTitle` on purpose: the note **title** is the dominant
        /// read on a note screen, and a body heading that matched it would
        /// give the screen two. Added for the six editor heading levels
        /// (`DESIGN.md` "Notes and editor").
        case documentTitle
        /// A structural heading inside a screen.
        case sectionTitle
        /// The step between `sectionTitle` and `heading`, which the six
        /// editor heading levels need and no chrome surface did.
        case subsectionTitle
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
            case .documentTitle: .title
            case .sectionTitle: .title2
            case .subsectionTitle: .title3
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
            case .documentTitle: .title1
            case .sectionTitle: .title2
            case .subsectionTitle: .title3
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
        /// Tint-derived ink, for a link inside running text.
        ///
        /// **Not `Tint.base`.** The accent is a fill at 2.80:1 on the light
        /// canvas and cannot carry text; a wiki link painted with it would be
        /// the accent failing AA on the one surface it is read on most. This
        /// is the same hue darkened until it clears 4.5:1, so a link still
        /// reads as Memry's orange rather than as the platform blue.
        static let tint = AdaptiveColor(light: 0xB4_43_09, dark: 0xF4_A2_62)
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
        /// The resting height of a capsule property: a task's detail pills,
        /// the composer's chips, a filter preset. Visual only: each keeps a
        /// `minimumHitArea` frame around it, and Dynamic Type grows it.
        static let pill: CGFloat = 32
        /// A note cover's resting height. Tall enough to read as an image and
        /// short enough that the title stays the dominant read on the screen
        /// (`DESIGN.md`: "one dominant read").
        static let coverHeight: CGFloat = 160
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

        /// The six heading levels a note body can hold.
        ///
        /// `DESIGN.md` "Notes and editor" gives the editor six levels at
        /// weight 600, descending from `1.875em` to `0.875em`. The body used
        /// to clamp them to three, which is the **content** losing structure
        /// to fit the ramp; the ramp extends instead. A level outside 1...6 is
        /// the document's problem, and the caller clamps it the way
        /// `extract_text` clamps its `#` run (chapter 12 §12.1.3).
        ///
        /// Six distinct Dynamic Type steps, so every level is visibly its own
        /// level and all six still scale. `DesignTokensTests` measures that
        /// they are six sizes and not five.
        ///
        /// Level five is the `label` step and **not** `body`: `.headline` and
        /// `.body` are both 17pt at the default category, so a level-four and
        /// a level-five heading would have rendered identically at the same
        /// weight — the clamp this task removed, reintroduced one level down.
        static let bodyHeadings: [TypeRole] = [
            TypeRole(.documentTitle, weight: .semibold),
            TypeRole(.sectionTitle, weight: .semibold),
            TypeRole(.subsectionTitle, weight: .semibold),
            TypeRole(.heading, weight: .semibold),
            TypeRole(.label, weight: .semibold),
            TypeRole(.supporting, weight: .semibold)
        ]

        /// The role for a heading level, clamped into 1...6.
        static func bodyHeading(level: Int) -> TypeRole {
            bodyHeadings[min(max(level, 1), bodyHeadings.count) - 1]
        }
    }

    // MARK: Note content colours

    /// The nine named colours a note's text and blocks can carry.
    ///
    /// **These are BlockNote's colour *names*, not BlockNote's hex values,
    /// and the difference is accessibility rather than taste.** BlockNote
    /// paints `gray` text as `#9b9a97`, which is 2.6:1 on white and fails
    /// FR-077 outright; four of its nine inks fail. `DESIGN.md` also says
    /// mobile preserves desktop's *roles* rather than copying its pixels. So
    /// each name maps onto an adaptive pair chosen to keep the hue
    /// recognisable and clear 4.5:1, and `DesignTokensTests` measures every
    /// ink against every fill in both interface styles.
    ///
    /// An unknown name answers `nil` rather than a guess: a colour a later
    /// schema adds should leave the text in the ordinary ink, not paint it
    /// something arbitrary.
    enum Content {
        /// A named text colour. `nil` for `default` and for any name this
        /// build does not know.
        static func ink(named name: String) -> AdaptiveColor? { inks[name] }

        /// A named block or cell background. `nil` for `default` and unknown.
        static func fill(named name: String) -> AdaptiveColor? { fills[name] }

        /// Every name this build knows, for the suite to enumerate.
        static let names = [
            "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"
        ]

        private static let inks: [String: AdaptiveColor] = [
            "gray": AdaptiveColor(light: 0x5F_5E_5B, dark: 0xA8_A6_A2),
            "brown": AdaptiveColor(light: 0x6B_4A_3A, dark: 0xCC_A4_8C),
            "red": AdaptiveColor(light: 0xB3_26_1E, dark: 0xFF_8A_80),
            "orange": AdaptiveColor(light: 0x8A_4D_00, dark: 0xE9_A2_4A),
            "yellow": AdaptiveColor(light: 0x6F_53_00, dark: 0xD4_B4_4A),
            "green": AdaptiveColor(light: 0x3D_5A_55, dark: 0x8F_BD_B4),
            "blue": AdaptiveColor(light: 0x0B_5E_86, dark: 0x6F_B8_D9),
            "purple": AdaptiveColor(light: 0x5B_3A_96, dark: 0xBC_A0_E8),
            "pink": AdaptiveColor(light: 0x97_14_5F, dark: 0xF0_93_C4)
        ]

        /// The light halves are BlockNote's own pale fills, which are quiet
        /// enough already; the dark halves are the same hues taken down far
        /// enough for the dark ink ramp to read on them.
        private static let fills: [String: AdaptiveColor] = [
            "gray": AdaptiveColor(light: 0xEB_EC_ED, dark: 0x2E_2E_30),
            "brown": AdaptiveColor(light: 0xE9_E5_E3, dark: 0x33_2A_25),
            "red": AdaptiveColor(light: 0xFB_E4_E4, dark: 0x3A_23_22),
            "orange": AdaptiveColor(light: 0xF6_E9_D9, dark: 0x35_29_1A),
            "yellow": AdaptiveColor(light: 0xFB_F3_DB, dark: 0x33_2C_18),
            "green": AdaptiveColor(light: 0xDD_ED_EA, dark: 0x1F_2E_2C),
            "blue": AdaptiveColor(light: 0xDD_EB_F1, dark: 0x1B_2B_33),
            "purple": AdaptiveColor(light: 0xEA_E4_F2, dark: 0x2B_23_36),
            "pink": AdaptiveColor(light: 0xF4_DF_EB, dark: 0x34_20_2B)
        ]
    }

    /// The tag and property-option palette, ported from
    /// `packages/contracts/src/tag-colors.ts` — the one palette every surface
    /// paints chips from, so a tag orange on desktop is orange here. One hex
    /// per name, used as the label and at `chipFillAlpha` as the fill.
    /// Task domain colour (desktop `--task-*`, `base.css:1631-1665` light and
    /// `:1903-1935` dark). Domain meaning only: priority, due state,
    /// completion, repeat and quick-add tokens. Every use pairs the colour with
    /// an icon or text (DESIGN.md: colour is never the only cue).
    enum Task {
        static let priorityUrgent = AdaptiveColor(light: 0xE7_14_14, dark: 0xEF_44_44)
        static let priorityHigh = AdaptiveColor(light: 0xC3_53_05, dark: 0xFB_92_3C)
        static let priorityMedium = AdaptiveColor(light: 0x73_73_7E, dark: 0xA0_A0_A8)
        static let priorityLow = AdaptiveColor(light: 0x50_50_5A, dark: 0x8A_8A_94)
        static let dueOverdue = AdaptiveColor(light: 0xDC_26_26, dark: 0xF8_71_71)
        static let dueToday = AdaptiveColor(light: 0xB4_5F_06, dark: 0xFB_BF_24)
        static let dueTomorrow = AdaptiveColor(light: 0x25_63_EB, dark: 0x60_A5_FA)
        static let dueUpcoming = AdaptiveColor(light: 0x4F_46_E5, dark: 0x81_8C_F8)
        static let complete = AdaptiveColor(light: 0x15_80_3D, dark: 0x4A_DE_80)
        static let progress = AdaptiveColor(light: 0x19_6C_F4, dark: 0x60_A5_FA)
        static let repeatMark = AdaptiveColor(light: 0x25_63_EB, dark: 0x60_A5_FA)
        static let star = AdaptiveColor(light: 0xB4_5F_06, dark: 0xFB_BF_24)
        static let tokenDate = AdaptiveColor(light: 0xB4_5F_06, dark: 0xFB_BF_24)
        static let tokenProject = AdaptiveColor(light: 0x25_63_EB, dark: 0x93_C5_FD)
        static let tokenTag = AdaptiveColor(light: 0x7C_3A_ED, dark: 0xA7_8B_FA)
        static let tokenNote = AdaptiveColor(light: 0x0B_81_77, dark: 0x2D_D4_BF)

        /// 0 none .. 4 urgent, desktop's `priorityConfig` colours.
        static func priority(_ value: Int64) -> AdaptiveColor {
            switch value {
            case 4: priorityUrgent
            case 3: priorityHigh
            case 2: priorityMedium
            default: priorityLow
            }
        }
    }

    enum Palette {
        static let chipFillAlpha = 0.12

        /// In the contract's order, which the default-colour hash indexes.
        static let names = [
            "rose", "coral", "tangerine", "amber", "lemon", "sage", "emerald",
            "mint", "teal", "cyan", "sky", "cobalt", "indigo", "violet",
            "plum", "magenta", "slate", "sand", "stone", "mauve"
        ]

        private static let hex: [String: UInt32] = [
            "rose": 0xE0_78_88, "coral": 0xD8_84_6C, "tangerine": 0xCC_94_56,
            "amber": 0xC4_A4_4E, "lemon": 0xB8_B4_4C, "sage": 0x7C_B8_6C,
            "emerald": 0x50_B8_88, "mint": 0x4C_C0_AC, "teal": 0x4A_B8_BE,
            "cyan": 0x52_AA_CC, "sky": 0x64_A0_D8, "cobalt": 0x74_8C_E0,
            "indigo": 0x8A_7C_D6, "violet": 0xA4_70_D0, "plum": 0xC0_6C_B0,
            "magenta": 0xD4_6C_96, "slate": 0x84_94_A8, "sand": 0xAD_A0_88,
            "stone": 0x94_94_90, "mauve": 0xA4_94_AA
        ]

        /// `getTagColors`: a palette name wins, a `#rrggbb` is used as-is,
        /// and anything else takes the colour the name hashes to.
        static func color(_ value: String?, tag: String? = nil) -> Color {
            if let value, let rgb = hex[value] { return rgbColor(rgb) }
            if let value, value.count == 7, value.hasPrefix("#"),
               let rgb = UInt32(value.dropFirst(), radix: 16) {
                return rgbColor(rgb)
            }
            if let tag { return rgbColor(hex[defaultName(for: tag)] ?? 0x94_94_90) }
            return rgbColor(0x94_94_90)
        }

        /// `defaultTagColorName`, byte for byte: JavaScript's `hash * 31 +
        /// charCodeAt` over UTF-16 units with 32-bit wrap, then
        /// `Math.abs(hash) % 20`. Two devices that fold a name differently
        /// disagree about the colour of every tag nobody picked one for.
        static func defaultName(for tag: String) -> String {
            var hash: Int32 = 0
            for unit in tag.lowercased().utf16 {
                hash = hash &* 31 &+ Int32(unit)
            }
            let index = Int(Int64(hash).magnitude % UInt64(names.count))
            return names[index]
        }

        private static func rgbColor(_ rgb: UInt32) -> Color {
            Color(
                red: Double((rgb >> 16) & 0xFF) / 255,
                green: Double((rgb >> 8) & 0xFF) / 255,
                blue: Double(rgb & 0xFF) / 255
            )
        }
    }

    /// Code token colours: shiki's `github-light` and `github-dark`, the two
    /// themes desktop's code blocks highlight with
    /// (`packages/editor-schema/src/code-block.ts`), so a code block reads the
    /// same on both surfaces.
    enum Code {
        static let keyword = AdaptiveColor(light: 0xD7_3A_49, dark: 0xF9_75_83)
        static let function = AdaptiveColor(light: 0x6F_42_C1, dark: 0xB3_92_F0)
        static let string = AdaptiveColor(light: 0x03_2F_62, dark: 0x9E_CB_FF)
        static let constant = AdaptiveColor(light: 0x00_5C_C5, dark: 0x79_B8_FF)
        static let variable = AdaptiveColor(light: 0xE3_62_09, dark: 0xFF_AB_70)
        static let comment = AdaptiveColor(light: 0x6A_73_7D, dark: 0x6A_73_7D)
        static let plain = AdaptiveColor(light: 0x24_29_2E, dark: 0xE1_E4_E8)
    }
}
