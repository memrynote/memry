import SwiftUI

// Calendar domain colour (spec 007 CL020, DESIGN.md "Domain color carries
// domain meaning"). Desktop's `--cal-<hue>-*` (`base.css:2697-2761`): one hue
// per item type, painted as a rail and a quiet surface; the title keeps ink
// and the time uses the hue's meta shade, which clears 4.5:1 on the surface in
// both styles (`DesignTokensTests.calendarMetaInksClearAA`). A Google colour
// on an event replaces the hue through the same rail / surface / meta shape.

extension Tokens {
    enum Calendar {
        /// One item hue: rail, surface under the chip, meta ink for its time.
        struct Hue: Sendable, Equatable {
            let rail: AdaptiveColor
            let surface: AdaptiveColor
            let meta: AdaptiveColor
        }

        /// Paper 01 draws the surface at ~9 % of the rail over the canvas.
        static let surfaceAlpha = 0.09
        /// Ended events and fired date reminders fade (Paper 01 "Lunch with
        /// Deniz", desktop `opacity-60`).
        static let endedOpacity = 0.6
        /// A chip's rail width and inset (Paper 01: 3pt, 3pt from the edge).
        static let railWidth: CGFloat = 3
        /// One hour of the time grid (Paper 01 `h-14`).
        static let hourHeight: CGFloat = 56
        /// The time gutter (Paper 01 `w-14`).
        static let gutterWidth: CGFloat = 56
        /// A chip's corner (Paper 01 `rounded-[6px]`).
        static let chipRadius: CGFloat = Tokens.Radius.small
        /// Narrower than this, a Week chip shows its rail only.
        static let compactTitleMinWidth: CGFloat = 20
        /// The now line (Paper 01: 2pt tint line, 8pt dot).
        static let nowLineWidth: CGFloat = 2
        static let nowDot: CGFloat = 8
        /// A week-strip / month day circle (Paper 01 `size-9`).
        static let dayCircle: CGFloat = 36
        /// The dots under a day (Paper 01 `w-1.25`).
        static let dot: CGFloat = 5

        static let indigo = Hue(
            rail: AdaptiveColor(light: 0x3E_63_DD, dark: 0x5B_7F_FF),
            surface: AdaptiveColor(light: 0xEC_EF_FB, dark: 0x1B_22_3C),
            meta: AdaptiveColor(light: 0x34_53_BD, dark: 0x9E_B1_FF)
        )
        static let violet = Hue(
            rail: AdaptiveColor(light: 0x8E_4E_C6, dark: 0xA8_75_E6),
            surface: AdaptiveColor(light: 0xF4_EE_F9, dark: 0x2A_20_33),
            meta: AdaptiveColor(light: 0x81_45_B5, dark: 0xD1_9D_FF)
        )
        static let green = Hue(
            rail: AdaptiveColor(light: 0x30_A4_6C, dark: 0x33_B0_74),
            surface: AdaptiveColor(light: 0xE8_F5_EF, dark: 0x16_2B_22),
            meta: AdaptiveColor(light: 0x18_74_4A, dark: 0x3D_D6_8C)
        )
        static let cyan = Hue(
            rail: AdaptiveColor(light: 0x00_A2_C7, dark: 0x23_AF_D0),
            surface: AdaptiveColor(light: 0xE6_F6_F9, dark: 0x13_2A_31),
            meta: AdaptiveColor(light: 0x0C_6F_88, dark: 0x4C_CC_E6)
        )
        static let amber = Hue(
            rail: AdaptiveColor(light: 0xF5_A5_24, dark: 0xFF_C5_3D),
            surface: AdaptiveColor(light: 0xFE_F4_E4, dark: 0x33_2A_16),
            meta: AdaptiveColor(light: 0x93_55_00, dark: 0xFF_CA_16)
        )
        static let pink = Hue(
            rail: AdaptiveColor(light: 0xD6_40_9F, dark: 0xE4_58_9F),
            surface: AdaptiveColor(light: 0xFB_EB_F5, dark: 0x33_1A_2B),
            meta: AdaptiveColor(light: 0xB8_24_7F, dark: 0xFF_8D_CC)
        )

        /// `EVENT_TYPE_HUES` (`lib/event-type-colors.ts`).
        static func hue(visualType: String) -> Hue {
            switch visualType {
            case "external_event": violet
            case "task": green
            case "reminder": cyan
            case "snooze": amber
            case "note", "note_date": pink
            default: indigo
            }
        }

        /// Google's eleven event colours (`calendar-colors.ts`
        /// `CALENDAR_EVENT_COLORS`), in the menu's order.
        static let eventColors: [(name: String, hex: UInt32)] = [
            ("tomato", 0xD5_00_00), ("flamingo", 0xE6_7C_73), ("tangerine", 0xF4_51_1E),
            ("banana", 0xF6_BF_26), ("sage", 0x33_B6_79), ("basil", 0x0B_80_43),
            ("peacock", 0x03_9B_E5), ("blueberry", 0x3F_51_B5), ("lavender", 0x79_86_CB),
            ("grape", 0x8E_24_AA), ("graphite", 0x61_61_61)
        ]

        /// A hue built from a display colour (an event's own, or its
        /// calendar's): the colour as the rail, a light wash as the surface,
        /// and an ink shaded from it until it clears AA on that surface.
        static func hue(hex: String) -> Hue? {
            guard let normalized = AccentColor.normalized(hex) else { return nil }
            let rgb = AccentColor.rgb(normalized)
            let lightSurface = mix(0xFF_FF_FF, rgb, surfaceAlpha)
            let darkSurface = mix(0x12_12_12, rgb, 0.18)
            return Hue(
                rail: AdaptiveColor(light: rgb, dark: rgb),
                surface: AdaptiveColor(light: lightSurface, dark: darkSurface),
                meta: AdaptiveColor(
                    light: AccentColor.shade(rgb, toward: 0x00_00_00, against: lightSurface),
                    dark: AccentColor.shade(rgb, toward: 0xFF_FF_FF, against: darkSurface)
                )
            )
        }

        static func mix(_ base: UInt32, _ over: UInt32, _ amount: Double) -> UInt32 {
            func channel(_ shift: UInt32) -> UInt32 {
                let x = Double((base >> shift) & 0xFF), y = Double((over >> shift) & 0xFF)
                return UInt32((x + (y - x) * amount).rounded()) << shift
            }
            return channel(16) | channel(8) | channel(0)
        }

        /// Chip title, time and label roles (Paper 12px / 11px).
        static let chipTitle = TypeRole(.caption, weight: .semibold)
        static let chipMeta = TypeRole(.micro)
        /// Year's mini-month digits (Paper 05, 10 px), scaling with Dynamic Type.
        static let yearDay = TypeRole(.micro)
        static let gutter = TypeRole(.micro)
        static let weekdayLetter = TypeRole(.micro, weight: .semibold)
    }
}
