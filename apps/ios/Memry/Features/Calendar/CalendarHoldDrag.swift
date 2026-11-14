import SwiftUI
import UIKit

// Spec 007 CL040/CL044. Hold, then drag, without stealing the scroll.
//
// A SwiftUI `LongPressGesture.sequenced(before: DragGesture)` on scroll content
// keeps the enclosing ScrollView from panning at all (seen on iOS 26: the Day
// and Week grids would not scroll or page). A UIKit long-press recogniser
// fails as soon as the finger travels before the hold lands, which leaves the
// pan to the scroll view, and once it lands it keeps reporting the finger
// until it lifts — the whole hold + drag in one recogniser.
//
// A pointer has no scroll to protect: it scrolls with two fingers or a wheel,
// which arrive as scroll events, not touches. So a click-and-drag starts the
// same drag at once (#4356), as desktop's grid does, and the hold stays a
// touch gesture. Attach both with `calendarHoldDrag(_:)`.

struct CalendarHoldDrag: UIGestureRecognizerRepresentable {
    enum Phase: Equatable {
        /// The hold landed, or a pointer drag left, at `location`.
        case began(CGPoint)
        /// The finger moved: where it started and where it is now.
        case changed(start: CGPoint, location: CGPoint)
        /// Lifted (`true`) or cancelled (`false`).
        case ended(start: CGPoint, location: CGPoint, completed: Bool)
    }

    var minimumDuration: TimeInterval = 0.35
    /// Locations are reported in this named space, else the view's own.
    var space: NamedCoordinateSpace?
    var isEnabled = true
    let action: (Phase) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> CalendarDragTracker { CalendarDragTracker() }

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let recognizer = UILongPressGestureRecognizer()
        recognizer.minimumPressDuration = minimumDuration
        recognizer.cancelsTouchesInView = false
        recognizer.allowedTouchTypes = [UITouch.TouchType.direct, .pencil].map { NSNumber(value: $0.rawValue) }
        recognizer.isEnabled = isEnabled
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        recognizer.minimumPressDuration = minimumDuration
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        let location = space.map { context.converter.location(in: $0) } ?? context.converter.localLocation
        context.coordinator.phases(recognizer.state, location: location).forEach(action)
    }
}

/// The pointer's half of a hold-drag: a click-and-drag with no hold.
struct CalendarPointerDrag: UIGestureRecognizerRepresentable {
    let hold: CalendarHoldDrag

    func makeCoordinator(converter: CoordinateSpaceConverter) -> CalendarDragTracker { CalendarDragTracker() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.cancelsTouchesInView = false
        recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        recognizer.isEnabled = hold.isEnabled
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = hold.isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let location = hold.space.map { context.converter.location(in: $0) } ?? context.converter.localLocation
        let moved = recognizer.translation(in: recognizer.view)
        context.coordinator.phases(recognizer.state, location: location, translation: moved).forEach(hold.action)
    }
}

/// A secondary click (#4356): the pointer's way to a menu that touch reaches
/// by holding still, where the hold also starts a drag and so cannot be a
/// `.contextMenu`.
struct CalendarSecondaryClick: UIGestureRecognizerRepresentable {
    let action: () -> Void

    func makeUIGestureRecognizer(context: Context) -> UITapGestureRecognizer {
        let recognizer = UITapGestureRecognizer()
        recognizer.buttonMaskRequired = .secondary
        recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UITapGestureRecognizer, context: Context) {
        if recognizer.state == .ended { action() }
    }
}

/// Turns a recogniser's states into `CalendarHoldDrag.Phase`s and remembers
/// where the drag started.
final class CalendarDragTracker {
    private(set) var start: CGPoint = .zero

    /// `translation` is how far the pointer had moved when its pan began: the
    /// drag starts where the click went down, not where the pan noticed it.
    func phases(
        _ state: UIGestureRecognizer.State,
        location: CGPoint,
        translation: CGPoint = .zero
    ) -> [CalendarHoldDrag.Phase] {
        switch state {
        case .began:
            start = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
            return translation == .zero ? [.began(start)] : [.began(start), .changed(start: start, location: location)]
        case .changed:
            return [.changed(start: start, location: location)]
        case .ended:
            return [.ended(start: start, location: location, completed: true)]
        case .cancelled, .failed:
            return [.ended(start: start, location: location, completed: false)]
        default:
            return []
        }
    }
}

extension View {
    /// A hold-then-drag for touch, and the same drag on a click-and-drag for
    /// a pointer.
    func calendarHoldDrag(_ hold: CalendarHoldDrag) -> some View {
        gesture(hold).gesture(CalendarPointerDrag(hold: hold))
    }
}
