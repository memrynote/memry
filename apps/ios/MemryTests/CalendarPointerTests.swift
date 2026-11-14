import CoreGraphics
import Testing
import UIKit

@testable import Memry

// #4356 and #4499: a pointer drags on the grid without the touch hold, and a
// trackpad swipe turns the page by the same rule as a touch drag.

@MainActor
struct CalendarPointerTests {
    @Test func a_pointer_drag_starts_where_the_click_went_down() {
        let tracker = CalendarDragTracker()
        let began = tracker.phases(.began, location: CGPoint(x: 40, y: 112), translation: CGPoint(x: 0, y: 12))
        #expect(began == [
            .began(CGPoint(x: 40, y: 100)),
            .changed(start: CGPoint(x: 40, y: 100), location: CGPoint(x: 40, y: 112)),
        ])
        #expect(tracker.phases(.changed, location: CGPoint(x: 40, y: 160))
            == [.changed(start: CGPoint(x: 40, y: 100), location: CGPoint(x: 40, y: 160))])
        #expect(tracker.phases(.ended, location: CGPoint(x: 40, y: 160))
            == [.ended(start: CGPoint(x: 40, y: 100), location: CGPoint(x: 40, y: 160), completed: true)])
    }

    @Test func a_touch_hold_begins_in_place_and_a_cancel_does_not_complete() {
        let tracker = CalendarDragTracker()
        #expect(tracker.phases(.began, location: CGPoint(x: 10, y: 20)) == [.began(CGPoint(x: 10, y: 20))])
        #expect(tracker.phases(.cancelled, location: CGPoint(x: 10, y: 50))
            == [.ended(start: CGPoint(x: 10, y: 20), location: CGPoint(x: 10, y: 50), completed: false)])
        #expect(tracker.phases(.possible, location: .zero).isEmpty)
    }

    @Test func a_horizontal_swipe_pages_forward_or_back() {
        #expect(CalendarSwipe.step(CGSize(width: -80, height: 10)) == 1)
        #expect(CalendarSwipe.step(CGSize(width: 80, height: -10)) == -1)
    }

    @Test func a_short_or_mostly_vertical_swipe_stays_on_the_page() {
        #expect(CalendarSwipe.step(CGSize(width: -25, height: 0)) == nil)
        #expect(CalendarSwipe.step(CGSize(width: -80, height: 60)) == nil)
        #expect(CalendarSwipe.step(CGSize(width: 0, height: -200)) == nil)
    }
}
