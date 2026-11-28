import UIKit
import XCTest

// #4349: at regular width the Inbox list sits beside the detail, and filing
// the selected item selects the next one.
//
// **Precondition:** an iPad simulator with a vault open (the staging test
// account, or the free vault on this device). A run that lands on sign-in, or
// on an iPhone, skips; a skip is not a pass.
//
// The test captures two items named `[agent] ui-<run>…` and files one to the
// vault root. Its teardown deletes what the run left, also after a failure.
@MainActor
final class InboxSplitUITests: XCTestCase {
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

    func testFilingTheSelectedItemSelectsTheNextOne() throws {
        try openInbox()
        let older = "[agent] \(run) next"
        let newer = "[agent] \(run) filed"
        addTeardownBlock { [self] in cleanUp() }
        capture(older)
        capture(newer)
        let filed = row(containing: newer)
        let next = row(containing: older)
        XCTAssertTrue(filed.waitForExistence(timeout: 10), "the capture did not appear")

        filed.tap()
        XCTAssertTrue(filed.wait(for: \.isSelected, toEqual: true, timeout: 5), "the tapped row is not selected")
        XCTAssertTrue(detailTitle(contains: newer), "the detail column does not show the tapped item")

        tap("inbox.detail.file")
        tap("inbox.file.folder.root")
        tap("inbox.file.confirm")
        XCTAssertTrue(filed.waitForNonExistence(timeout: 10), "the filed row stayed in the inbox")
        XCTAssertTrue(next.wait(for: \.isSelected, toEqual: true, timeout: 5), "the next row is not selected")
        XCTAssertTrue(detailTitle(contains: older), "the detail column does not show the next item")
    }

    // MARK: Steps

    private func openInbox() throws {
        app.launchArguments = ["-MEMRY_HIDE_TIPS", "YES"]
        app.launch()
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name].firstMatch
        let signIn = app.descendants(matching: .any).matching(NSPredicate(
            format: "label IN {'Sign in to Memry', 'Already have an account? Sign in'}"
        )).firstMatch
        let search = sidebarRow("Search")
        let back = app.buttons["BackButton"].firstMatch
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !search.exists {
            if signIn.exists { throw XCTSkip("Signed out: open a vault on this simulator first.") }
            if app.buttons["Menu"].exists { throw XCTSkip("Compact width: run on an iPad simulator.") }
            if vault.exists, vault.isHittable { vault.tap() }
            if back.exists, back.isHittable { back.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(search.exists, "the sidebar did not show")
        sidebarRow("Inbox").tap()
        XCTAssertTrue(element("inbox.list").waitForExistence(timeout: 20))
        if !app.buttons["inbox.addButton"].firstMatch.isHittable { selectView("inbox") }
    }

    private func capture(_ text: String) {
        app.buttons["inbox.addButton"].firstMatch.tap()
        let field = element("inbox.composer.field")
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText(text)
        tap("inbox.composer.send")
        XCTAssertTrue(waitUntil { (field.value as? String ?? "").isEmpty || !field.exists }, "the composer did not send")
        // A tap on the list column, above the keyboard, closes the composer:
        // while it is open, a layer over the list takes the tap, so no row
        // opens.
        element("inbox.list").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        XCTAssertTrue(element("inbox.composer").waitForNonExistence(timeout: 5), "the composer stayed open")
        XCTAssertTrue(row(containing: text).waitForExistence(timeout: 10), "the capture did not appear")
    }

    /// Deletes this run's captures, wherever the test stopped, and the note
    /// filing made. A relaunch starts from a known screen, and Notes lists
    /// the filed note only after one.
    private func cleanUp() {
        app.terminate()
        guard (try? openInbox()) != nil, element("inbox.list").exists else { return }
        let left = row(containing: run)
        while left.waitForExistence(timeout: 3) {
            left.tap()
            tap("inbox.detail.archive")
            XCTAssertTrue(left.waitForNonExistence(timeout: 10), "the archived row stayed in the inbox")
        }
        selectView("archived")
        while left.waitForExistence(timeout: 5) {
            left.swipeLeft()
            tap("inbox.archived.delete")
            let confirm = app.buttons["Delete permanently"].firstMatch
            XCTAssertTrue(confirm.waitForExistence(timeout: 5))
            confirm.tap()
            XCTAssertTrue(left.waitForNonExistence(timeout: 10), "the capture was not deleted")
        }
        selectView("inbox")
        sidebarRow("Notes").tap()
        let note = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", run)).firstMatch
        guard note.waitForExistence(timeout: 15) else { return }
        note.press(forDuration: 1)
        tap("Delete note")
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(note.waitForNonExistence(timeout: 10), "the filed note was not deleted")
    }

    // MARK: Helpers

    private func detailTitle(contains text: String) -> Bool {
        let title = element("inbox.detail.title")
        return waitUntil { title.exists && (title.label.contains(text) || (title.value as? String ?? "").contains(text)) }
    }

    private func selectView(_ view: String) {
        let title = app.buttons["inbox.titleMenu"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        tap("inbox.view.\(view)")
    }

    /// A sidebar row by its title; a badge adds its count to the label.
    private func sidebarRow(_ title: String) -> XCUIElement {
        app.collectionViews.containing(.any, identifier: "magnifyingglass").firstMatch
            .cells.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func row(containing text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'inbox.row.' AND label CONTAINS %@", text)).firstMatch
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func tap(_ identifier: String) {
        let element = element(identifier)
        XCTAssertTrue(element.waitForExistence(timeout: 5), "\(identifier) is missing")
        element.tap()
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
