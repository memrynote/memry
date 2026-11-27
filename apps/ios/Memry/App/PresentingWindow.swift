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

    /// Whether anything is presented over `window`: a sheet, the search
    /// palette, an alert or a menu, from its root controller or any child.
    static func isPresenting(over window: UIWindow) -> Bool {
        window.rootViewController.map { presents($0, countingDismissals: true) } == true
    }

    /// As `isPresenting`, less a controller already on its way out.
    static func keepsPresenting(over window: UIWindow) -> Bool {
        window.rootViewController.map { presents($0, countingDismissals: false) } == true
    }

    private static func presents(_ controller: UIViewController, countingDismissals: Bool) -> Bool {
        if let presented = controller.presentedViewController, countingDismissals || !presented.isBeingDismissed {
            return true
        }
        return controller.children.contains { presents($0, countingDismissals: countingDismissals) }
    }
}
