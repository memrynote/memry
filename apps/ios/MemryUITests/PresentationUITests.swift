import UIKit
import XCTest

// #4341: presentations at regular width on iPad.
//
// **Precondition:** an iPad simulator with a vault open (the staging test
// account, or the free vault on this device). A run that lands on sign-in, or
// on an iPhone, skips; a skip is not a pass. Every note a test writes is
// titled `[agent] ui-<run>…` and deleted by the test.
@MainActor
final class PresentationUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "ui-\(UUID().uuidString.prefix(6).lowercased())"
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDown() async throws {
        XCUIDevice.shared.orientation = .portrait
    }

    /// The row menu's "Share a copy" wrapped a share sheet in a SwiftUI sheet,
    /// with no anchor on iPad. It is a `ShareLink` now: the system share
    /// sheet opens from the row and closes again.
    func testShareACopyOpensTheShareSheetFromTheRow() throws {
        try openNotes(hidingTips: true)
        let title = "[agent] \(run) share"
        try makeNote(title)

        let row = noteRow(title)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.press(forDuration: 1)
        let share = app.buttons["Share a copy"]
        XCTAssertTrue(share.waitForExistence(timeout: 5))
        share.tap()

        // The share sheet's own "Copy" action: present only once the system
        // sheet is up.
        let copy = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Copy'")).firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 10), "the share sheet did not open")
        // A tap outside closes it; the app is still running.
        app.otherElements["PopoverDismissRegion"].firstMatch.tap()
        XCTAssertTrue(copy.waitForNonExistence(timeout: 10), "the share sheet did not close")
        XCTAssertEqual(app.state, .runningForeground)

        deleteNote(row)
    }

    /// The "Hold + for more" tip is earned by the tap that also opens the new
    /// note, and its popover stayed over the note pointing at nothing. It
    /// shows only while the "+" is on screen.
    ///
    /// Needs a fresh install: the tip shows once per install, so a run where
    /// it never appears skips.
    func testTheCreateTipNeverCoversTheNewNote() throws {
        try openNotes(hidingTips: false)
        let tip = app.staticTexts["Hold + for more"]
        if tip.exists { throw XCTSkip("The tip is already showing: run on a fresh install.") }
        let title = "[agent] \(run) tip"
        app.buttons["notes.addButton"].firstMatch.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertFalse(tip.waitForExistence(timeout: 4), "the tip covers the new note")
        field.typeText("\(title)\n")
        app.buttons["BackButton"].firstMatch.tap()

        let shown = tip.waitForExistence(timeout: 6)
        if shown { app.buttons["Close"].firstMatch.tap() }
        deleteNote(noteRow(title))
        if !shown { throw XCTSkip("The tip has shown on this install before: run on a fresh install.") }
    }

    // MARK: Helpers

    private func noteRow(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    private func makeNote(_ title: String) throws {
        app.buttons["notes.addButton"].firstMatch.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText("\(title)\n")
        app.buttons["BackButton"].firstMatch.tap()
    }

    private func deleteNote(_ row: XCUIElement) {
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.press(forDuration: 1)
        app.buttons["Delete note"].tap()
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }

    /// A sidebar row by its title, as `ShellSidebarUITests` finds them.
    private func sidebarRow(_ title: String) -> XCUIElement {
        app.collectionViews.containing(.any, identifier: "magnifyingglass").firstMatch
            .cells.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func openNotes(hidingTips: Bool) throws {
        // A tip's popover takes the next tap; only the tip test wants it.
        app.launchArguments = hidingTips ? ["-MEMRY_HIDE_TIPS", "YES"] : []
        app.launch()
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name].firstMatch
        let signIn = app.descendants(matching: .any).matching(NSPredicate(
            format: "label IN {'Sign in to Memry', 'Already have an account? Sign in'}"
        )).firstMatch
        let notes = sidebarRow("Notes")
        let back = app.buttons["BackButton"].firstMatch
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !notes.exists {
            if signIn.exists { throw XCTSkip("Signed out: open a vault on this simulator first.") }
            if app.buttons["Menu"].exists {
                throw XCTSkip("Compact width: run on an iPad simulator.")
            }
            if vault.exists { vault.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            Thread.sleep(forTimeInterval: 1)
        }
        notes.tap()
        // The app restores the last screen: back out of a restored note.
        if back.waitForExistence(timeout: 2) { back.tap() }
        XCTAssertTrue(app.buttons["notes.addButton"].firstMatch.waitForExistence(timeout: 10))
    }
}
