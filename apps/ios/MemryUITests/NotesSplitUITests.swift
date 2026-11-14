import XCTest

// #4346: at regular width Notes is a split view. A note opened from the list,
// from search or from a wiki link fills the detail column, and the list stays
// on screen beside it.
//
// **Precondition:** an iPad simulator with a vault open (the staging test
// account, or a free vault on this device). A run that lands on sign-in, or on
// a compact window, skips; a skip is not a pass. Every note a test writes is
// titled `[agent] <run>…` and deleted by the test.
@MainActor
final class NotesSplitUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "split-\(UUID().uuidString.prefix(6).lowercased())"
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDown() async throws {
        XCUIDevice.shared.orientation = .portrait
    }

    func testARowOpensItsNoteBesideTheList() throws {
        try openNotes()
        attach("empty-detail-landscape")
        XCUIDevice.shared.orientation = .portrait
        attach("empty-detail-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        let first = "[agent] \(run) first"
        let second = "[agent] \(run) second"
        makeNote(first)
        makeNote(second)

        row(first).tap()
        XCTAssertTrue(page(first).waitForExistence(timeout: 10), "the row did not open its note")
        XCTAssertTrue(row(second).isHittable, "the list left the screen")
        XCTAssertTrue(row(first).wait(for: \.isSelected, toEqual: true, timeout: 5), "the row is not selected")
        attach("note-landscape")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(page(first).waitForExistence(timeout: 10))
        attach("note-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft

        // D6: the last opened note comes back after a relaunch.
        app.terminate()
        try openNotes()
        XCTAssertTrue(page(first).waitForExistence(timeout: 10), "the last opened note did not come back")

        deleteNotes([first, second])
    }

    /// A title typed into a new note and left by picking another row, with no
    /// Return, lands in the list and survives a relaunch.
    func testANewNotesTitleSurvivesPickingAnotherRow() throws {
        try openNotes()
        let other = "[agent] \(run) other"
        let title = "[agent] \(run) typed"
        makeNote(other)
        app.buttons["notes.addButton"].firstMatch.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), field), "the new note's title has no caret")
        field.typeText(title)
        row(other).tap()
        XCTAssertTrue(page(other).waitForExistence(timeout: 10))
        XCTAssertTrue(row(title).waitForExistence(timeout: 10), "the typed title did not reach the list")
        app.terminate()
        try openNotes()
        XCTAssertTrue(row(title).waitForExistence(timeout: 10), "the typed title did not survive a relaunch")
        deleteNotes([title, other])
    }

    /// With the caret in a note's body, the list's "+" opens a new note, and
    /// the next typing lands in the new note's title, not in the open body.
    func testPlusWithTheCaretInABodyTypesIntoTheNewNote() throws {
        try openNotes()
        XCUIDevice.shared.orientation = .portrait
        let open = "[agent] \(run) open"
        let typed = "[agent] \(run) next"
        makeNote(open).typeText("Body text here.")
        XCTAssertTrue(matches(NSPredicate(format: "value CONTAINS 'Body text here.'"), firstBlock))

        app.buttons["notes.addButton"].firstMatch.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "+ did not open a new note")
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), field), "the new note's title has no caret")
        app.typeText("\(typed)\n")
        XCTAssertTrue(page(typed).waitForExistence(timeout: 10), "the typing did not reach the new note's title")

        row(open).tap()
        XCTAssertTrue(page(open).waitForExistence(timeout: 10))
        let kept = matches(NSPredicate(format: "value CONTAINS 'Body text here.'"), firstBlock)
        attach("open-note-after-plus")
        let body = firstBlock.value as? String ?? ""
        XCTAssertTrue(kept, "the open note's body was emptied: \(body)")
        XCTAssertFalse(body.contains(typed), "the typing landed in the open note's body: \(body)")
        XCUIDevice.shared.orientation = .landscapeLeft
        deleteNotes([open, typed])
    }

    /// `DESIGN.md` › Tablet: three columns in 13" landscape, two (the list
    /// and the note) in portrait and beside the app's page sidebar.
    func testColumnsFollowTheWidth() throws {
        try openNotes()
        let list = app.buttons["notes.addButton"].firstMatch
        XCTAssertTrue(list.isHittable, "beside the page sidebar the list is hidden")
        XCTAssertFalse(treeShown(), "beside the page sidebar the tree takes a column")
        if app.windows.firstMatch.frame.width >= 1300 {
            togglePageSidebar()
            attach("columns-three")
            XCTAssertTrue(treeShown(), "13\" landscape hides the tree")
            XCTAssertTrue(list.isHittable, "13\" landscape hides the list")
            togglePageSidebar()
        }
        XCUIDevice.shared.orientation = .portrait
        attach("columns-portrait")
        XCTAssertFalse(treeShown(), "portrait shows the tree")
        XCTAssertTrue(list.isHittable, "portrait hides the list")
    }

    func testAWikiLinkOpensInTheDetailColumnAndBackReturns() throws {
        try openNotes()
        let target = "[agent] \(run) target"
        let source = "[agent] \(run) source"
        makeNote(target)
        makeNote(source).tap()
        // The query skips the title's own brackets: `]` ends a typed link.
        app.typeText("[[\(run) target")
        let pick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", target)).firstMatch
        XCTAssertTrue(pick.waitForExistence(timeout: 10), "the [[ menu did not offer the note")
        pick.tap()

        let block = firstBlock
        XCTAssertTrue(
            matches(NSPredicate(format: "value BEGINSWITH %@", "\u{FFFC}"), block),
            "no chip: \(block.value as? String ?? "")"
        )
        block.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 48, dy: 0)).tap()
        XCTAssertTrue(page(target).waitForExistence(timeout: 10), "the link did not open \(target)")
        XCTAssertTrue(row(source).isHittable, "the link pushed over the list")
        attach("wiki-link")
        app.buttons["BackButton"].firstMatch.tap()
        XCTAssertTrue(page(source).waitForExistence(timeout: 10), "Back did not return to the linking note")

        deleteNotes([source, target])
    }

    /// #4426 (D3): the Search row opens the palette; ↓ moves the highlight
    /// to the second hit and Return opens that one in the detail column.
    func testTheSearchPaletteOpensTheHighlightedHitInTheDetailColumn() throws {
        try openNotes()
        let first = "[agent] \(run) found one"
        let second = "[agent] \(run) found two"
        makeNote(first)
        makeNote(second)

        sidebarRow("Search").tap()
        let field = app.textFields["search.palette.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "the Search row did not open the palette")
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), field), "the palette's field has no caret")
        field.typeText("\(run) found")
        let hits = app.buttons.matching(identifier: "search.result.note")
            .matching(NSPredicate(format: "label CONTAINS %@", "\(run) found"))
        XCTAssertTrue(hits.element(boundBy: 1).waitForExistence(timeout: 15), "search did not find both notes")
        let highlighted = hits.matching(NSPredicate(format: "isSelected == true"))
        XCTAssertEqual(highlighted.firstMatch.label, hits.element(boundBy: 0).label, "the first hit is not highlighted")
        attach("search-palette")

        field.typeKey(.downArrow, modifierFlags: [])
        XCTAssertTrue(hits.element(boundBy: 1).wait(for: \.isSelected, toEqual: true, timeout: 5), "↓ did not move the highlight")
        let target = hits.element(boundBy: 1).label.contains("found two") ? second : first
        field.typeText("\n")
        XCTAssertTrue(field.waitForNonExistence(timeout: 5), "Return did not close the palette")
        XCTAssertTrue(page(target).waitForExistence(timeout: 10), "Return did not open the hit in the detail column")
        XCTAssertTrue(row(target).wait(for: \.isSelected, toEqual: true, timeout: 5), "the hit's row is not selected")
        attach("search-hit")

        deleteNotes([first, second])
    }

    /// #4426: ⌘K opens the palette while the editor has the caret, and Esc
    /// (⌘. on the simulator) closes it.
    func testCommandKOpensThePaletteFromTheEditor() throws {
        try openNotes()
        let title = "[agent] \(run) editing"
        makeNote(title).typeText("Body")
        app.typeKey("k", modifierFlags: .command)
        let field = app.textFields["search.palette.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "⌘K did not open the palette from the editor")
        app.typeKey(".", modifierFlags: .command)
        XCTAssertTrue(field.waitForNonExistence(timeout: 5), "Esc did not close the palette")
        deleteNotes([title])
    }

    /// #4376: the page menu's Full width writes the note's `fullWidth`,
    /// which survives a relaunch with the body untouched, and toggles back.
    func testFullWidthIsKeptOnTheNote() throws {
        try openNotes()
        let title = "[agent] \(run) wide"
        let body = "Body kept across the width toggle."
        app.buttons["notes.addButton"].firstMatch.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("\(title)\n")
        XCTAssertTrue(firstBlock.waitForExistence(timeout: 10))
        firstBlock.tap()
        // Return commits the line: typing is committed when editing ends, and
        // `terminate()` is a kill that never resigns the app (#2820).
        firstBlock.typeText("\(body)\n")
        XCTAssertTrue(matches(NSPredicate(format: "value CONTAINS %@", body), firstBlock))
        XCTAssertFalse(fullWidthIsOn(), "a new note starts at the device's Normal width")

        toggleFullWidth()
        XCTAssertTrue(fullWidthIsOn(), "the toggle did not turn Full width on")

        app.terminate()
        try openNotes()
        row(title).tap()
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "value CONTAINS %@", body), firstBlock),
                      "the body did not survive the width write")
        XCTAssertTrue(fullWidthIsOn(), "the note's Full width did not survive a relaunch")

        toggleFullWidth()
        XCTAssertFalse(fullWidthIsOn(), "the toggle did not turn Full width off")
        deleteNotes([title])
    }

    // MARK: Helpers

    /// The page menu's Full width row, the menu left open.
    private func fullWidthRow() -> XCUIElement {
        let menu = app.buttons["More actions for this note"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        let toggle = app.descendants(matching: .any).matching(identifier: "note.more.fullWidth").firstMatch
        // With the caret in the body, the first tap can go to the editor.
        for _ in 0 ..< 3 where !toggle.exists {
            menu.tap()
            _ = toggle.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(toggle.exists, "the page menu has no Full width")
        return toggle
    }

    private func toggleFullWidth() {
        fullWidthRow().tap()
    }

    /// Reads the row's checkmark, then closes the menu.
    private func fullWidthIsOn() -> Bool {
        let row = fullWidthRow()
        let on = row.isSelected || (row.value as? String) == "1"
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.98)).tap()
        _ = row.waitForNonExistence(timeout: 5)
        return on
    }

    /// Whether the folder tree has a column on screen. Its root row's label
    /// and icon share the identifier, so any hittable match counts.
    private func treeShown() -> Bool {
        let rows = app.descendants(matching: .any).matching(identifier: "notes.sidebar.root")
        return rows.allElementsBoundByIndex.contains(where: \.isHittable)
    }

    /// The app's page sidebar's own button, the leftmost sidebar toggle.
    private func togglePageSidebar() {
        let toggles = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'sidebar'")).allElementsBoundByIndex
        let toggle = toggles.filter(\.isHittable).min { $0.frame.minX < $1.frame.minX }
        XCTAssertNotNil(toggle, "no sidebar button: \(toggles.map(\.label))")
        toggle?.tap()
    }

    private var firstBlock: XCUIElement {
        app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).firstMatch
    }

    /// A note list row by title.
    private func row(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    /// The detail column showing `title`.
    private func page(_ title: String) -> XCUIElement {
        app.textFields.matching(NSPredicate(format: "value == %@", title)).firstMatch
    }

    private func sidebarRow(_ title: String) -> XCUIElement {
        app.collectionViews.containing(.any, identifier: "magnifyingglass").firstMatch
            .cells.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func matches(_ predicate: NSPredicate, _ element: XCUIElement) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 10) == .completed
    }

    /// A new note from the list column's toolbar button, titled `title`;
    /// answers its first block.
    @discardableResult
    private func makeNote(_ title: String) -> XCUIElement {
        let add = app.buttons["notes.addButton"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        // A new note opens with the caret in its title, as on the phone.
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), field), "the new note's title has no caret")
        field.typeText("\(title)\n")
        XCTAssertTrue(firstBlock.waitForExistence(timeout: 10))
        XCTAssertTrue(row(title).waitForExistence(timeout: 10), "the new note has no row in the list")
        return firstBlock
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
        Thread.sleep(forTimeInterval: 2)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func openNotes() throws {
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
        notes.tap()
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
    }
}
