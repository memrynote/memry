import CoreGraphics
import Testing
import UIKit

@testable import Memry

// #4356 and #4499: a pointer drags on the grid without the touch hold but
// never alongside it, and a trackpad swipe turns the page.

@MainActor
struct CalendarPointerTests {
    @Test func a_pointer_drag_starts_where_the_click_went_down() {
        let tracker = CalendarDragTracker(held: false)
        let began = tracker.phases(.began, location: CGPoint(x: 40, y: 112), translation: CGPoint(x: 0, y: 12))
        #expect(began == [
            .began(CGPoint(x: 40, y: 100)),
            .changed(start: CGPoint(x: 40, y: 100), location: CGPoint(x: 40, y: 112)),
        ])
        #expect(tracker.phases(.changed, location: CGPoint(x: 40, y: 160))
            == [.changed(start: CGPoint(x: 40, y: 100), location: CGPoint(x: 40, y: 160))])
        #expect(tracker.phases(.ended, location: CGPoint(x: 40, y: 160))
            == [.ended(start: CGPoint(x: 40, y: 100), location: CGPoint(x: 40, y: 160), completed: true, held: false)])
    }

    @Test func a_touch_hold_begins_in_place_and_a_cancel_does_not_complete() {
        let tracker = CalendarDragTracker(held: true)
        #expect(tracker.phases(.began, location: CGPoint(x: 10, y: 20)) == [.began(CGPoint(x: 10, y: 20))])
        #expect(tracker.phases(.cancelled, location: CGPoint(x: 10, y: 50))
            == [.ended(start: CGPoint(x: 10, y: 20), location: CGPoint(x: 10, y: 50), completed: false, held: true)])
        #expect(tracker.phases(.possible, location: .zero).isEmpty)
    }

    /// A click that holds still is the hold's, one that moves first is the
    /// drag's: the pointer's pan waits for its own hold to fail, so a hold
    /// that lands and then drags drives only the hold.
    @Test func a_pointer_drag_waits_for_its_own_hold_to_fail() {
        let link = CalendarHoldLink()
        let hold = UILongPressGestureRecognizer()
        let pan = UIPanGestureRecognizer()
        pan.delegate = link
        link.hold = hold
        #expect(link.gestureRecognizer(pan, shouldRequireFailureOf: hold))
        #expect(!link.gestureRecognizer(pan, shouldRequireFailureOf: UILongPressGestureRecognizer()))
    }

    @Test func a_horizontal_swipe_pages_forward_or_back() {
        #expect(CalendarSwipe.touchStep(CGSize(width: -80, height: 10)) == 1)
        #expect(CalendarSwipe.touchStep(CGSize(width: 80, height: -10)) == -1)
        #expect(CalendarSwipe.scrollStep(CGSize(width: -80, height: 10)) == 1)
    }

    /// `DragGesture(minimumDistance: 30)` measures the straight line, so a
    /// touch 28 across and 17 down (33 pt) pages, as it did before #4499.
    @Test func a_touch_swipe_pages_on_its_straight_line_distance() {
        #expect(CalendarSwipe.touchStep(CGSize(width: -28, height: 17)) == 1)
        #expect(CalendarSwipe.scrollStep(CGSize(width: -28, height: 17)) == nil)
    }

    @Test func a_short_or_mostly_vertical_swipe_stays_on_the_page() {
        #expect(CalendarSwipe.scrollStep(CGSize(width: -25, height: 0)) == nil)
        #expect(CalendarSwipe.touchStep(CGSize(width: -80, height: 60)) == nil)
        #expect(CalendarSwipe.scrollStep(CGSize(width: -80, height: 60)) == nil)
        #expect(CalendarSwipe.touchStep(CGSize(width: 0, height: -200)) == nil)
    }
}
