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

    /// #2922: the note page menu's Rename dialog opened empty, so typing
    /// replaced the title instead of editing it.
    func testRenameFromTheNotePageMenuStartsFromTheCurrentTitle() throws {
        try openNotes()
        let title = "[agent] \(run) rename"
        app.buttons["notes.addButton"].tap()
        let titleField = app.textFields["Title"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 10))
        titleField.typeText(title)
        app.buttons["BackButton"].tap()
        // Relaunched for the stored title, as the test above does.
        app.terminate()
        try openNotes()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()

        app.buttons["More actions for this note"].firstMatch.tap()
        app.buttons["Rename"].firstMatch.tap()
        let alert = app.alerts["Rename this note"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertEqual(alert.textFields.firstMatch.value as? String, title)
        alert.buttons["Cancel"].tap()

        app.buttons["BackButton"].tap()
        row.press(forDuration: 1)
        app.buttons["Delete note"].tap()
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }

    /// #4152: Backspace at a block's start did nothing in a paragraph, so an
    /// empty line could not be deleted and two lines could not be joined.
    func testBackspaceDeletesAnEmptyLineAndJoinsLines() throws {
        try openNotes()
        let title = "[agent] SHIP-4152-\(run) backspace"
        app.buttons["notes.addButton"].tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText("\(title)\n")
        let block = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).firstMatch
        XCTAssertTrue(block.waitForExistence(timeout: 10))
        block.tap()
        app.typeText("a")
        assertBackspaceJoinsBlocks(in: app, line: "a")

        app.buttons["BackButton"].tap()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.press(forDuration: 1)
        app.buttons["Delete note"].tap()
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }

    /// #4152: after one join, the lines below it are drawn by the rows above
    /// them. A second Backspace further down put the caret in the row that
    /// then went away, so the caret and the keyboard went with it.
    func testBackspaceKeepsTheCaretAfterAnEarlierJoin() throws {
        try openNotes()
        let title = "[agent] SHIP-4152-\(run) second join"
        makeNote(title).tap()
        let blocks = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'"))
        let newLine = blocks.matching(NSPredicate(format: "hasKeyboardFocus == true AND value == ''")).firstMatch
        for line in ["one", "two", "three"] {
            app.typeText(line + "\n")
            XCTAssertTrue(newLine.waitForExistence(timeout: 10), "Return made no block")
        }
        app.typeText("four")
        func line(_ text: String) -> XCUIElement {
            blocks.matching(NSPredicate(format: "value == %@", text)).firstMatch
        }
        func backspace(atStartOf text: String) {
            let block = line(text)
            XCTAssertTrue(block.waitForExistence(timeout: 10), "no line \(text)")
            block.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 1, dy: 0)).tap()
            app.typeText(XCUIKeyboardKey.delete.rawValue)
        }
        backspace(atStartOf: "two")
        XCTAssertTrue(line("onetwo").waitForExistence(timeout: 10), "the first join did not land")
        backspace(atStartOf: "four")
        XCTAssertTrue(line("threefour").waitForExistence(timeout: 10), "the second join did not land")
        let joined = blocks.matching(NSPredicate(format: "hasKeyboardFocus == true AND value == 'threefour'"))
            .firstMatch
        XCTAssertTrue(joined.waitForExistence(timeout: 10), "the caret did not stay in the joined line")
        app.typeText("X")
        XCTAssertTrue(line("threeXfour").waitForExistence(timeout: 10), "the caret is not at the join")

        app.buttons["BackButton"].tap()
        deleteFromList(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch)
    }

    /// #4151: a tap in the empty space under a stored note's body did
    /// nothing when the body ended in an empty line, so a short note could
    /// not be typed into.
    func testTappingUnderTheBodyStartsTyping() throws {
        try openNotes()
        let title = "[agent] SHIP-4151-\(run) tap body"
        app.buttons["notes.addButton"].tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        // Return leaves the body as one empty line.
        field.typeText("\(title)\n")
        let blocks = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'"))
        XCTAssertTrue(blocks.firstMatch.waitForExistence(timeout: 10))
        app.buttons["BackButton"].tap()
        // Relaunched, so the page reads the stored note.
        app.terminate()
        try openNotes()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(blocks.firstMatch.waitForExistence(timeout: 10))

        let body = blocks.allElementsBoundByIndex.map(\.frame.maxY).max() ?? 0
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: blocks.firstMatch.frame.midX, dy: body + 60)).tap()
        app.typeText("tapped")
        let typed = app.textViews.matching(NSPredicate(
            format: "identifier BEGINSWITH 'note.block.' AND value CONTAINS 'tapped'"
        )).firstMatch
        XCTAssertTrue(typed.waitForExistence(timeout: 10), "the tap under the body put no caret in it")
        XCTAssertEqual(field.value as? String, title)

        deleteFromList(row)
    }

    /// #4151: a callout drew as static text, so a tap gave no caret.
    func testACalloutsTextIsEditable() throws {
        try openNotes()
        let title = "[agent] SHIP-4151-\(run) callout"
        app.buttons["notes.addButton"].tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText("\(title)\n")
        let block = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).firstMatch
        XCTAssertTrue(block.waitForExistence(timeout: 10))
        block.tap()
        app.typeText("/callout\n")
        // The turn redraws the row; the caret comes back once it lands.
        let focused = app.textViews.matching(NSPredicate(
            format: "identifier BEGINSWITH 'note.block.' AND hasKeyboardFocus == true"
        )).firstMatch
        XCTAssertTrue(focused.waitForExistence(timeout: 10), "the callout took no caret")
        app.typeText("inside")
        let typed = app.textViews.matching(NSPredicate(
            format: "identifier BEGINSWITH 'note.block.' AND value CONTAINS 'inside'"
        )).firstMatch
        XCTAssertTrue(typed.waitForExistence(timeout: 10), "the callout took no typing")
        XCTAssertTrue(app.images["Info callout"].exists, "the block is not a callout")

        // Put the caret in the title, then tap back into the callout's text.
        // Typing that misses the callout lands in the title.
        field.tap()
        typed.tap()
        app.typeText("again")
        let retyped = app.textViews.matching(NSPredicate(
            format: "identifier BEGINSWITH 'note.block.' AND value CONTAINS 'again'"
        )).firstMatch
        XCTAssertTrue(retyped.waitForExistence(timeout: 10), "a tap in the callout took no typing")
        XCTAssertEqual(field.value as? String, title)

        app.buttons["BackButton"].tap()
        deleteFromList(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch)
    }

    private func deleteFromList(_ row: XCUIElement) {
        if app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.press(forDuration: 1)
        app.buttons["Delete note"].tap()
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }

    /// #4154: a link picked from the `[[` menu is a chip a tap follows to its
    /// note.
    func testAPickedLinkOpensItsNote() throws {
        try openNotes()
        let target = "SHIP-4154-\(run)-picked"
        let source = "SHIP-4154-\(run)-pick-source"
        _ = makeNote(target)
        app.buttons["BackButton"].tap()
        makeNote(source).tap()
        app.typeText("[[\(target)")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", target)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the [[ menu did not offer the note")
        row.tap()
        follow(to: target)
        deleteNotes([source, target])
    }

    /// #4154: the `[[` menu's Create row linked a note it never created, so a
    /// tap on the chip said the note does not exist.
    func testTheCreateRowMakesTheNoteItLinks() throws {
        try openNotes()
        let target = "SHIP-4154-\(run)-created"
        let source = "SHIP-4154-\(run)-create-source"
        makeNote(source).tap()
        app.typeText("[[\(target)")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Create'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the [[ menu offered no Create row")
        row.tap()
        follow(to: target)
        deleteNotes([source, target])
    }

    /// #4154: typing `[[Title]]` in full made the chip on the first `]`, and
    /// the second `]` stayed in the text.
    func testATypedLinkLeavesNoBracketBehind() throws {
        try openNotes()
        let target = "SHIP-4154-\(run)-typed"
        let source = "SHIP-4154-\(run)-type-source"
        _ = makeNote(target)
        app.buttons["BackButton"].tap()
        let block = makeNote(source)
        block.tap()
        app.typeText("[[\(target)]]x")
        let typed = NSPredicate(format: "value == %@", "\u{FFFC}x")
        XCTAssertTrue(
            matches(typed, block),
            "the typed link is not one chip: \(block.value as? String ?? "")"
        )
        follow(to: target)
        deleteNotes([source, target])
    }

    private func matches(_ predicate: NSPredicate, _ element: XCUIElement) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 10) == .completed
    }

    private var firstBlock: XCUIElement {
        app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).firstMatch
    }

    /// A new note titled `title`; answers its first block.
    @discardableResult
    private func makeNote(_ title: String) -> XCUIElement {
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
        app.buttons["notes.addButton"].tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText("\(title)\n")
        XCTAssertTrue(firstBlock.waitForExistence(timeout: 10))
        return firstBlock
    }

    /// Taps the first half of the link chip at the start of the first block
    /// and waits for its note's page, then goes back to the list. Not the
    /// chip's first points: the screen's edge takes a tap there while a block
    /// edits.
    private func follow(to target: String) {
        let block = firstBlock
        let chip = NSPredicate(format: "value BEGINSWITH %@", "\u{FFFC}")
        XCTAssertTrue(matches(chip, block), "no chip: \(block.value as? String ?? "")")
        block.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 48, dy: 0)).tap()
        XCTAssertFalse(app.alerts.firstMatch.waitForExistence(timeout: 2), "the link opened no note")
        let page = app.textFields.matching(NSPredicate(format: "value == %@", target)).firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the link did not open \(target)")
        app.buttons["BackButton"].tap()
        app.buttons["BackButton"].tap()
    }

    private func deleteNotes(_ titles: [String]) {
        for title in titles {
            let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for \(title)")
            row.press(forDuration: 1)
            app.buttons["Delete note"].tap()
            app.buttons["Delete"].firstMatch.tap()
            XCTAssertTrue(row.waitForNonExistence(timeout: 10))
        }
    }

    private func openNotes() throws {
        // A tip's popover covers the page and takes the next tap, on the
        // first note an install makes with "+".
        app.launchArguments = ["-MEMRY_HIDE_TIPS", "YES"]
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
