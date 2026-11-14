import UIKit

/// The window something is shown from (#4344).
///
/// An iPadOS window can sit beside another app's, and the frontmost one is
/// not always ours: `isKeyWindow` on every window can be `false` while Memry
/// is on screen. Picking "the key window" then found nothing, and Google
/// sign-in fell back to an empty anchor and failed as `browserUnavailable`.
/// The order is the key window of the scene in front, then that scene's
/// first window. A scene in front but inactive (Control Center pulled over
/// it) counts after an active one. A UIKit view asks its own `window`
/// instead; none of the callers here holds one.
@MainActor
enum PresentingWindow {
    static func resolve() -> UIWindow? {
        let windowScenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for state in [UIScene.ActivationState.foregroundActive, .foregroundInactive] {
            for scene in windowScenes where scene.activationState == state {
                if let window = scene.keyWindow ?? scene.windows.first { return window }
            }
        }
        return nil
    }

    /// The keyboard's end frame in `window`'s coordinates, or `nil` when it
    /// belongs to another screen's keyboard. A keyboard notification names
    /// its screen as the object and gives the frame in that screen's
    /// coordinates, which are not a resized window's.
    static func keyboardFrame(_ frame: CGRect, on screen: UIScreen?, in window: UIWindow) -> CGRect? {
        guard let screen, screen === window.windowScene?.screen else { return nil }
        return window.convert(frame, from: screen.coordinateSpace)
    }
}
