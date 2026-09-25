import XCTest

// Spec 006 IB92: the Inbox end to end on a real vault. Capture is the "+"
// composer, views are in the title menu, row actions are the swipe actions.
//
// **Precondition:** the simulator is signed in to the staging test account
// (tasks.md §0.3a). A test that lands on the sign-in screen fails with that
// instruction instead of skipping, so a green UI plan always means the flows
// ran.
//
// Every capture is named `[agent] ui-<run>…` and each test deletes its own
// capture permanently from Archived at the end, so reruns leave nothing.
@MainActor
final class InboxUITests: XCTestCase {
    let app = XCUIApplication()
    /// Unique per test, so reruns and parallel leftovers never collide.
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "ui-\(UUID().uuidString.prefix(6).lowercased())"
    }

    // MARK: Flows

    func testACaptureCanBeArchivedAndDeletedFromArchived() throws {
        try openInbox()
        let text = "[agent] \(run) archive"
        capture(text)
        let row = row(containing: text)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the capture did not appear")
        XCTAssertTrue(row.label.hasPrefix("Note: "), row.label)
        row.swipeLeft()
        tap("inbox.swipe.archive")
        XCTAssertTrue(waitUntil { !row.exists }, "the archived row stayed in the inbox")
        deleteFromArchived(text)
    }

    func testASnoozedCaptureComesBackFromSnoozed() throws {
        try openInbox()
        let text = "[agent] \(run) snooze"
        capture(text)
        let row = row(containing: text)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the capture did not appear")
        row.swipeLeft()
        tap("inbox.swipe.snooze")
        tap("inbox.snooze.inOneHour")
        XCTAssertTrue(waitUntil { !row.exists }, "the snoozed row stayed in the inbox")

        selectView("snoozed")
        let entry = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'inbox.panel.' AND label CONTAINS %@", text
        )).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 10), "the capture is not under Snoozed")
        entry.swipeLeft()
        let back = app.buttons["Back to inbox"].firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        XCTAssertTrue(waitUntil { !entry.exists }, "the capture stayed under Snoozed")

        selectView("inbox")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the capture did not come back")
        row.swipeLeft()
        tap("inbox.swipe.archive")
        deleteFromArchived(text)
    }

    // MARK: Steps

    /// Launches onto the Inbox list, through More.
    private func openInbox() throws {
        app.launch()
        // The staging vault's name is whatever a desktop peer last set it to;
        // `TEST_RUNNER_MEMRY_UI_VAULT` overrides the usual one.
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name]
        let moreTab = app.buttons["More"].firstMatch
        let signIn = app.staticTexts["Sign in to Memry"]
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, !moreTab.exists {
            if signIn.exists {
                XCTFail("Signed out: sign in to the staging test account first (tasks.md §0.3a).")
                throw XCTSkip("signed out")
            }
            if vault.exists, vault.isHittable { vault.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(moreTab.waitForExistence(timeout: 5), "the vault did not open")
        moreTab.tap()
        let inboxRow = app.descendants(matching: .any)["inbox.more.row"].firstMatch
        XCTAssertTrue(inboxRow.waitForExistence(timeout: 10))
        inboxRow.tap()
        XCTAssertTrue(app.buttons["inbox.addButton"].firstMatch.waitForExistence(timeout: 20))
        if !app.buttons["inbox.addButton"].firstMatch.isHittable { selectView("inbox") }
    }

    /// Captures `text` through the "+" composer and closes it again.
    private func capture(_ text: String) {
        app.buttons["inbox.addButton"].firstMatch.tap()
        // A vertical TextField: a text view or a text field, by OS version.
        let field = app.descendants(matching: .any)["inbox.composer.field"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText(text)
        tap("inbox.composer.send")
        XCTAssertTrue(
            waitUntil { (field.value as? String ?? "").isEmpty || !field.exists }, "the composer did not send"
        )
        // A tap outside the composer closes it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
    }

    /// Archived > swipe > Delete permanently > confirm, then back to Inbox.
    private func deleteFromArchived(_ text: String) {
        selectView("archived")
        let archived = row(containing: text)
        XCTAssertTrue(archived.waitForExistence(timeout: 10), "the capture is not under Archived")
        archived.swipeLeft()
        tap("inbox.archived.delete")
        let confirm = app.buttons["Delete permanently"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(waitUntil { !archived.exists }, "the capture was not deleted")
        selectView("inbox")
    }

    /// Picks a view (inbox, snoozed, archived, insights) from the title menu.
    private func selectView(_ view: String) {
        let title = app.buttons["inbox.titleMenu"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        tap("inbox.view.\(view)")
    }

    private func tap(_ identifier: String) {
        let element = app.descendants(matching: .any)[identifier].firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: 5), "\(identifier) is missing")
        element.tap()
    }

    private func row(containing text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'inbox.row.' AND label CONTAINS %@", text
        )).firstMatch
    }

    private func waitUntil(_ seconds: TimeInterval = 10, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }
}
