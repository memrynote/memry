import SwiftUI

// Journal domain colour (spec 005-journal JP040/JP043/JP044/JP058).
//
// **Activity** is desktop's heatmap (`journal-entry-list-item.tsx`
// `HEATMAP_COLORS`, the GitHub greens Paper J05/J06 draw); dark mode takes the
// dark heatmap greens. A dot never carries meaning alone: every dot sits next
// to text (the preview, a count, "No entry").
//
// **Fog** is the date heading's time-of-day tint (`journal-date-display.tsx`
// `FOG_CONFIG`, hour buckets 5–12 morning, 12–18 afternoon, 18–21 evening,
// else night). Static here, drawn at `fogAlpha`, and absent under Reduce
// Transparency (DESIGN.md: the journal atmosphere stays on the journal).

extension Tokens {
    enum Journal {
        /// The day page's date title: the editorial serif at the largest
        /// Dynamic Type step (desktop 42px heading font, Paper J01).
        static let title = TypeRole(.screenTitle, design: .serif)

        static let activity1 = AdaptiveColor(light: 0x9B_E9_A8, dark: 0x0E_44_29)
        static let activity2 = AdaptiveColor(light: 0x40_C4_63, dark: 0x00_6D_32)
        static let activity3 = AdaptiveColor(light: 0x30_A1_4E, dark: 0x26_A6_41)
        static let activity4 = AdaptiveColor(light: 0x21_6E_39, dark: 0x39_D3_53)
        /// The hollow ring of a day with no characters.
        static let activityEmpty = AdaptiveColor(light: 0xC9_C6_C0, dark: 0x4A_4A_4A)

        /// Activity level 0-4 → its dot colour; 0 draws the hollow ring.
        static func activity(_ level: UInt8) -> AdaptiveColor {
            switch level {
            case 1: activity1
            case 2: activity2
            case 3: activity3
            case 4...: activity4
            default: activityEmpty
            }
        }

        static let fogMorning = AdaptiveColor(light: 0xD9_77_06, dark: 0xF5_9E_0B)
        static let fogAfternoon = AdaptiveColor(light: 0xEA_58_0C, dark: 0xF9_73_16)
        static let fogEvening = AdaptiveColor(light: 0x63_66_F1, dark: 0x81_8C_F8)
        static let fogNight = AdaptiveColor(light: 0x4F_46_E5, dark: 0x63_66_F1)
        /// Paper J01 draws the fog at 14–22 % over the canvas.
        static let fogAlpha: Double = 0.22

        /// Desktop's hour buckets.
        static func fog(hour: Int) -> AdaptiveColor {
            switch hour {
            case 5 ..< 12: fogMorning
            case 12 ..< 18: fogAfternoon
            case 18 ..< 21: fogEvening
            default: fogNight
            }
        }
    }
}
