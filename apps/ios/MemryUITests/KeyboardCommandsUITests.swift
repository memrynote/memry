import UIKit
import XCTest

// #4355: the app's keyboard commands on iPad. ⌘2 opens the second page in
// the sidebar, ⌘N makes a note and puts its title under the caret, ⌘K opens
// search from inside the note's body, and no command fires while a sheet is
// up.
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

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.5)).tap()
        XCTAssertTrue(capture.waitForNonExistence(timeout: 5), "the capture sheet did not close")
        app.typeKey("k", modifierFlags: .command)
        XCTAssertTrue(search.waitForExistence(timeout: 5), "search did not open once the sheet closed")
        app.typeKey(".", modifierFlags: .command)
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
        // The system's "Hold ⌘" window takes the first ⌘ key after a launch on
        // the simulator, and the keys after it while it comes in; ⌘1 (Home)
        // spends it.
        app.typeKey("1", modifierFlags: .command)
        Thread.sleep(forTimeInterval: 3)
    }
}
