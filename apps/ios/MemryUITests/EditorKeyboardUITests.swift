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
        second.tap()
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), second), "the block took no caret")
        app.typeKey("f", modifierFlags: .command)
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), find), "a second ⌘F did not re-focus find")
        app.buttons["find.close"].tap()

        try deleteNotes([title])
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

        try deleteNotes([title])
    }

    /// #4705: a title, its Return and the body's first words typed in one
    /// burst: the title lands whole and the words land in the first block,
    /// after a relaunch too.
    func testABurstThroughTheTitlesReturnKeepsEveryKey() throws {
        try openNotes()
        let title = "[agent] \(run) F1 paragraph"
        let add = app.buttons["notes.addButton"].firstMatch
        add.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), field), "the new note's title has no caret")
        field.typeText("\(title)\nbody words")
        XCTAssertTrue(matches(NSPredicate(format: "value == 'body words'"), block(0)), "the body did not get the keys after Return")
        XCTAssertTrue(matches(NSPredicate(format: "value == %@", title), field), "the title lost keys")
        XCTAssertTrue(row(title).waitForExistence(timeout: 10), "the stored title is not the typed one")

        // Leaving the app ends the block's edit, which saves its typing.
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.terminate()
        try openNotes()
        let stored = row(title)
        XCTAssertTrue(stored.waitForExistence(timeout: 10), "the stored title is not the typed one")
        stored.tap()
        XCTAssertTrue(matches(NSPredicate(format: "value == 'body words'"), block(0)), "the stored body is not the typed one")

        try deleteNotes([title])
    }

    /// #4705: a hardware Return key in the title arrives as a submit, not as
    /// a newline. The words typed right after it land in the first block.
    func testTheReturnKeyInTheTitleMovesTheNextKeysToTheBody() throws {
        try openNotes()
        let title = "[agent] \(run) return key"
        app.buttons["notes.addButton"].firstMatch.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), field), "the new note's title has no caret")
        field.typeText(title)
        app.pressReturnKey()
        app.typeText("body words")
        XCTAssertTrue(matches(NSPredicate(format: "value == 'body words'"), block(0)), "the body did not get the keys after Return")
        XCTAssertTrue(matches(NSPredicate(format: "value == %@", title), field), "the title lost or gained keys")
        XCTAssertTrue(row(title).waitForExistence(timeout: 10), "the stored title is not the typed one")
        try deleteNotes([title])
    }

    /// #4705: Return as the last key of a burst in the title moves the caret
    /// to the body, so the words typed after a pause land there, each Return
    /// starting a block.
    func testTheReturnKeyEndingATitleBurstHandsTheCaretToTheBody() throws {
        try openNotes()
        let title = "[agent] \(run) last return"
        app.buttons["notes.addButton"].firstMatch.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), field), "the new note's title has no caret")
        field.typeText(title)
        app.pressReturnKey()
        Thread.sleep(forTimeInterval: 2)
        for (index, word) in ["one", "two", "three"].enumerated() {
            if index > 0 { app.pressReturnKey() }
            app.typeText(word)
        }
        // A new block may capitalise its first letter.
        XCTAssertTrue(matches(NSPredicate(format: "value ==[c] 'three'"), block(2)), "the words after Return did not make three blocks")
        XCTAssertEqual((block(0).value as? String)?.lowercased(), "one")
        XCTAssertEqual((block(1).value as? String)?.lowercased(), "two")
        XCTAssertTrue(matches(NSPredicate(format: "value == %@", title), field), "the title lost or gained keys")
        try deleteNotes([title])
    }

    /// #4705 smoke test: Return in the title after the app comes back moves
    /// to the body, with the keys typed after it. It passes before #4705 too:
    /// a plain resume does not end the edit under the caret. That case (a
    /// reload on resume) is pinned by the hosted `NoteTitleBurstTests`.
    func testSmokeTitleReturnAfterResumeReachesTheBody() throws {
        try openNotes()
        let title = "[agent] \(run) resumed title"
        app.buttons["notes.addButton"].firstMatch.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText(title)

        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), field), "the title lost the caret")
        field.typeText("\nbody words")
        XCTAssertTrue(matches(NSPredicate(format: "value == 'body words'"), block(0)), "Return left the keys in the title")
        XCTAssertTrue(matches(NSPredicate(format: "value == %@", title), field), "the title changed")

        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        app.terminate()
        try openNotes()
        let stored = row(title)
        XCTAssertTrue(stored.waitForExistence(timeout: 10), "the stored title is not the typed one")
        stored.tap()
        XCTAssertTrue(matches(NSPredicate(format: "value == 'body words'"), block(0)), "the stored body is not the typed one")

        try deleteNotes([title])
    }

    /// In portrait the keyboard, or a panel that replaces it, leaves the
    /// window less height than width. The first Turn into of a launch opened
    /// the shell's sidebar over the note and the panel closed.
    func testTurnIntoInPortraitOpensItsPanelWithTheSidebarClosed() throws {
        try openNotes()
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 30), "Notes did not come back on launch")
        let title = "[agent] \(run) turn into"
        makeNote(title)
        app.typeText("Words")

        app.buttons["Turn into"].tap()
        XCTAssertTrue(app.buttons["Bulleted list"].waitForExistence(timeout: 5), "Turn into did not open its panel")
        Thread.sleep(forTimeInterval: 1)
        attach("turn-into-portrait")
        XCTAssertFalse(sidebarRow("Settings").exists, "the sidebar opened over the note")
        XCTAssertTrue(app.buttons["Bulleted list"].exists, "the panel closed")
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), block(0)), "the block lost the caret")

        app.buttons["Turn into"].tap()
        try deleteNotes([title])
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

    /// Deletes by the row's swipe, from a fresh launch. The row's context
    /// menu cost two of XCTest's 60 s idle waits per note: on the iPadOS 26
    /// simulator an open context menu never reports its animations done,
    /// Photos' own included. Relaunched, no block holds the caret, so the
    /// swipe's touch brings no on-screen keyboard up over the question.
    private func deleteNotes(_ titles: [String]) throws {
        app.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        try openNotes()
        for title in titles {
            let row = row(title)
            XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for \(title)")
            row.swipeLeft()
            let question = app.sheets["Delete this note?"]
            // A swipe across a narrow list runs its Delete action itself.
            if !question.waitForExistence(timeout: 2) { app.buttons["trash"].firstMatch.tap() }
            XCTAssertTrue(question.waitForExistence(timeout: 5), "Delete asked nothing")
            question.buttons["Delete"].tap()
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
        app.primeCommandKeys()
    }
}
