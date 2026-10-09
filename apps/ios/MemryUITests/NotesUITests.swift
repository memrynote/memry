import XCTest

// The Notes tab end to end on a real vault.
//
// **Precondition:** the simulator is signed in to the staging test account,
// as `TasksUITests` needs. A test that lands on sign-in skips, with that
// instruction as the reason. A skip is not a pass: check the run's skip count
// before calling a UI plan green. Every note a test writes is titled
// `[agent] ui-<run>…` and deleted by the test.
@MainActor
final class NotesUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "ui-\(UUID().uuidString.prefix(6).lowercased())"
    }

    /// #2680: a title typed into a new note, then left with Back rather than
    /// Return, used to be dropped, and the note synced as "Untitled note".
    func testANewNotesTitleSurvivesLeavingWithoutReturn() throws {
        try openNotes()
        let title = "[agent] \(run) title"
        app.buttons["notes.addButton"].tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText(title)
        app.buttons["BackButton"].tap()
        // Relaunched, so the row reads the stored title rather than a list
        // that refreshed before the write landed.
        app.terminate()
        try openNotes()

        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the typed title did not land")

        row.press(forDuration: 1)
        app.buttons["Delete note"].tap()
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }

    /// #2861: confirming the note page's More actions > Delete removed the
    /// note but left its page on screen, so the delete looked like it did
    /// nothing.
    func testDeletingFromTheNotePageMenuLeavesThePage() throws {
        try openNotes()
        let title = "[agent] \(run) page delete"
        app.buttons["notes.addButton"].tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText("\(title)\n")

        app.buttons["More actions for this note"].tap()
        // Delete is the menu's last item, below the fold on a phone: scroll
        // the menu as a finger would, then tap it where it is on screen.
        let delete = app.buttons["trash"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        // Short drags just below the menu's first rows: with the keyboard up
        // the menu is only a few rows tall, and a drag that starts outside
        // it closes it. The anchor is read once, since its row scrolls away.
        let find = app.buttons["Find in note"].frame
        let top = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: find.midX, dy: find.midY))
        for _ in 0 ..< 8 where !delete.isHittable {
            top.withOffset(CGVector(dx: 0, dy: 120))
                .press(forDuration: 0.1, thenDragTo: top.withOffset(CGVector(dx: 0, dy: -40)))
        }
        XCTAssertTrue(delete.isHittable, "Delete never scrolled into the menu")
        delete.tap()

        let alert = app.alerts["Delete this note?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        alert.buttons["Delete"].tap()

        XCTAssertTrue(field.waitForNonExistence(timeout: 10), "the deleted note's page stayed open")
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 5))
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertFalse(row.waitForExistence(timeout: 3))
    }

    /// #2861: a row's swipe > Delete was a destructive swipe action, so the
    /// list treated the row as removed and its confirmation never appeared.
    func testSwipeDeleteAsksThenRemovesTheRow() throws {
        try openNotes()
        let title = "[agent] \(run) swipe delete"
        app.buttons["notes.addButton"].tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText("\(title)\n")
        app.buttons["BackButton"].tap()

        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.swipeLeft()
        let delete = app.buttons["trash"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        delete.tap()

        let question = app.staticTexts["Delete this note?"]
        XCTAssertTrue(question.waitForExistence(timeout: 5), "swipe > Delete asked nothing")
        app.buttons.matching(NSPredicate(format: "label == 'Delete' AND identifier != 'trash'"))
            .firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }

    private func openNotes() throws {
        app.launch()
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name]
        let notesTab = app.buttons["Notes"].firstMatch
        // Signed out lands on the welcome screen first, or on sign-in once
        // past it.
        let signIn = app.descendants(matching: .any).matching(NSPredicate(
            format: "label IN {'Sign in to Memry', 'Already have an account? Sign in'}"
        )).firstMatch
        // The app restores the last screen, and a restored note page hides
        // the tab bar: back out of it rather than tap a tab that is leaving.
        let back = app.buttons["BackButton"]
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, !(notesTab.exists && notesTab.isHittable) {
            if signIn.exists {
                throw XCTSkip("Signed out: sign in to the staging test account first.")
            }
            if vault.exists, vault.isHittable { vault.tap() }
            if back.exists, back.isHittable { back.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        notesTab.tap()
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
    }
}
