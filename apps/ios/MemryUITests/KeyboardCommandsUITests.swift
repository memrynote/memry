import UIKit
import XCTest

// #4355: the app's keyboard commands on iPad. ⌘2 opens the second page in
// the sidebar, ⌘N makes a note and puts its title under the caret, ⌘K opens
// search from inside the note's body, and no command fires while a sheet is
// up. #4379: ⌘P opens the command palette, and its Return runs the row the
// way the menu bar does, including a command that presents search or a sheet.
// #4380: ⇧⌘B toggles the Day Panel.
//
// **Precondition:** a full-screen iPad simulator with a vault open (the
// staging test account, or a free vault on this device). A run that lands on
// sign-in, or on a compact window, skips; a skip is not a pass. The note the
// test makes is titled `[agent] <run>…` and deleted by the test.
@MainActor
final class KeyboardCommandsUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "keys-\(UUID().uuidString.prefix(6).lowercased())"
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDown() async throws {
        XCUIDevice.shared.orientation = .portrait
    }

    func testCommandsOpenAPageANewNoteAndSearch() throws {
        try openVault()
        sidebarRow("Notes").tap()
        let second = try page(2)
        app.typeKey("2", modifierFlags: .command)
        XCTAssertTrue(second.wait(for: \.isSelected, toEqual: true, timeout: 5), "⌘2 did not open \(second.label)")

        app.typeKey("n", modifierFlags: .command)
        XCTAssertTrue(sidebarRow("Notes").wait(for: \.isSelected, toEqual: true, timeout: 5), "⌘N did not open Notes")
        let title = app.textFields["Title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "⌘N did not open a new note")
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), title), "the new note's title has no caret")
        let name = "[agent] \(run) made by command"
        title.typeText("\(name)\n")
        let body = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).firstMatch
        XCTAssertTrue(body.waitForExistence(timeout: 10))
        body.typeText("Body")
        attach("new-note")

        // From inside the editor: its text view must not swallow the key.
        app.typeKey("k", modifierFlags: .command)
        let search = app.textFields["search.palette.field"]
        XCTAssertTrue(search.waitForExistence(timeout: 5), "⌘K did not open search from the editor")
        app.typeKey("2", modifierFlags: .command)
        XCTAssertFalse(
            second.wait(for: \.isSelected, toEqual: true, timeout: 2),
            "⌘2 changed the page under the search palette"
        )
        app.typeKey(".", modifierFlags: .command)
        XCTAssertTrue(search.waitForNonExistence(timeout: 5))

        deleteNote(name)
    }

    func testCommandPaletteRunsNewNote() throws {
        try openVault()
        sidebarRow("Home").tap()
        app.typeKey("p", modifierFlags: .command)
        let field = app.textFields["commands.palette.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "⌘P did not open the command palette")
        XCTAssertTrue(app.buttons["commands.row.nav.newNote"].waitForExistence(timeout: 5))
        attach("command-palette")
        field.typeText("new note")
        XCTAssertTrue(app.buttons["commands.row.nav.newNote"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["commands.row.create.task"].exists, "\"new note\" still lists New Task")
        attach("command-palette-query")
        field.typeText("\n")
        XCTAssertTrue(field.waitForNonExistence(timeout: 5), "Return did not close the palette")
        let notes = sidebarRow("Notes")
        XCTAssertTrue(notes.wait(for: \.isSelected, toEqual: true, timeout: 5), "New Note did not open Notes")
        let title = app.textFields["Title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "Return did not open a new note")
        let name = "[agent] \(run) made by palette"
        title.typeText("\(name)\n")

        // Esc (⌘. here) closes it without running anything.
        app.typeKey("p", modifierFlags: .command)
        XCTAssertTrue(field.waitForExistence(timeout: 5), "⌘P did not open the palette from the editor")
        app.typeKey(".", modifierFlags: .command)
        XCTAssertTrue(field.waitForNonExistence(timeout: 5))

        deleteNote(name)
    }

    /// REVIEW-4666 M1: a command that presents runs once the palette has gone,
    /// so its presentation shows and ⌘K still opens search after it.
    func testCommandPaletteRunsPresentingCommands() throws {
        try openVault()
        let palette = app.textFields["commands.palette.field"]
        let search = app.textFields["search.palette.field"]
        app.typeKey("p", modifierFlags: .command)
        XCTAssertTrue(palette.waitForExistence(timeout: 5), "⌘P did not open the command palette")
        palette.typeText("search\n")
        XCTAssertTrue(search.waitForExistence(timeout: 5), "Search from the palette did not open search")
        attach("palette-search")
        app.typeKey(".", modifierFlags: .command)
        XCTAssertTrue(search.waitForNonExistence(timeout: 5))
        app.typeKey("k", modifierFlags: .command)
        XCTAssertTrue(search.waitForExistence(timeout: 5), "⌘K did not open search after the palette ran it")
        app.typeKey(".", modifierFlags: .command)
        XCTAssertTrue(search.waitForNonExistence(timeout: 5))

        app.typeKey("p", modifierFlags: .command)
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        palette.typeText("quick capture\n")
        let capture = app.descendants(matching: .any)["capture.field"].firstMatch
        XCTAssertTrue(capture.waitForExistence(timeout: 5), "Quick Capture from the palette did not open its sheet")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.5)).tap()
        XCTAssertTrue(capture.waitForNonExistence(timeout: 5), "the capture sheet did not close")
        app.typeKey("k", modifierFlags: .command)
        XCTAssertTrue(search.waitForExistence(timeout: 5), "⌘K did not open search after Quick Capture")
        app.typeKey(".", modifierFlags: .command)
    }

    /// REVIEW-4523: a command under a sheet would set state SwiftUI then
    /// drops with the presentation, leaving search dead.
    func testCommandsWaitWhileASheetIsUp() throws {
        try openVault()
        app.typeKey("n", modifierFlags: [.shift, .command])
        let capture = app.descendants(matching: .any)["capture.field"].firstMatch
        XCTAssertTrue(capture.waitForExistence(timeout: 5), "⇧⌘N did not open quick capture")
        app.typeKey("k", modifierFlags: .command)
        let search = app.textFields["search.palette.field"]
        XCTAssertFalse(search.waitForExistence(timeout: 2), "⌘K opened search under the capture sheet")
        app.typeKey("p", modifierFlags: .command)
        XCTAssertFalse(
            app.textFields["commands.palette.field"].waitForExistence(timeout: 2),
            "⌘P opened the command palette under the capture sheet"
        )

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.5)).tap()
        XCTAssertTrue(capture.waitForNonExistence(timeout: 5), "the capture sheet did not close")
        app.typeKey("k", modifierFlags: .command)
        XCTAssertTrue(search.waitForExistence(timeout: 5), "search did not open once the sheet closed")
        app.typeKey(".", modifierFlags: .command)
    }

    /// #4380: ⇧⌘B toggles the Day Panel beside any page; on the journal
    /// page it follows the shown day.
    func testShiftCommandBTogglesTheDayPanel() throws {
        try openVault()
        sidebarRow("Tasks").tap()
        let toggle = app.buttons["dayPanel.toggle"].firstMatch
        guard toggle.waitForExistence(timeout: 5) else {
            throw XCTSkip("The window cannot hold the Day Panel: run on a 13\" iPad in landscape.")
        }
        let panel = app.descendants(matching: .any)["dayPanel"]
        if panel.exists { app.typeKey("b", modifierFlags: [.shift, .command]) }
        XCTAssertTrue(panel.waitForNonExistence(timeout: 5))

        app.typeKey("b", modifierFlags: [.shift, .command])
        XCTAssertTrue(panel.waitForExistence(timeout: 5), "⇧⌘B did not open the Day Panel")
        XCTAssertEqual(toggle.label, "Hide Day Panel")
        let date = app.staticTexts["dayPanel.date"]
        XCTAssertEqual(date.label, "Today", "off the journal page the panel opens on today")
        attach("day-panel-tasks")

        // ⌘T opens the Journal on today, whichever level it was left on.
        app.typeKey("t", modifierFlags: .command)
        let previous = app.buttons["journal.day.previous"].firstMatch
        XCTAssertTrue(previous.waitForExistence(timeout: 10), "the Journal did not open on a day")
        // The Journal keeps its own open state (open by default): a run that
        // closed it there left it closed.
        if !panel.waitForExistence(timeout: 3) { app.typeKey("b", modifierFlags: [.shift, .command]) }
        XCTAssertTrue(panel.waitForExistence(timeout: 5), "⇧⌘B did not open the panel on the Journal")
        app.typeKey("b", modifierFlags: [.shift, .command])
        XCTAssertTrue(panel.waitForNonExistence(timeout: 5), "⇧⌘B did not close the panel on the Journal")
        sidebarRow("Tasks").tap()
        XCTAssertTrue(panel.waitForExistence(timeout: 5), "closing it on the Journal closed it on Tasks")
        app.typeKey("t", modifierFlags: .command)
        XCTAssertTrue(previous.waitForExistence(timeout: 10))
        XCTAssertFalse(panel.exists, "the panel did not stay closed on the Journal")
        app.typeKey("b", modifierFlags: [.shift, .command])
        XCTAssertTrue(panel.waitForExistence(timeout: 5))
        previous.tap()
        XCTAssertTrue(matches(NSPredicate(format: "label != 'Today'"), date), "the panel did not follow the journal's shown day")
        attach("day-panel-journal")

        // Beside a note the panel and the inspector share one rail's room:
        // opening one closes the other.
        app.typeKey("n", modifierFlags: .command)
        let title = app.textFields["Title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "⌘N did not open a new note")
        let name = "[agent] \(run) beside the panel"
        title.typeText("\(name)\n")
        let body = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).firstMatch
        XCTAssertTrue(body.waitForExistence(timeout: 10))
        XCTAssertTrue(panel.waitForExistence(timeout: 5), "the panel did not stay open on Notes")
        attach("day-panel-notes")
        let inspector = app.descendants(matching: .any)["note.inspector"]
        app.buttons["note.inspector.toggle"].firstMatch.tap()
        XCTAssertTrue(inspector.waitForExistence(timeout: 5), "the inspector did not open")
        XCTAssertTrue(panel.waitForNonExistence(timeout: 5), "opening the inspector did not close the panel")
        app.typeKey("b", modifierFlags: [.shift, .command])
        XCTAssertTrue(panel.waitForExistence(timeout: 5), "⇧⌘B did not open the panel beside the note")
        XCTAssertTrue(inspector.waitForNonExistence(timeout: 5), "opening the panel did not close the inspector")

        app.typeKey("b", modifierFlags: [.shift, .command])
        XCTAssertTrue(panel.waitForNonExistence(timeout: 5), "⇧⌘B did not close the Day Panel")
        deleteNote(name)
    }

    // MARK: Helpers

    private var sidebar: XCUIElement {
        app.collectionViews.containing(.any, identifier: "magnifyingglass").firstMatch
    }

    private func sidebarRow(_ title: String) -> XCUIElement {
        sidebar.cells.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    /// The `number`th page row, counted from the row under Search.
    private func page(_ number: Int) throws -> XCUIElement {
        let cells = sidebar.cells.allElementsBoundByIndex
        let search = try XCTUnwrap(cells.firstIndex { $0.label.hasPrefix("Search") }, "no Search row")
        XCTAssertGreaterThan(cells.count, search + number)
        return cells[search + number]
    }

    private func matches(_ predicate: NSPredicate, _ element: XCUIElement) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 10) == .completed
    }

    private func deleteNote(_ title: String) {
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for \(title)")
        row.press(forDuration: 1)
        app.buttons["Delete note"].tap()
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }

    private func attach(_ name: String) {
        Thread.sleep(forTimeInterval: 2)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func openVault() throws {
        // A tip's popover covers the page and takes the next tap.
        app.launchArguments = ["-MEMRY_HIDE_TIPS", "YES"]
        app.launch()
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name].firstMatch
        let signIn = app.descendants(matching: .any).matching(NSPredicate(
            format: "label IN {'Sign in to Memry', 'Already have an account? Sign in'}"
        )).firstMatch
        let notes = sidebarRow("Notes")
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !notes.exists {
            if signIn.exists { throw XCTSkip("Signed out: open a vault on this simulator first.") }
            if app.buttons["Menu"].exists { throw XCTSkip("Compact width: run on a full-screen iPad simulator.") }
            if vault.exists { vault.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertTrue(notes.waitForExistence(timeout: 5), "the sidebar did not show")
        app.primeCommandKeys()
    }
}
