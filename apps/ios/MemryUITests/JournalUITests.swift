import XCTest

// Spec 005-journal JP081: the Journal tab end to end on a real vault, with
// today pinned to an agent day in 2099 (`-MEMRY_JOURNAL_TODAY`).
//
// **Preconditions** (tasks.md §0.4): the simulator is signed in to the
// staging test account with the MemryNote vault, and the synced journal
// settings give Wednesday the `Agent Test Journal` template and leave the
// default template unset (JP049 set both; JP095 undoes them after the last
// run). A test that lands on sign-in fails with that instruction.
//
// Each run picks its own random day in the second half of 2099, so reruns
// rarely meet a day an earlier run wrote; the flows that need an empty day
// page forward until they find one.
@MainActor
final class JournalUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    // MARK: Flows

    func testJournalOpensOnTodayAndPagesToYesterdayAndBack() throws {
        let today = Self.randomDay()
        try openJournal(today: today)
        XCTAssertTrue(header.label.hasSuffix(", Today"), header.label)
        XCTAssertTrue(header.label.contains(Self.spoken(today)), header.label)

        app.buttons["journal.day.previous"].firstMatch.tap()
        XCTAssertTrue(waitUntil { self.header.label.hasSuffix(", Yesterday") }, header.label)
        app.buttons["journal.day.next"].firstMatch.tap()
        XCTAssertTrue(waitUntil { self.header.label.hasSuffix(", Today") }, header.label)
    }

    func testTypingOnAnEmptyDayCreatesItAndMonthShowsTheEntry() throws {
        try openJournal(today: Self.randomDay())
        let field = app.descendants(matching: .any)["journal.day.firstLine"].firstMatch
        for _ in 0 ..< 10 where !field.waitForExistence(timeout: 3) {
            app.buttons["journal.day.next"].firstMatch.tap()
        }
        XCTAssertTrue(field.exists, "no empty day within ten days")
        let date = try XCTUnwrap(shownDate())
        field.tap()
        field.typeText("[agent] ui journal line\n")
        XCTAssertTrue(
            anything(containing: "[agent] ui journal line").waitForExistence(timeout: 10),
            "the typed line did not become the entry"
        )

        titleMenu("journal.titleMenu.month")
        let row = app.buttons["journal.month.day.\(date)"].firstMatch
        scroll(to: row)
        XCTAssertTrue(waitUntil { row.label.contains(", entry, ") }, row.label)
    }

    func testMonthAndYearDrillDownAndBack() throws {
        let today = Self.randomDay()
        try openJournal(today: today)
        titleMenu("journal.titleMenu.year")
        let title = app.staticTexts["journal.calendar.title"].firstMatch
        XCTAssertTrue(waitUntil { title.label == "2099" }, title.label)

        let month = Int(today.split(separator: "-")[1]) ?? 7
        app.buttons["journal.year.month.\(month)"].firstMatch.tap()
        XCTAssertTrue(waitUntil { title.label == Self.monthName(month) }, title.label)
        let day = app.buttons["journal.month.day.\(today)"].firstMatch
        scroll(to: day)
        day.tap()
        XCTAssertTrue(waitUntil { self.header.label.hasSuffix(", Today") }, header.label)

        // The day hides the system Back (its bar holds ‹ ›); the title menu
        // climbs to Month, whose Back returns to Year.
        titleMenu("journal.titleMenu.month")
        XCTAssertTrue(waitUntil { title.label == Self.monthName(month) }, title.label)
        back()
        XCTAssertTrue(waitUntil { title.label == "2099" }, title.label)
    }

    func testAPresetReminderFillsTheBell() throws {
        try openJournal(today: Self.randomDay())
        let bell = app.buttons["journal.reminder.bell"].firstMatch
        XCTAssertTrue(bell.waitForExistence(timeout: 10))
        if !bell.label.hasPrefix("Reminder:") {
            bell.tap()
            let preset = app.buttons["journal.reminder.preset.in-one-week"].firstMatch
            XCTAssertTrue(preset.waitForExistence(timeout: 5))
            preset.tap()
        }
        XCTAssertTrue(waitUntil { bell.label.hasPrefix("Reminder:") }, bell.label)
    }

    func testAWednesdayOpensWithItsTemplateText() throws {
        try openJournal(today: Self.randomDay(weekday: 4))
        XCTAssertTrue(
            anything(containing: "check-in").waitForExistence(timeout: 20),
            "the Wednesday template was not seeded (precondition: Wednesday -> Agent Test Journal)"
        )
    }

    func testTheSettingsWeekdayRowReadsTheResolvedDefault() throws {
        try openJournal(today: Self.randomDay())
        app.buttons["journal.more"].firstMatch.tap()
        let settings = app.buttons["journal.more.settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        let monday = app.buttons["journal.settings.weekday.1"].firstMatch
        scroll(to: monday)
        XCTAssertTrue(waitUntil { monday.label.contains("Default · ") }, monday.label)
        let wednesday = app.buttons["journal.settings.weekday.3"].firstMatch
        XCTAssertTrue(wednesday.label.contains("Agent Test Journal"), wednesday.label)
    }

    // MARK: Helpers

    private var header: XCUIElement { app.descendants(matching: .any)["journal.day.header"].firstMatch }

    /// Launches with `today` pinned, opens the vault and the Journal tab.
    private func openJournal(today: String) throws {
        app.launchArguments = ["-MEMRY_JOURNAL_TODAY", today]
        app.launch()
        let vault = app.staticTexts["MemryNote"]
        let journalTab = app.buttons["Journal"].firstMatch
        let signIn = app.staticTexts["Sign in to Memry"]
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, !journalTab.exists {
            if signIn.exists {
                XCTFail("Signed out: sign in to the staging test account first (tasks.md §0.4).")
                throw XCTSkip("signed out")
            }
            if vault.exists, vault.isHittable { vault.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(journalTab.waitForExistence(timeout: 5), "the vault did not open")
        journalTab.tap()
        XCTAssertTrue(header.waitForExistence(timeout: 20), "the Journal tab did not show a day")
    }

    /// Picks an item from the date title's menu.
    private func titleMenu(_ identifier: String) {
        app.buttons["journal.day.titleMenu"].firstMatch.tap()
        let item = app.buttons[identifier].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.tap()
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    /// The shown day: the header's spoken date matched against the days
    /// around the pinned today.
    private func shownDate() -> String? {
        let spoken = header.label
        for offset in -12 ... 12 {
            guard let date = Self.shift(Self.pinned ?? "", by: offset) else { continue }
            if spoken.contains(Self.spoken(date)) { return date }
        }
        return nil
    }

    private func anything(containing text: String) -> XCUIElement {
        // An editable block is a text view: its text is the value, not the label.
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
    }

    private func scroll(to element: XCUIElement) {
        for _ in 0 ..< 8 where !(element.exists && element.isHittable) {
            app.swipeUp()
        }
    }

    private func waitUntil(_ seconds: TimeInterval = 10, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }

    // MARK: Dates

    private static var pinned: String?
    private static let calendar = Calendar(identifier: .gregorian)

    private static func parse(_ key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    private static func key(_ date: Date) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private static func shift(_ key: String, by days: Int) -> String? {
        parse(key).flatMap { calendar.date(byAdding: .day, value: days, to: $0) }.map(Self.key)
    }

    /// A random day from July to December 2099, optionally on `weekday`
    /// (Gregorian: 1 is Sunday), remembered as the pinned today.
    private static func randomDay(weekday: Int? = nil) -> String {
        let start = parse("2099-07-01") ?? Date()
        var day = calendar.date(byAdding: .day, value: Int.random(in: 0 ..< 170), to: start) ?? start
        if let weekday {
            while calendar.component(.weekday, from: day) != weekday {
                day = calendar.date(byAdding: .day, value: 1, to: day) ?? day
            }
        }
        pinned = key(day)
        return key(day)
    }

    /// "June 15, 2099", as the header speaks the date.
    private static func spoken(_ key: String) -> String {
        guard let date = parse(key) else { return key }
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return "\(monthName(c.month ?? 1)) \(c.day ?? 1), \(c.year ?? 2099)"
    }

    private static func monthName(_ month: Int) -> String {
        DateFormatter().standaloneMonthSymbols[max(0, min(11, month - 1))]
    }
}
