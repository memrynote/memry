import XCTest

// #4354: the note editor on an iPad with a hardware keyboard. Tab nests,
// ⌘Z undoes the nest through the session, ⌘B bolds, ⌘F opens find, the
// slash menu takes the arrows, Return and Esc, and Return in the title moves
// the caret to the body.
//
// **Precondition:** an iPad simulator with a vault open (the staging test
// account, or a free vault on this device) and the simulator's hardware
// keyboard connected (I/O › Keyboard › Connect Hardware Keyboard). A run that
// lands on sign-in or a compact window skips; a skip is not a pass. Every
// note a test writes is titled `[agent] <run>…` and deleted by the test.
@MainActor
final class EditorKeyboardUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "keys-\(UUID().uuidString.prefix(6).lowercased())"
        // The sidebar's Notes row is on screen in landscape.
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDown() async throws {
        XCUIDevice.shared.orientation = .portrait
    }

    func testTabCommandZCommandBAndCommandF() throws {
        try openNotes()
        let title = "[agent] \(run) keys"
        makeNote(title)
        app.typeText("First\n")
        let first = block(0)
        let second = block(1)
        XCTAssertTrue(second.waitForExistence(timeout: 10), "Return did not make a second block")
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), second), "the new block has no caret")
        app.typeText("Second")
        let flush = first.frame.minX

        app.typeKey(.tab, modifierFlags: [])
        XCTAssertTrue(wait { second.frame.minX > flush + 8 }, "Tab did not nest the block")
        XCTAssertFalse((second.value as? String ?? "").contains("\t"), "Tab typed a tab")
        attach("tab-nested")

        app.typeKey("z", modifierFlags: .command)
        XCTAssertTrue(wait { abs(second.frame.minX - flush) < 2 }, "⌘Z did not undo the nest")
        app.typeKey("z", modifierFlags: [.command, .shift])
        XCTAssertTrue(wait { second.frame.minX > flush + 8 }, "⇧⌘Z did not redo the nest")
        app.typeKey(.tab, modifierFlags: .shift)
        XCTAssertTrue(wait { abs(second.frame.minX - flush) < 2 }, "⇧Tab did not lift the block")

        // Typing undo still comes first.
        app.typeText(" more")
        XCTAssertTrue(matches(NSPredicate(format: "value CONTAINS 'Second more'"), second))
        app.typeKey("z", modifierFlags: .command)
        XCTAssertTrue(matches(NSPredicate(format: "NOT (value CONTAINS 'more')"), second), "⌘Z did not undo the typing")
        XCTAssertTrue(matches(NSPredicate(format: "value CONTAINS 'Second'"), second), "⌘Z dropped the committed text")
        XCTAssertLessThan(abs(second.frame.minX - flush), 2, "⌘Z undid a block step before the typing")

        app.typeKey(.leftArrow, modifierFlags: [.shift, .option])
        app.typeKey("b", modifierFlags: .command)
        let bold = app.buttons["Bold"]
        XCTAssertTrue(bold.waitForExistence(timeout: 5), "no format row over the selection")
        XCTAssertTrue(bold.wait(for: \.isSelected, toEqual: true, timeout: 5), "⌘B did not bold the selection")
        attach("command-b")

        app.typeKey("f", modifierFlags: .command)
        let find = app.textFields["Find in this note"]
        XCTAssertTrue(find.waitForExistence(timeout: 5), "⌘F did not open find")
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), find), "find's field has no caret")
        app.typeText("Second")
        XCTAssertTrue(app.staticTexts["1 match"].waitForExistence(timeout: 5), "find did not search")
        attach("command-f-find")
        app.buttons["find.close"].tap()

        deleteNotes([title])
    }

    func testTheSlashMenuTakesArrowsReturnAndEscape() throws {
        try openNotes()
        let title = "[agent] \(run) slash"
        makeNote(title)
        app.typeText("/heading")
        let rows = app.buttons.matching(identifier: "editor.suggestion")
        XCTAssertTrue(rows.element(boundBy: 1).waitForExistence(timeout: 5), "the slash menu did not open")
        XCTAssertEqual(rows.element(boundBy: 1).label, "Heading 2")
        app.typeKey(.downArrow, modifierFlags: [])
        XCTAssertTrue(rows.element(boundBy: 1).wait(for: \.isSelected, toEqual: true, timeout: 5), "↓ did not move the highlight")
        attach("slash-highlight")
        app.typeText("\n")
        XCTAssertTrue(rows.firstMatch.waitForNonExistence(timeout: 5), "Return did not pick the row")
        let turnInto = app.buttons["Turn into"]
        XCTAssertTrue(matches(NSPredicate(format: "value == 'H2'"), turnInto), "Return picked \(turnInto.value ?? "") over Heading 2")

        // Esc is ⌘. on the simulator.
        app.typeText("/")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5), "the slash menu did not open")
        app.typeKey(".", modifierFlags: .command)
        XCTAssertTrue(rows.firstMatch.waitForNonExistence(timeout: 5), "Esc did not close the menu")
        app.typeText("x")
        XCTAssertFalse(rows.firstMatch.exists, "the closed menu came back while typing in its trigger")

        deleteNotes([title])
    }

    // MARK: Helpers

    private func block(_ index: Int) -> XCUIElement {
        app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).element(boundBy: index)
    }

    private func wait(_ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }

    private func row(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    private func sidebarRow(_ title: String) -> XCUIElement {
        app.collectionViews.containing(.any, identifier: "magnifyingglass").firstMatch
            .cells.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func matches(_ predicate: NSPredicate, _ element: XCUIElement) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 10) == .completed
    }

    /// A new note titled `title`, left by Return: the caret moves to the
    /// first block. Return is typed as text: on the simulator
    /// `typeKey(.return)` does not reach the title, where a HID Return
    /// (`axe key 40`) does.
    private func makeNote(_ title: String) {
        let add = app.buttons["notes.addButton"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), field), "the new note's title has no caret")
        field.typeText("\(title)\n")
        XCTAssertTrue(block(0).waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), block(0)), "Return in the title did not move to the body")
        XCTAssertTrue(row(title).waitForExistence(timeout: 10), "the new note has no row in the list")
    }

    private func deleteNotes(_ titles: [String]) {
        for title in titles {
            let row = row(title)
            XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for \(title)")
            row.press(forDuration: 1)
            app.buttons["Delete note"].tap()
            app.buttons["Delete"].firstMatch.tap()
            XCTAssertTrue(row.waitForNonExistence(timeout: 10))
        }
    }

    private func attach(_ name: String) {
        Thread.sleep(forTimeInterval: 1)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func openNotes() throws {
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
        notes.tap()
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
    }
}
