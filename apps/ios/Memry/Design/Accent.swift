import Observation
import SwiftUI
import Synchronization

// Spec 006 F6/F7. The user's accent and colour mode, applied app-wide.
//
// **The accent tints fills only** (DESIGN.md "The tint fills; it does not
// carry contrast"). From one chosen hex this derives the two inks a surface
// can put text in: `ink` (tinted text on the canvas, ≥ 4.5:1 in each style)
// and `foreground` (a label on the tint fill: ink or white, whichever
// contrasts more). The default orange keeps its hand-picked `#B44309` ink.

enum AccentColor {
    static let defaultHex = "#f97316"

    /// Desktop `appearance-section.tsx` presets, in its order.
    static let presets: [(name: String, hex: String)] = [
        ("Indigo", "#6366f1"), ("Amber", "#f59e0b"), ("Emerald", "#10b981"), ("Red", "#ef4444"),
        ("Violet", "#8b5cf6"), ("Cyan", "#06b6d4"), ("Pink", "#ec4899"), ("Orange", "#f97316")
    ]

    /// `#rrggbb`, lowercased, or `nil` for anything else.
    static func normalized(_ value: String) -> String? {
        var text = value.trimmingCharacters(in: .whitespaces).lowercased()
        if !text.hasPrefix("#") { text = "#" + text }
        guard text.count == 7, UInt32(text.dropFirst(), radix: 16) != nil else { return nil }
        return text
    }

    static func rgb(_ hex: String) -> UInt32 {
        normalized(hex).flatMap { UInt32($0.dropFirst(), radix: 16) } ?? 0xF9_73_16
    }

    static func hex(of color: Color) -> String? {
        let resolved = color.resolve(in: EnvironmentValues())
        let clamp = { (value: Float) in UInt32(max(0, min(255, (value * 255).rounded()))) }
        let rgb = clamp(resolved.red) << 16 | clamp(resolved.green) << 8 | clamp(resolved.blue)
        return String(format: "#%06x", rgb)
    }

    /// The tint and its two inks.
    struct Palette: Sendable, Equatable {
        let fill: AdaptiveColor
        let ink: AdaptiveColor
        let foreground: AdaptiveColor
    }

    static func palette(for hex: String) -> Palette {
        let value = rgb(hex)
        if value == 0xF9_73_16 {
            return Palette(
                fill: AdaptiveColor(light: value, dark: value),
                ink: AdaptiveColor(light: 0xB4_43_09, dark: 0xF4_A2_62),
                foreground: AdaptiveColor(light: 0x1A_1A_1A, dark: 0x1A_1A_1A)
            )
        }
        let light = shade(value, toward: 0x00_00_00, against: 0xFF_FF_FF)
        let dark = shade(value, toward: 0xFF_FF_FF, against: 0x12_12_12)
        let onFill: UInt32 = contrast(value, 0x1A_1A_1A) >= contrast(value, 0xFF_FF_FF) ? 0x1A_1A_1A : 0xFF_FF_FF
        return Palette(
            fill: AdaptiveColor(light: value, dark: value),
            ink: AdaptiveColor(light: light, dark: dark),
            foreground: AdaptiveColor(light: onFill, dark: onFill)
        )
    }

    static func contrast(_ one: UInt32, _ other: UInt32) -> Double {
        AdaptiveColor.RGB.contrast(AdaptiveColor.RGB(hex: one), AdaptiveColor.RGB(hex: other))
    }

    /// Mixes `color` toward `target` in 5 % steps until it clears 4.5:1 on
    /// `surface` (with margin for the other surfaces of that style).
    static func shade(_ color: UInt32, toward target: UInt32, against surface: UInt32) -> UInt32 {
        var step = 0.0
        var mixed = color
        while contrast(mixed, surface) < 4.8, step < 1 {
            step += 0.05
            mixed = mix(color, target, step)
        }
        return mixed
    }

    private static func mix(_ a: UInt32, _ b: UInt32, _ t: Double) -> UInt32 {
        func channel(_ shift: UInt32) -> UInt32 {
            let x = Double((a >> shift) & 0xFF), y = Double((b >> shift) & 0xFF)
            return UInt32((x + (y - x) * t).rounded()) << shift
        }
        return channel(16) | channel(8) | channel(0)
    }
}

/// The accent the tokens read. Written by `AppearanceState`, read at render.
enum AccentRuntime {
    private static let current = Mutex(AccentColor.palette(for: AccentColor.defaultHex))
    static var palette: AccentColor.Palette { current.withLock { $0 } }
    static func set(_ palette: AccentColor.Palette) { current.withLock { $0 = palette } }
}

/// What the root view applies: colour scheme and accent (F6/F7).
@MainActor
@Observable
final class AppearanceState {
    static let shared = AppearanceState()

    private(set) var theme: ThemeChoice = .system
    private(set) var accentHex = AccentColor.defaultHex

    /// `nil` follows the system. Warm and White are both the light palette
    /// (the tokens carry one light canvas, `#FFFFFF`; spec 006 §6).
    var colorScheme: ColorScheme? {
        switch theme {
        case .system: nil
        case .light, .white: .light
        case .dark: .dark
        }
    }

    /// The system tint: menu pickers and links draw text in it, so it is the
    /// contrast-safe ink; switches set the fill themselves (rule 6).
    var tint: Color { AccentRuntime.palette.ink.color }

    func update(from store: SettingsStore) {
        theme = store.theme
        if accentHex != store.accentHex {
            accentHex = store.accentHex
            AccentRuntime.set(AccentColor.palette(for: accentHex))
        }
    }
}

extension View {
    /// Applies the user's colour mode and accent to everything under it.
    func memryAppearance() -> some View {
        modifier(AppearanceModifier())
    }
}

private struct AppearanceModifier: ViewModifier {
    @State private var state = AppearanceState.shared

    func body(content: Content) -> some View {
        content
            .preferredColorScheme(state.colorScheme)
            .tint(state.tint)
            // Memry-drawn fills read the accent at render; a change re-renders
            // the tree under this key (navigation state is kept by the stacks).
            .environment(\.accentHex, state.accentHex)
    }
}

extension EnvironmentValues {
    @Entry var accentHex: String = AccentColor.defaultHex
}
