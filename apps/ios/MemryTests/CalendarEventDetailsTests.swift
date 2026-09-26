import EventKit
import Foundation
import Testing

@testable import Memry

// Spec 007 CL051/CL064: the read-only sheet's details, restated from desktop
// `eventkit-details.ts` and `calendar-subscribed-event-popover.tsx`.

@Suite("Calendar read-only details — spec 007 CL051")
struct CalendarEventDetailsTests {
    private func event(notes: String? = nil, url: String? = nil, location: String? = nil) -> EKEvent {
        let event = EKEvent(eventStore: EKEventStore())
        event.notes = notes
        event.url = url.flatMap(URL.init(string:))
        event.location = location
        return event
    }

    @Test func a_zoom_link_in_the_notes_is_the_call_with_its_phone_line() {
        let json = CalendarEventKitDetails.conference(
            event(notes: "Join https://zoom.us/j/123?pwd=x or tel:+1-204-555-0100;714957213#")
        )
        #expect(CalendarEventMetadata.conferenceName(json) == "Zoom")
        let join = CalendarEventMetadata.joinURL(json)
        #expect(join?.absoluteString == "https://zoom.us/j/123?pwd=x")
        #expect(join.map(CalendarEventMetadata.joinLabel) == "zoom.us/j/123")
        let phone = CalendarEventMetadata.phone(json)
        #expect(phone?.number == "+1-204-555-0100")
        #expect(phone?.pin == "714957213#")
    }

    @Test func no_known_service_means_no_call() {
        #expect(CalendarEventKitDetails.conference(event(url: "https://example.com/meet")) == nil)
    }

    @Test func alerts_are_minutes_before_soonest_last() {
        let item = event()
        item.addAlarm(EKAlarm(relativeOffset: -600))
        item.addAlarm(EKAlarm(relativeOffset: -3600))
        item.addAlarm(EKAlarm(relativeOffset: -600))
        #expect(CalendarEventMetadata.reminders(CalendarEventKitDetails.reminders(item))?.minutes == [60, 10])
        #expect(CalendarEventKitDetails.reminders(event()) == nil)
    }

    @Test func an_eventkit_rule_reads_as_desktop_describes_it() {
        let item = event()
        let rule = EKRecurrenceRule(
            recurrenceWith: .weekly, interval: 2,
            daysOfTheWeek: [EKRecurrenceDayOfWeek(.tuesday)], daysOfTheMonth: nil, monthsOfTheYear: nil,
            weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: nil
        )
        item.addRecurrenceRule(rule)
        let json = CalendarEventKitDetails.recurrence(item)
        let tuesday = Calendar.current.shortWeekdaySymbols[2]
        #expect(CalendarEventMetadata.recurrence(json) == "Repeats every 2 weeks on \(tuesday)")
        #expect(CalendarEventMetadata.recurrence(#"{"rrule":["RRULE:FREQ=DAILY"]}"#) == "Repeats every day")
    }
}
