import XCTest

// #4339: the screens of the layout verification matrix. Each test opens one
// screen and attaches a screenshot in portrait and one in landscape.
// `scripts/screenshot-matrix.mjs` runs this class on each simulator, in each
// appearance, and extracts the attachments into a folder.
//
// **Precondition:** signed in to the staging test account with a vault open.
// A test that lands on sign-in skips. A detail screen whose list is empty
// skips and names the list.
//
// Nearly read-only: the tests open existing items and change nothing, except
// that opening an unviewed reminder in the Inbox marks it viewed.
@MainActor
final class TabletLayoutUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    override func tearDown() async throws {
        XCUIDevice.shared.orientation = .portrait
    }

    func testHome() throws {
        try openPage("home")
        snap("home")
    }

    func testNotes() throws {
        try openPage("notes")
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
        snap("notes")
    }

    func testNote() throws {
        try openPage("notes")
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
        try firstNoteRow().tap()
        XCTAssertTrue(app.textFields["Title"].firstMatch.waitForExistence(timeout: 10), "the note did not open")
        snap("note")
    }

    func testInbox() throws {
        try openPage("inbox")
        XCTAssertTrue(element("inbox.list").waitForExistence(timeout: 15))
        snap("inbox")
    }

    func testInboxDetail() throws {
        try openPage("inbox")
        try openFirst("inbox.row.", in: "the inbox", showing: "inbox.detail.title")
        snap("inbox-detail")
    }

    func testTasks() throws {
        try openPage("tasks")
        XCTAssertTrue(app.buttons["tasks.filterButton"].firstMatch.waitForExistence(timeout: 15))
        snap("tasks")
    }

    func testTaskDetail() throws {
        try openPage("tasks")
        // The row comes before its own `tasks.row.status` in the tree.
        try openFirst("tasks.row.", in: "the task list", showing: "tasks.detail")
        snap("task-detail")
    }

    func testJournalDay() throws {
        try openPage("journal")
        // A restored Year or Month page: up to the Year, then down to today.
        if !element("journal.day.header").waitForExistence(timeout: 5) {
            let up = app.navigationBars.buttons["BackButton"]
            for _ in 0 ..< 3 where up.exists && up.isHittable {
                up.tap()
            }
            let today = Calendar.current.dateComponents([.year, .month, .day], from: Date())
            app.buttons["journal.year.month.\(today.month ?? 1)"].firstMatch.tap()
            let day = String(format: "%04d-%02d-%02d", today.year ?? 0, today.month ?? 0, today.day ?? 0)
            app.buttons["journal.month.day.\(day)"].firstMatch.tap()
        }
        XCTAssertTrue(element("journal.day.header").waitForExistence(timeout: 20), "the journal did not show a day")
        snap("journal-day")
    }

    func testCalendar() throws {
        try openPage("calendar")
        XCTAssertTrue(element("calendar.screen").waitForExistence(timeout: 15), "the calendar did not open")
        snap("calendar")
    }

    func testSettings() throws {
        try openPage("settings")
        XCTAssertTrue(app.buttons["settings.row.account"].firstMatch.waitForExistence(timeout: 10))
        snap("settings")
    }

    // MARK: Helpers

    /// Attaches the screen in portrait, then in landscape. Named
    /// `<screen>-portrait` and `<screen>-landscape`, which the script keeps.
    private func snap(_ screen: String) {
        for (orientation, name) in [(UIDeviceOrientation.portrait, "portrait"), (.landscapeLeft, "landscape")] {
            XCUIDevice.shared.orientation = orientation
            waitForWindow(landscape: name == "landscape")
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "\(screen)-\(name)"
            shot.lifetime = .keepAlways
            add(shot)
        }
        XCUIDevice.shared.orientation = .portrait
    }

    /// Waits until the window's frame is wider than tall (landscape) or the
    /// reverse, which it is only once the rotation has finished.
    private func waitForWindow(landscape: Bool) {
        let window = app.windows.firstMatch
        let shaped = NSPredicate { _, _ in
            let frame = window.frame
            return landscape ? frame.width > frame.height : frame.height > frame.width
        }
        let wait = XCTNSPredicateExpectation(predicate: shaped, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [wait], timeout: 10), .completed, "the window did not rotate to \(landscape ? "landscape" : "portrait")")
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    /// Taps the first row whose identifier starts with `prefix` until
    /// `detail` shows, or skips when `list` has none. Right after the Menu
    /// sheet closes, iPad reports the rows as not hittable and can drop the
    /// first tap, so the tap goes to the row's middle and is retried.
    private func openFirst(_ prefix: String, in list: String, showing detail: String) throws {
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
        guard row.waitForExistence(timeout: 15) else { throw XCTSkip("\(list) is empty in this vault") }
        let page = element(detail)
        for _ in 0 ..< 3 where !page.exists {
            row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            _ = page.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(page.exists, "the first row of \(list) did not open")
    }

    /// The first note in the Notes list. Section headers and folders carry
    /// an Expanded or Collapsed value; a note row carries none.
    private func firstNoteRow() throws -> XCUIElement {
        let cells = app.collectionViews.firstMatch.cells
        for index in 0 ..< min(cells.count, 40) {
            let row = cells.element(boundBy: index).buttons.firstMatch
            if row.exists, row.isHittable, (row.value as? String ?? "").isEmpty { return row }
        }
        throw XCTSkip("the Notes list shows no note at its root or in Bookmarks")
    }

    /// Launches, opens the vault, and opens `page` (a `VaultTab` raw value,
    /// or `settings`) from the tab bar or from Menu.
    private func openPage(_ page: String) throws {
        app.launchArguments = ["-MEMRY_HIDE_TIPS", "YES"]
        app.launch()
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name].firstMatch
        let menu = app.buttons["Menu"].firstMatch
        let signIn = app.descendants(matching: .any).matching(NSPredicate(
            format: "label IN {'Sign in to Memry', 'Already have an account? Sign in'}"
        )).firstMatch
        // The app restores the last screen, and a pushed page hides the bar.
        let back = app.buttons["BackButton"].firstMatch
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, !(menu.exists && menu.isHittable) {
            if signIn.exists {
                throw XCTSkip("Signed out: sign in to the staging test account first.")
            }
            if vault.exists, vault.isHittable { vault.tap() }
            if back.exists, back.isHittable { back.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(menu.isHittable, "the vault did not open")
        if page == "home" || page == "notes" {
            app.buttons[page == "home" ? "Home" : "Notes"].firstMatch.tap()
            return
        }
        let titles = ["inbox": "Inbox", "tasks": "Tasks", "journal": "Journal", "calendar": "Calendar"]
        if let title = titles[page], app.buttons[title].firstMatch.isHittable {
            app.buttons[title].firstMatch.tap()
            return
        }
        // Not in the bar: Menu lists it, or the page is turned off.
        menu.tap()
        let entry = app.buttons["menu.\(page)"].firstMatch
        guard entry.waitForExistence(timeout: 10) else { throw XCTSkip("\(page) is turned off in Settings › Features") }
        entry.tap()
    }
}
