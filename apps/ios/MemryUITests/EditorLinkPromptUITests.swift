import XCTest

// #4667: the editor's Link prompt takes the keys. Typing the address goes
// into the prompt, not over the selected word, and Add links that word.
// iPad opens the prompt with ⇧⌘K, iPhone with the format row's link button.
//
// **Precondition:** a simulator with a vault open (the staging test account,
// or a free vault on this device). A run that lands on sign-in skips; a skip
// is not a pass. The note it writes is titled `[agent] <run>…` and deleted by
// the test.
@MainActor
final class EditorLinkPromptUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""
    private let tablet = UIDevice.current.userInterfaceIdiom == .pad

    override func setUp() async throws {
        continueAfterFailure = false
        run = "link-\(UUID().uuidString.prefix(6).lowercased())"
        // The sidebar's Notes row is on screen in landscape.
        if tablet { XCUIDevice.shared.orientation = .landscapeLeft }
    }

    override func tearDown() async throws {
        XCUIDevice.shared.orientation = .portrait
    }

    func testTheLinkPromptLinksTheSelectedWordWithoutTypingOverIt() throws {
        try openNotes()
        let title = "[agent] \(run) link"
        makeNote(title)
        app.typeText("go linkword")
        XCTAssertTrue(matches(NSPredicate(format: "value == 'go linkword'"), block))
        app.typeKey(.leftArrow, modifierFlags: [.shift, .option])

        let prompt = app.alerts["Link"]
        let address = prompt.textFields.firstMatch
        // Cancel drops the address and keeps the selection.
        openPrompt()
        app.typeText("dropped")
        prompt.buttons["Cancel"].tap()
        XCTAssertTrue(prompt.waitForNonExistence(timeout: 5))
        XCTAssertEqual(block.value as? String, "go linkword", "typing went into the note")
        XCTAssertTrue(linkButton.waitForExistence(timeout: 5), "Cancel dropped the selection")
        XCTAssertFalse(linkButton.isSelected, "Cancel added a link")

        openPrompt()
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), address), "the prompt's field has no caret")
        app.typeText("https://memry.app/x")
        XCTAssertTrue(prompt.exists, "typing closed the prompt")
        XCTAssertEqual(address.value as? String, "https://memry.app/x")
        XCTAssertEqual(block.value as? String, "go linkword", "typing went into the note")
        attach("link-typed")
        prompt.buttons["Add"].tap()
        XCTAssertTrue(prompt.waitForNonExistence(timeout: 5))
        XCTAssertEqual(block.value as? String, "go linkword")
        XCTAssertTrue(linkButton.wait(for: \.isSelected, toEqual: true, timeout: 5), "Add did not link the selection")

        // After a relaunch the word is unchanged and still linked.
        app.terminate()
        try openNotes()
        let row = row(title)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for \(title)")
        row.tap()
        XCTAssertTrue(matches(NSPredicate(format: "value == 'go linkword'"), block), "the word did not persist")
        block.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()
        app.typeKey(.rightArrow, modifierFlags: .command)
        app.typeKey(.leftArrow, modifierFlags: [.shift, .option])
        XCTAssertTrue(linkButton.wait(for: \.isSelected, toEqual: true, timeout: 5), "the link did not persist")
        attach("link-relaunched")

        if !tablet { app.buttons["BackButton"].firstMatch.tap() }
        deleteNote(title)
    }

    // MARK: Helpers

    /// Opens the Link prompt over the selection: ⇧⌘K on iPad, the format
    /// row's link button on iPhone. On iPhone it taps the field, which used
    /// to hand the next key to the block and close the prompt.
    private func openPrompt() {
        if tablet {
            app.typeKey("k", modifierFlags: [.command, .shift])
        } else {
            XCTAssertTrue(linkButton.waitForExistence(timeout: 5), "no format row over the selection")
            linkButton.tap()
        }
        let prompt = app.alerts["Link"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5), "the Link prompt did not open")
        if !tablet { prompt.textFields.firstMatch.tap() }
    }

    private var block: XCUIElement {
        app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).firstMatch
    }

    private var linkButton: XCUIElement {
        app.buttons["Add a link"]
    }

    private func row(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    private func matches(_ predicate: NSPredicate, _ element: XCUIElement) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 10) == .completed
    }

    /// A new note titled `title`, left by Return: the caret moves to the
    /// first block.
    private func makeNote(_ title: String) {
        let add = app.buttons["notes.addButton"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText("\(title)\n")
        XCTAssertTrue(block.waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), block), "Return in the title did not move to the body")
    }

    private func deleteNote(_ title: String) {
        let row = row(title)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for \(title)")
        row.press(forDuration: 1)
        app.buttons["Delete note"].tap()
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }

    private func attach(_ name: String) {
        Thread.sleep(forTimeInterval: 1)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// The notes list: the sidebar's Notes row on iPad, the Notes tab on
    /// iPhone. A restored note page on iPhone hides the tab bar, so it backs
    /// out of it first.
    private func openNotes() throws {
        app.launchArguments = ["-MEMRY_HIDE_TIPS", "YES"]
        app.launch()
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name].firstMatch
        let signIn = app.descendants(matching: .any).matching(NSPredicate(
            format: "label IN {'Sign in to Memry', 'Already have an account? Sign in'}"
        )).firstMatch
        let notes = tablet
            ? app.collectionViews.containing(.any, identifier: "magnifyingglass").firstMatch
                .cells.matching(NSPredicate(format: "label BEGINSWITH 'Notes'")).firstMatch
            : app.buttons["Notes"].firstMatch
        let back = app.buttons["BackButton"]
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !(notes.exists && notes.isHittable) {
            if signIn.exists { throw XCTSkip("Signed out: open a vault on this simulator first.") }
            if vault.exists, vault.isHittable { vault.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            if !tablet, back.exists, back.isHittable { back.tap() }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertTrue(notes.waitForExistence(timeout: 5), "the notes list did not show")
        notes.tap()
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
    }
}
