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

    func testASearchHitOpensInTheDetailColumn() throws {
        try openNotes()
        let title = "[agent] \(run) found"
        let other = "[agent] \(run) other"
        makeNote(title)
        makeNote(other)

        sidebarRow("Search").tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText(run + " found")
        let hit = app.buttons.matching(identifier: "search.result.note")
            .matching(NSPredicate(format: "label CONTAINS %@", "\(run) found")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 15), "search did not find the note")
        hit.tap()
        XCTAssertTrue(page(title).waitForExistence(timeout: 10), "the hit did not open in the detail column")
        XCTAssertTrue(row(title).wait(for: \.isSelected, toEqual: true, timeout: 5), "the hit's row is not selected")
        attach("search-hit")

        deleteNotes([title, other])
    }

    /// #4347: the inspector's outline scrolls the note to a heading.
    func testAnOutlineEntryScrollsTheNote() throws {
        try openNotes()
        let title = "[agent] \(run) outline"
        makeNote(title).tap()
        app.typeText("# \(run) top\n")
        // A line at a time: a long burst outruns the editor's Return on a
        // busy simulator and merges lines.
        for line in 1...40 {
            app.typeText("Line \(line)\n")
            let typed = app.textViews.matching(NSPredicate(
                format: "identifier BEGINSWITH 'note.block.' AND value == %@", "Line \(line)"
            )).firstMatch
            XCTAssertTrue(typed.waitForExistence(timeout: 10), "line \(line) did not get its own block")
        }
        // Return commits the line: the outline lists the note as saved, which
        // trails the typing inside a line.
        app.typeText("## \(run) far\n")
        try showInspector()

        let top = heading("\(run) top")
        let far = heading("\(run) far")
        outlineEntry("\(run) top").tap()
        XCTAssertTrue(top.wait(for: \.isHittable, toEqual: true, timeout: 5), "the outline did not scroll to the top heading")
        XCTAssertFalse(far.isHittable, "the note is too short to prove a scroll")
        attach("inspector-outline-top")
        let farEntry = outlineEntry("\(run) far")
        XCTAssertTrue(farEntry.waitForExistence(timeout: 15), "the outline does not list the far heading")
        farEntry.tap()
        XCTAssertTrue(far.wait(for: \.isHittable, toEqual: true, timeout: 5), "the outline did not scroll to the far heading")
        attach("inspector-outline-far")

        hideInspector()
        attach("inspector-closed-landscape")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        XCTAssertFalse(inspectorToggle.exists, "13\" portrait cannot hold the note column and the rail")
        attach("inspector-hidden-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        deleteNotes([title])
    }

    /// #4347: a backlink in the inspector opens its note in the detail column.
    func testABacklinkInTheInspectorOpensInTheDetailColumn() throws {
        try openNotes()
        let target = "[agent] \(run) linked"
        let source = "[agent] \(run) linking"
        makeNote(target)
        makeNote(source).tap()
        app.typeText("[[\(run) linked")
        let pick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", target)).firstMatch
        XCTAssertTrue(pick.waitForExistence(timeout: 10), "the [[ menu did not offer the note")
        pick.tap()
        row(target).tap()
        XCTAssertTrue(page(target).waitForExistence(timeout: 10))
        try showInspector()

        let backlink = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'note.backlink.' AND label CONTAINS %@", source
        )).firstMatch
        XCTAssertTrue(backlink.waitForExistence(timeout: 15), "the inspector lists no backlink from \(source)")
        attach("inspector-backlinks")
        backlink.tap()
        XCTAssertTrue(page(source).waitForExistence(timeout: 10), "the backlink did not open \(source)")
        XCTAssertTrue(
            app.descendants(matching: .any)["note.inspector"].waitForExistence(timeout: 5),
            "the opened note has no inspector"
        )
        attach("inspector-backlink-opened")

        hideInspector()
        deleteNotes([source, target])
    }

    // MARK: Helpers

    private var inspectorToggle: XCUIElement { app.buttons["note.inspector.toggle"].firstMatch }

    /// Opens the note inspector; skips where the window cannot hold it.
    private func showInspector() throws {
        guard inspectorToggle.waitForExistence(timeout: 5) else {
            attach("inspector-unavailable")
            throw XCTSkip("The window cannot hold the inspector: run on a 13\" iPad in landscape.")
        }
        let rail = app.descendants(matching: .any)["note.inspector"]
        if !rail.exists { inspectorToggle.tap() }
        XCTAssertTrue(rail.waitForExistence(timeout: 5), "the inspector did not open")
    }

    /// Closes the inspector, so the list comes back and the next run starts
    /// from the default.
    private func hideInspector() {
        if inspectorToggle.waitForExistence(timeout: 3), inspectorToggle.label == "Hide inspector" { inspectorToggle.tap() }
        XCTAssertTrue(app.buttons["notes.addButton"].firstMatch.waitForExistence(timeout: 10), "the list did not come back")
    }

    private func outlineEntry(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'note.outline.' AND label CONTAINS %@", title)).firstMatch
    }

    /// A heading block in the note body.
    private func heading(_ text: String) -> XCUIElement {
        app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.' AND value CONTAINS %@", text)).firstMatch
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
        // An earlier run may have left the inspector open, which hides the list.
        hideInspector()
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
    }
}
