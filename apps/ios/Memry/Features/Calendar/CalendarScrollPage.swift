import SwiftUI
import UIKit

// #4499. Week, Month and Year page on a horizontal drag. A trackpad's
// two-finger swipe arrives as scroll events, which a SwiftUI `DragGesture`
// never sees, so these views also page on a pan that takes scroll events only.
// It takes no touches, so touch paging is unchanged, and it recognises
// alongside the grids' own vertical scrolling. Day pages through a paging
// `ScrollView`, which already takes scroll events.

/// When a horizontal swipe turns the page: `1` for the next period, `-1` for
/// the previous one, `nil` when it is mostly vertical or too short.
enum CalendarSwipe {
    /// A touch drag. Its `DragGesture(minimumDistance: 30)` already measured
    /// 30 pt in a straight line, so only the direction is checked here.
    static func touchStep(_ translation: CGSize) -> Int? {
        guard abs(translation.width) > abs(translation.height) * 1.5 else { return nil }
        return translation.width < 0 ? 1 : -1
    }

    /// A trackpad scroll, which has no minimum distance of its own: 30 pt
    /// across as well.
    static func scrollStep(_ translation: CGSize) -> Int? {
        abs(translation.width) > 30 ? touchStep(translation) : nil
    }
}

struct CalendarScrollPage: UIGestureRecognizerRepresentable {
    let page: (Int) -> Void

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool { true }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.allowedTouchTypes = []
        recognizer.allowedScrollTypesMask = .continuous
        recognizer.cancelsTouchesInView = false
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        guard recognizer.state == .ended else { return }
        let moved = recognizer.translation(in: recognizer.view)
        if let step = CalendarSwipe.scrollStep(CGSize(width: moved.x, height: moved.y)) { page(step) }
    }
}
