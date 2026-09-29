import XCTest

// Spec 007 CL093: the calendar end to end on a real vault, one test per lane
// of the flow map (Paper 00b, lanes A–J).
//
// **Precondition:** the simulator is signed in to the staging test account
// (tasks.md §0.4). `TEST_RUNNER_MEMRY_UI_VAULT` names the vault to open when
// the vault list shows (`a|b` for either name). A test that lands on the sign-in screen fails with
// that instruction instead of skipping.
//
// Every event a test writes is titled `[agent] ui-<run>…` and deleted by the
// same test (lane F), so a green run leaves nothing behind.
@MainActor
final class CalendarUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "ui-\(UUID().uuidString.prefix(6).lowercased())"
    }

    // MARK: A — open and switch views

    func testLaneAOpensEveryViewFromTheTitleMenu() throws {
        try openCalendar()
        for (label, identifier) in [("Week", "calendar.week"), ("Month", "calendar.month"), ("Year", "calendar.year"),
                                    ("Timeline", "calendar.timeline"), ("Day", "calendar.screen")] {
            pickView(label)
            XCTAssertTrue(element(identifier).waitForExistence(timeout: 10), "\(label) did not open")
        }
        openTitleMenu()
        XCTAssertTrue(app.buttons["calendar.menu.today"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["calendar.menu.goto"].exists)
        app.buttons["calendar.menu.today"].tap()
    }

    // MARK: B — find something

    func testLaneBSearchOpensTheItemSheet() throws {
        try openCalendar()
        let title = createEvent()
        // The calendar's own search sits in the title menu.
        openTitleMenu()
        app.buttons["calendar.search"].firstMatch.tap()
        let field = app.textFields["calendar.search.field"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(run)
        let result = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'calendar.search.result.'")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10), "no search result for \(run)")
        result.tap()
        XCTAssertTrue(element("calendar.sheet.event").waitForExistence(timeout: 10))
        deleteOpenEvent(title)
    }

    // MARK: C — choose what shows

    func testLaneCFilterReachesCalendarSettings() throws {
        try openCalendar()
        app.buttons["calendar.filter"].firstMatch.tap()
        XCTAssertTrue(element("calendar.filter.memry").waitForExistence(timeout: 5))
        XCTAssertTrue(element("calendar.filter.imported").exists)
        let manage = app.buttons["calendar.filter.manage"].firstMatch
        XCTAssertTrue(manage.waitForExistence(timeout: 5))
        manage.tap()
        XCTAssertTrue(app.buttons["calendar.settings.provider.google"].firstMatch.waitForExistence(timeout: 10))
    }

    // MARK: D — create an event

    func testLaneDNewEventSheetCreatesAnEventOnTheGrid() throws {
        try openCalendar()
        let title = createEvent()
        chip(title).tap()
        XCTAssertTrue(element("calendar.sheet.event").waitForExistence(timeout: 10))
        deleteOpenEvent(title)
    }

    // MARK: E — open an item

    func testLaneEEventSheetShowsItsTitleAndActions() throws {
        try openCalendar()
        let title = createEvent()
        chip(title).tap()
        XCTAssertTrue(element("calendar.sheet.event").waitForExistence(timeout: 10))
        let field = element("calendar.sheet.title")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, title)
        XCTAssertTrue(app.buttons["calendar.sheet.more"].firstMatch.exists)
        deleteOpenEvent(title)
    }

    // MARK: F — act without opening

    func testLaneFDeleteFromTheSheetMenuRemovesTheChip() throws {
        try openCalendar()
        let title = createEvent()
        chip(title).tap()
        XCTAssertTrue(element("calendar.sheet.event").waitForExistence(timeout: 10))
        deleteOpenEvent(title)
        XCTAssertTrue(chip(title).waitForNonExistence(timeout: 10), "the deleted event stayed on the grid")
    }

    // MARK: G — drill down from Year

    func testLaneGYearDayPeekOpensTheDay() throws {
        try openCalendar()
        pickView("Year")
        let day = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'calendar.year.2'")).firstMatch
        XCTAssertTrue(day.waitForExistence(timeout: 10))
        day.tap()
        let openDay = app.buttons["calendar.peek.openDay"].firstMatch
        XCTAssertTrue(openDay.waitForExistence(timeout: 10), "the day peek did not open")
        openDay.tap()
        XCTAssertTrue(element("calendar.screen").waitForExistence(timeout: 10))
        pickView("Day")
    }

    // MARK: H — plan on the Timeline

    func testLaneHTimelineHasZoomAndDisplay() throws {
        try openCalendar()
        pickView("Timeline")
        XCTAssertTrue(element("calendar.timeline").waitForExistence(timeout: 10))
        XCTAssertTrue(element("calendar.timeline.zoom").waitForExistence(timeout: 5))
        let display = app.buttons["calendar.timeline.display"].firstMatch
        XCTAssertTrue(display.waitForExistence(timeout: 5))
        display.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Group'")).firstMatch
            .waitForExistence(timeout: 5), "the display menu did not open")
        app.tap()
        pickView("Day")
    }

    // MARK: I — connect Google

    func testLaneIGoogleOffersSignInOnThisPhone() throws {
        try openCalendar()
        let pill = app.buttons["calendar.connectGoogle"].firstMatch
        if pill.waitForExistence(timeout: 3) {
            pill.tap()
            XCTAssertTrue(element("calendar.connect.sheet").waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["calendar.connect.continue"].exists)
            // Dismissed by swipe, not Not now: Not now hides the pill for good.
            element("calendar.connect.sheet").swipeDown(velocity: .fast)
        }
        openSettings()
        app.buttons["calendar.settings.provider.google"].firstMatch.tap()
        let signIn = app.buttons.matching(NSPredicate(format: "label IN {'Reconnect', 'Add account', 'Continue with Google'}")).firstMatch
        XCTAssertTrue(signIn.waitForExistence(timeout: 10), "Google offers no sign-in")
    }

    // MARK: J — manage accounts and preferences

    func testLaneJEveryProviderScreenOpens() throws {
        try openCalendar()
        openSettings()
        XCTAssertTrue(element("calendar.settings.weekStart").exists)
        XCTAssertTrue(element("calendar.settings.showNotes").exists)
        let screens: [(String, String)] = [
            ("google", "Google Calendar"), ("caldav", "CalDAV"), ("ics", "Subscribed"), ("apple-eventkit", "This iPhone")
        ]
        for (provider, title) in screens {
            app.buttons["calendar.settings.provider.\(provider)"].firstMatch.tap()
            let found = app.navigationBars.staticTexts[title].firstMatch
            XCTAssertTrue(found.waitForExistence(timeout: 10), "\(provider) screen did not open")
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(app.buttons["calendar.settings.provider.google"].firstMatch.waitForExistence(timeout: 5))
        }
    }

    // MARK: Helpers

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func openCalendar() throws {
        app.launch()
        // Names on a shared staging account move; `a|b` accepts either.
        let names = (ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote").split(separator: "|").map(String.init)
        let vault = app.staticTexts.matching(NSPredicate(format: "label IN %@", names)).firstMatch
        let more = app.buttons["Menu"].firstMatch
        let signIn = app.staticTexts["Sign in to Memry"]
        // The first launch of a run opens the vault and syncs: allow it time.
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, !more.exists {
            if signIn.exists {
                XCTFail("Signed out: sign in to the staging test account first (tasks.md §0.4).")
                throw XCTSkip("signed out")
            }
            if vault.exists, vault.isHittable { vault.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(more.waitForExistence(timeout: 5),
                      "the vault did not open: \(app.buttons.allElementsBoundByIndex.prefix(10).map(\.label))")
        // Calendar sits in the bar or behind Menu, by desktop's rail order.
        let tab = app.tabBars.buttons["Calendar"].firstMatch
        if tab.exists {
            tab.tap()
        } else {
            more.tap()
            let entry = app.buttons["menu.calendar"].firstMatch
            XCTAssertTrue(entry.waitForExistence(timeout: 10))
            entry.tap()
        }
        XCTAssertTrue(element("calendar.screen").waitForExistence(timeout: 15), "the calendar did not open")
        // A first answer to Paper 26 may be pending; decline keeps data private.
        let deny = app.alerts.buttons["Don’t allow"]
        if deny.waitForExistence(timeout: 2) { deny.tap() }
        pickView("Day")
    }

    private func openTitleMenu() {
        let menu = app.buttons["calendar.titleMenu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.tap()
    }

    private func pickView(_ label: String) {
        openTitleMenu()
        let option = app.buttons[label].firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 5), "no \(label) in the title menu")
        option.tap()
    }

    private func openSettings() {
        openTitleMenu()
        let settings = app.buttons["calendar.menu.settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.buttons["calendar.settings.provider.google"].firstMatch.waitForExistence(timeout: 10))
    }

    /// A grid chip is one button spoken as "Event, <title>, <time>, <calendar>".
    private func chip(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Event, \(title),")).firstMatch
    }

    /// + opens the New event sheet (13) on the anchor day, 9–10; ✓ saves.
    @discardableResult
    private func createEvent() -> String {
        let title = "[agent] \(run)"
        let add = app.buttons["calendar.add"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        let field = app.textFields["calendar.editor.title"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText(title)
        app.buttons["calendar.editor.save"].firstMatch.tap()
        XCTAssertTrue(chip(title).waitForExistence(timeout: 10), "the new event is not on the grid")
        return title
    }

    private func deleteOpenEvent(_ title: String) {
        let more = app.buttons["calendar.sheet.more"].firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        more.tap()
        let delete = app.buttons["Delete event"].firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        delete.tap()
        let confirm = app.alerts.buttons["Delete"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "no delete confirmation")
        confirm.tap()
        XCTAssertTrue(chip(title).waitForNonExistence(timeout: 10))
    }
}
