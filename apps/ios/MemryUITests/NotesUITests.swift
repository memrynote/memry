import XCTest

// The Notes tab end to end on a real vault.
//
// **Precondition:** the simulator is signed in to the staging test account,
// as `TasksUITests` needs. A test that lands on sign-in fails rather than
// skips. Every note a test writes is titled `[agent] ui-<run>…` and deleted
// by the test.
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
        for _ in 0 ..< 3 where !delete.isHittable {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.55)).press(
                forDuration: 0.1,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.09))
            )
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
        let signIn = app.staticTexts["Sign in to Memry"]
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, !notesTab.exists {
            if signIn.exists {
                XCTFail("Signed out: sign in to the staging test account first.")
                throw XCTSkip("signed out")
            }
            if vault.exists, vault.isHittable { vault.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        notesTab.tap()
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
    }
}
