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
