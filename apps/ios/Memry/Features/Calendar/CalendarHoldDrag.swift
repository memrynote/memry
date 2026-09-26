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

struct CalendarHoldDrag: UIGestureRecognizerRepresentable {
    enum Phase: Equatable {
        /// The hold landed at `location`.
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

    final class Coordinator {
        var start: CGPoint = .zero
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let recognizer = UILongPressGestureRecognizer()
        recognizer.minimumPressDuration = minimumDuration
        recognizer.cancelsTouchesInView = false
        recognizer.isEnabled = isEnabled
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        recognizer.minimumPressDuration = minimumDuration
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        let location = space.map { context.converter.location(in: $0) } ?? context.converter.localLocation
        switch recognizer.state {
        case .began:
            context.coordinator.start = location
            action(.began(location))
        case .changed:
            action(.changed(start: context.coordinator.start, location: location))
        case .ended:
            action(.ended(start: context.coordinator.start, location: location, completed: true))
        case .cancelled, .failed:
            action(.ended(start: context.coordinator.start, location: location, completed: false))
        default:
            break
        }
    }
}
