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

        try deleteNotes([first, second])
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
        try deleteNotes([title, other])
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
        try deleteNotes([open, typed])
    }

    /// `DESIGN.md` › Tablet: the list and the note at every width. The list
    /// is the split view's sidebar column, so with the page sidebar hidden it
    /// sits clear of the tab bar, which covers a content column's toolbar.
    func testTheListStaysBesideTheNoteClearOfTheTabBar() throws {
        try openNotes()
        let list = app.buttons["notes.addButton"].firstMatch
        XCTAssertTrue(list.isHittable, "beside the page sidebar the list is hidden")
        togglePageSidebar()
        XCTAssertTrue(sidebarRow("Tasks").wait(for: \.isHittable, toEqual: false, timeout: 5), "the page sidebar did not hide")
        attach("list-page-sidebar-hidden")
        XCTAssertTrue(list.isHittable, "hiding the page sidebar hid the list")
        assertClear(list, of: tabBar())
        assertClear(app.buttons["Sort by"].firstMatch, of: tabBar())
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: true, timeout: 5), "portrait hides the list")
        attach("list-portrait")
        assertClear(list, of: tabBar())
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 1)
        tabBarSidebarToggle()?.tap()
        XCTAssertTrue(sidebarRow("Tasks").wait(for: \.isHittable, toEqual: true, timeout: 5), "the page sidebar did not come back")
    }

    /// A folder opens on the list column's stack: Back returns to the folder
    /// tree, and a relaunch comes back inside the folder.
    func testAFolderOpensInTheListAndBackReturnsToTheTree() throws {
        try openNotes()
        let folder = "agent \(run)"
        app.buttons["notes.addButton"].firstMatch.press(forDuration: 1)
        let newFolder = app.buttons["notes.create.folder"].firstMatch
        XCTAssertTrue(newFolder.waitForExistence(timeout: 5), "holding + showed no New folder")
        newFolder.tap()
        let create = app.buttons["Create"].firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        app.typeText(folder)
        create.tap()
        let folderRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", folder)).firstMatch
        XCTAssertTrue(folderRow.waitForExistence(timeout: 10), "the new folder has no row")
        folderRow.tap()
        let openFolder = app.buttons["Open folder"].firstMatch
        XCTAssertTrue(openFolder.waitForExistence(timeout: 5), "the selected folder has no arrow")
        openFolder.tap()
        let back = app.buttons["BackButton"].firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 5), "the folder has no Back")
        XCTAssertTrue(app.navigationBars[folder].exists, "the list column does not show the folder")
        attach("folder-open")

        // D6: the folder comes back after a relaunch, and Back still leads home.
        app.terminate()
        try openNotes()
        XCTAssertTrue(back.waitForExistence(timeout: 10), "a relaunch lost the open folder")
        back.tap()
        XCTAssertTrue(folderRow.waitForExistence(timeout: 10), "Back did not return to the folder tree")
        XCTAssertFalse(back.exists, "the folder tree shows Back")
        attach("tree-after-back")

        folderRow.press(forDuration: 1)
        let delete = app.buttons["Delete folder"].firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "the folder menu has no Delete folder")
        delete.tap()
        let confirm = app.buttons["Delete folder"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(folderRow.waitForNonExistence(timeout: 10))
    }

    /// The page sidebar hidden beside an open note comes back. Its way back
    /// is the tab bar at the top, which the note leaves on screen at
    /// regular width.
    func testThePageSidebarComesBackBesideAnOpenNote() throws {
        try openNotes()
        let title = "[agent] \(run) pages"
        addNote(title)
        // The sidebar's top row: on an iPad mini the keyboard covers its
        // lower rows.
        let searchRow = sidebarRow("Search")
        togglePageSidebar()
        XCTAssertTrue(searchRow.wait(for: \.isHittable, toEqual: false, timeout: 5), "the page sidebar did not hide")
        let tasks = app.buttons["Tasks"].firstMatch
        XCTAssertTrue(tasks.wait(for: \.isHittable, toEqual: true, timeout: 5), "no way to another page beside the note")
        attach("page-sidebar-hidden-beside-note")
        let toggle = tabBarSidebarToggle()
        XCTAssertNotNil(toggle, "the tab bar has no sidebar button")
        toggle?.tap()
        XCTAssertTrue(searchRow.wait(for: \.isHittable, toEqual: true, timeout: 5), "the page sidebar did not come back")
        try deleteNotes([title])
    }

    /// #4380: the Day Panel, open on the Journal by default, stays the
    /// Journal's. Back on Notes beside an open note, the list the user hid
    /// is still hidden.
    func testAListHiddenBesideANoteSurvivesAVisitToTheJournal() throws {
        try openNotes()
        let title = "[agent] \(run) column"
        makeNote(title)
        let list = app.buttons["notes.addButton"].firstMatch
        XCTAssertTrue(list.isHittable, "the list is not beside the note")
        toggleNotesSidebar()
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: false, timeout: 5), "the split view's sidebar button did not hide the list")
        attach("list-hidden")

        sidebarRow("Journal").tap()
        // Whichever level the Journal was left on.
        let journal = app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN {'journal.day', 'journal.month', 'journal.year'}"))
        XCTAssertTrue(journal.firstMatch.waitForExistence(timeout: 10), "the Journal did not open")
        sidebarRow("Notes").tap()
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1)
        attach("list-after-journal")
        XCTAssertFalse(list.isHittable, "returning to Notes brought back the list the user hid")
        toggleNotesSidebar()
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: true, timeout: 5), "the split view's sidebar button did not show the list")
        try deleteNotes([title])
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

        try deleteNotes([source, target])
    }

    /// #4357: a note row dragged from the list onto the open note links it
    /// there. The list is the split view's sidebar column, which reports a
    /// compact width, and the row still drags.
    func testANoteDraggedFromTheListLinksInTheOpenNote() throws {
        try openNotes()
        let target = "[agent] \(run) dragged"
        let source = "[agent] \(run) open"
        makeNote(target)
        makeNote(source)
        // The row's hold opens its context menu before the drag lifts, which
        // lowers an on-screen keyboard and moves the page under the drop: on
        // an iPad mini the drop then missed the block. Relaunched, the note
        // comes back with no caret (D6) and the page holds still, as under a
        // hardware keyboard.
        app.terminate()
        try openNotes()
        XCTAssertTrue(page(source).waitForExistence(timeout: 10), "the open note did not come back")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the note came back with the keyboard up")
        let block = firstBlock
        row(target).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(
            forDuration: 1,
            thenDragTo: block.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)),
            withVelocity: .slow,
            thenHoldForDuration: 1
        )
        XCTAssertTrue(
            matches(NSPredicate(format: "value BEGINSWITH %@", "\u{FFFC}"), block),
            "the drop left no link: \(block.value as? String ?? "")"
        )
        try deleteNotes([source, target])
    }

    /// #4377: a wiki link's menu opens its note beside the linking one, each
    /// pane takes typing, and ⌘⌥W closes the focused pane with both notes'
    /// typing kept.
    func testAWikiLinkOpensToTheSideAndBothPanesTakeTyping() throws {
        try openNotes()
        app.primeCommandKeys()
        let target = "[agent] \(run) side"
        let source = "[agent] \(run) main"
        makeNote(target)
        makeNote(source).tap()
        app.typeText("[[\(run) side")
        let pick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", target)).firstMatch
        XCTAssertTrue(pick.waitForExistence(timeout: 10), "the [[ menu did not offer the note")
        pick.tap()
        let chip = firstBlock.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 48, dy: 0))
        chip.press(forDuration: 1)
        let toSide = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Open to the Side'")).firstMatch
        XCTAssertTrue(toSide.waitForExistence(timeout: 5), "holding the link showed no Open to the Side")
        toSide.tap()

        let main = app.otherElements["notes.pane.main"]
        let side = app.otherElements["notes.pane.side"]
        XCTAssertTrue(side.waitForExistence(timeout: 10), "no side pane")
        XCTAssertTrue(side.textFields.matching(NSPredicate(format: "value == %@", target)).firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(main.textFields.matching(NSPredicate(format: "value == %@", source)).firstMatch.exists)
        XCTAssertTrue(matches(NSPredicate(format: "isSelected == true"), side), "the new pane has no focus")
        attach("two-panes")
        // #4699: each pane carries its own page menu, over its own note.
        let mainMenu = app.buttons["notes.pane.main.more"]
        let sideMenu = app.buttons["notes.pane.side.more"]
        XCTAssertTrue(mainMenu.waitForExistence(timeout: 5), "the main pane has no page menu")
        XCTAssertTrue(sideMenu.waitForExistence(timeout: 5), "the side pane has no page menu")
        assertOver(mainMenu, main)
        assertOver(sideMenu, side)
        // VoiceOver tells the two panes' identical controls apart.
        XCTAssertEqual(main.label, "Main pane")
        XCTAssertEqual(side.label, "Side pane")

        let sideBlock = block(in: side)
        sideBlock.tap()
        app.typeText("typed beside")
        let mainBlock = block(in: main)
        mainBlock.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        XCTAssertTrue(matches(NSPredicate(format: "isSelected == true"), main), "a tap did not move the focus")
        app.typeText(" typed main")
        attach("two-panes-typed")
        // The main pane's menu acts on the main pane's note, whichever pane
        // has the focus.
        sideBlock.tap()
        XCTAssertTrue(matches(NSPredicate(format: "isSelected == true"), side), "a tap did not move the focus")
        mainMenu.tap()
        let delete = app.buttons["trash"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "the page menu has no Delete")
        delete.tap()
        let alert = app.alerts["Delete \u{201c}\(source)\u{201d}?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "Delete does not name the main pane's note")
        attach("delete-names-the-note")
        alert.buttons["Cancel"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 5))

        // 13" portrait has no room for two panes: the focused one shows alone,
        // and the other comes back with the width.
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(side.waitForNonExistence(timeout: 5), "portrait kept two panes")
        XCTAssertTrue(page(source).exists, "portrait did not keep the focused pane")
        attach("collapsed-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(side.waitForExistence(timeout: 5), "landscape did not bring the side pane back")

        app.typeKey("w", modifierFlags: [.command, .option])
        XCTAssertTrue(side.waitForNonExistence(timeout: 5), "⌘⌥W did not close the split")
        XCTAssertTrue(page(target).waitForExistence(timeout: 10), "the side pane's note did not fill the column")
        XCTAssertTrue(matches(NSPredicate(format: "value CONTAINS 'typed beside'"), firstBlock), "the side pane's typing is gone")
        row(source).tap()
        XCTAssertTrue(page(source).waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "value CONTAINS 'typed main'"), firstBlock), "the main pane's typing is gone")

        try deleteNotes([source, target])
    }

    /// VERIFY-4700: a backlink's Open to the Side on a page a link pushed
    /// opens the backlink's note beside it, and the main pane keeps its
    /// stack: the pushed page, and the linking note behind it. A link
    /// followed in a pane then opens in that pane.
    func testABacklinkOnAPushedPageOpensToTheSide() throws {
        try openNotes()
        app.primeCommandKeys()
        let target = "[agent] \(run) gamma"
        let source = "[agent] \(run) alpha"
        makeNote(target)
        makeNote(source).tap()
        app.typeText("[[\(run) gamma")
        let pick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", target)).firstMatch
        XCTAssertTrue(pick.waitForExistence(timeout: 10), "the [[ menu did not offer the note")
        pick.tap()
        let chip = { (pane: XCUIElement) in
            self.block(in: pane).coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 48, dy: 0))
        }
        chip(app).tap()
        XCTAssertTrue(page(target).waitForExistence(timeout: 10), "the link did not open \(target)")
        let backlink = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'note.backlink.' AND label CONTAINS %@", source
        )).firstMatch
        XCTAssertTrue(backlink.waitForExistence(timeout: 30), "\(target) lists no backlink from \(source)")
        backlink.press(forDuration: 1)
        let toSide = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Open to the Side'")).firstMatch
        XCTAssertTrue(toSide.waitForExistence(timeout: 5), "holding the backlink showed no Open to the Side")
        toSide.tap()

        let main = app.otherElements["notes.pane.main"]
        let side = app.otherElements["notes.pane.side"]
        XCTAssertTrue(side.waitForExistence(timeout: 10), "no side pane")
        attach("backlink-to-the-side")
        let sidePage = side.textFields.matching(NSPredicate(format: "value == %@", source)).firstMatch
        XCTAssertTrue(sidePage.waitForExistence(timeout: 10), "the side pane does not show \(source)")
        XCTAssertTrue(sidePage.isHittable, "the side pane's page is covered")
        let mainPage = main.textFields.matching(NSPredicate(format: "value == %@", target)).firstMatch
        XCTAssertTrue(mainPage.waitForExistence(timeout: 10), "the main pane does not show \(target)")
        XCTAssertLessThan(mainPage.frame.maxX, sidePage.frame.minX, "the panes are not side by side")

        // #4699: Back sits over the pane it pops, and pops that pane only.
        let mainBack = app.buttons["notes.pane.main.back"]
        let sideBack = app.buttons["notes.pane.side.back"]
        XCTAssertTrue(mainBack.waitForExistence(timeout: 5), "the main pane, with a followed link, has no Back")
        XCTAssertFalse(sideBack.exists, "the side pane, with nothing followed, shows Back")
        assertOver(mainBack, main)
        assertOver(app.buttons["notes.pane.main.more"], main)
        assertOver(app.buttons["notes.pane.side.more"], side)
        mainBack.tap()
        let mainSource = main.textFields.matching(NSPredicate(format: "value == %@", source)).firstMatch
        XCTAssertTrue(mainSource.waitForExistence(timeout: 10), "Back in the main pane did not return to \(source)")
        XCTAssertTrue(sidePage.exists, "Back moved the side pane")
        XCTAssertTrue(mainBack.waitForNonExistence(timeout: 5), "the main pane kept Back with nothing to go back to")

        // A link followed in the side pane puts Back over the side pane.
        chip(side).tap()
        let sideTarget = side.textFields.matching(NSPredicate(format: "value == %@", target)).firstMatch
        XCTAssertTrue(sideTarget.waitForExistence(timeout: 10), "the link did not open in the side pane")
        XCTAssertTrue(sideBack.waitForExistence(timeout: 5), "the side pane, with a followed link, has no Back")
        assertOver(sideBack, side)
        XCTAssertFalse(mainBack.exists, "the main pane shows Back for the side pane's link")
        attach("side-link")
        sideBack.tap()
        XCTAssertTrue(sidePage.waitForExistence(timeout: 10), "Back in the side pane did not return to \(source)")
        XCTAssertTrue(mainSource.exists, "Back in the side pane moved the main pane")
        chip(main).tap()
        XCTAssertTrue(mainPage.waitForExistence(timeout: 10), "the link did not open in the main pane")
        XCTAssertTrue(sidePage.isHittable, "the link pushed over the side pane")
        attach("pane-link")

        app.typeKey("w", modifierFlags: [.command, .option])
        XCTAssertTrue(side.waitForNonExistence(timeout: 5), "⌘⌥W did not close the split")
        // With no split, ⌘⌥W does nothing: the window stays.
        app.typeKey("w", modifierFlags: [.command, .option])
        XCTAssertTrue(row(source).waitForExistence(timeout: 5), "⌘⌥W with no split closed the window")
        try deleteNotes([source, target])
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

        try deleteNotes([first, second])
    }

    /// #4426: ⌘K opens the palette while the editor has the caret, and Esc
    /// (⌘. on the simulator) closes it.
    func testCommandKOpensThePaletteFromTheEditor() throws {
        try openNotes()
        app.primeCommandKeys()
        let title = "[agent] \(run) editing"
        makeNote(title).typeText("Body")
        app.typeKey("k", modifierFlags: .command)
        let field = app.textFields["search.palette.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "⌘K did not open the palette from the editor")
        app.typeKey(".", modifierFlags: .command)
        XCTAssertTrue(field.waitForNonExistence(timeout: 5), "Esc did not close the palette")
        try deleteNotes([title])
    }

    /// #4347: the inspector's outline scrolls the note to a heading.
    func testAnOutlineEntryScrollsTheNote() throws {
        try openNotes()
        let title = "[agent] \(run) outline"
        let body = makeNote(title)
        body.tap()
        // Keys typed while the body takes the caret, or across the `# `
        // conversion, get dropped: wait out each step.
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), body), "the body has no caret")
        app.typeText("# ")
        XCTAssertTrue(matches(NSPredicate(format: "value == ''"), body), "`# ` did not make a heading")
        app.typeText("\(run) top")
        XCTAssertTrue(matches(NSPredicate(format: "value == %@", "\(run) top"), body), "the top heading lost keys")
        app.typeText("\n")
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

        // A rotation there and back brings the rail back alone: the list
        // stays collapsed beside it.
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        XCUIDevice.shared.orientation = .landscapeLeft
        let rail = app.descendants(matching: .any)["note.inspector"]
        XCTAssertTrue(rail.waitForExistence(timeout: 10), "the rail did not come back")
        Thread.sleep(forTimeInterval: 1)
        XCTAssertFalse(app.buttons["notes.addButton"].firstMatch.isHittable, "the list came back beside the rail")
        attach("inspector-rotated-back")

        hideInspector()
        attach("inspector-closed-landscape")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        XCTAssertFalse(inspectorToggle.exists, "13\" portrait cannot hold the note column and the rail")
        attach("inspector-hidden-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        try deleteNotes([title])
    }

    /// #4832 (#4543 L2): the list the user brings back beside the rail stays
    /// through note picks until they toggle again. A
    /// rail toggle or a rotation gives the columns back to the width.
    func testAListShownBesideTheRailStaysUntilTheUserTogglesAgain() throws {
        try openNotes()
        let first = "[agent] \(run) first"
        let second = "[agent] \(run) second"
        addNote(first)
        addNote(second)
        try showInspector()
        let list = app.buttons["notes.addButton"].firstMatch
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: false, timeout: 5), "opening the rail left the list beside it")
        toggleNotesSidebar()
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: true, timeout: 5), "the split view's button did not bring the list back")
        attach("list-back-beside-rail")

        row(first).tap()
        XCTAssertTrue(page(first).waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1)
        XCTAssertTrue(list.isHittable, "picking a note collapsed the list the user brought back")
        // The open note deleted, then another picked: the note goes from
        // none to one beside the rail.
        swipeToDelete(first)
        row(second).tap()
        XCTAssertTrue(page(second).waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1)
        XCTAssertTrue(list.isHittable, "picking a note after the open one went collapsed the list the user brought back")
        attach("list-kept-beside-rail")

        // Closing and opening the rail is the newer toggle: the note stands
        // alone again.
        hideInspector()
        row(second).tap()
        try showInspector()
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: false, timeout: 5), "reopening the rail left the list beside it")
        toggleNotesSidebar()
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: true, timeout: 5), "the split view's button did not bring the list back")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(page(second).waitForExistence(timeout: 10))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.descendants(matching: .any)["note.inspector"].waitForExistence(timeout: 10), "the rail did not come back")
        Thread.sleep(forTimeInterval: 1)
        XCTAssertFalse(list.isHittable, "a rotation kept the list beside the rail")
        attach("list-collapsed-after-rotation")

        hideInspector()
        try deleteNotes([second])
    }

    /// #5059: the software keyboard is no rotation. A rotation with the
    /// caret in the body brings back the list the user hid, and the keyboard
    /// showing in portrait keeps it hidden.
    func testTheKeyboardIsNoRotation() throws {
        try openNotes()
        let title = "[agent] \(run) keyboard"
        addNote(title)
        let list = app.buttons["notes.addButton"].firstMatch
        firstBlock.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "the body took no keyboard")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        toggleList()
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: false, timeout: 5), "the split view's button did not hide the list")
        attach("list-hidden-portrait-keyboard-up")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(keyboard.exists, "the keyboard went down through the rotation")
        XCTAssertTrue(list.isHittable, "a rotation with the keyboard up kept the list hidden")
        attach("columns-back-after-rotation-keyboard-up")

        // A relaunch lowers the keyboard: hide the list in portrait, then
        // the caret into the body.
        app.terminate()
        try openNotes()
        XCUIDevice.shared.orientation = .portrait
        row(title).tap()
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(keyboard.exists, "the note opened with the keyboard up")
        toggleList()
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: false, timeout: 5), "the split view's button did not hide the list")
        firstBlock.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "the body took no keyboard")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(list.isHittable, "the keyboard showing brought back the list the user hid")
        attach("list-kept-hidden-keyboard-up")

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(list.wait(for: \.isHittable, toEqual: true, timeout: 5), "a rotation did not bring back the list")
        try deleteNotes([title])
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
        try deleteNotes([source, target])
    }

    /// #4347: a property value and a tag typed in the inspector, with no
    /// Return, land when the field is left and when the rail closes.
    func testDraftsTypedInTheInspectorLandWhenItCloses() throws {
        try openNotes()
        let title = "[agent] \(run) drafts"
        makeNote(title)
        try showInspector()

        let addProperty = app.buttons["Add a property"].firstMatch
        XCTAssertTrue(addProperty.waitForExistence(timeout: 10), "the inspector offers no property")
        addProperty.tap()
        let name = app.textFields["Property name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("status")
        app.buttons["Text"].firstMatch.tap()
        let value = app.textFields["status"].firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 10), "the property has no field")
        value.tap()
        value.typeText("drafted")

        // Leaving the value for the tag field is the blur path.
        let addTag = app.buttons["Add a tag"].firstMatch
        XCTAssertTrue(addTag.waitForExistence(timeout: 10))
        addTag.tap()
        let tagField = app.textFields["Add a tag"].firstMatch
        XCTAssertTrue(matches(NSPredicate(format: "hasKeyboardFocus == true"), tagField), "the tag field has no caret")
        tagField.typeText(run)
        attach("inspector-drafts-typed")

        // Closing the rail is the disappear path.
        hideInspector()
        let pageValue = app.textFields["status"].firstMatch
        XCTAssertTrue(matches(NSPredicate(format: "value == 'drafted'"), pageValue), "the typed value was lost")
        XCTAssertTrue(app.staticTexts[run].firstMatch.waitForExistence(timeout: 10), "the typed tag was lost")
        attach("inspector-drafts-landed")

        // Written, not only drawn: the note comes back with both (D6).
        app.terminate()
        try openNotes()
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "value == 'drafted'"), app.textFields["status"].firstMatch))
        XCTAssertTrue(app.staticTexts[run].firstMatch.waitForExistence(timeout: 10))

        try deleteNotes([title])
    }

    /// #4616: Clear, then Return in the field with nothing typed, leaves the
    /// value empty; the row's draft does not write the old value back.
    func testReturnAfterAClearKeepsThePropertyEmpty() throws {
        try openNotes()
        let title = "[agent] \(run) cleared"
        makeNote(title)
        let addProperty = app.buttons["Add a property"].firstMatch
        XCTAssertTrue(addProperty.waitForExistence(timeout: 10))
        addProperty.tap()
        let name = app.textFields["Property name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("status")
        app.buttons["Text"].firstMatch.tap()
        let value = app.textFields["status"].firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 10), "the property has no field")
        value.tap()
        value.typeText("old\n")

        app.buttons["status"].firstMatch.press(forDuration: 1)
        let clear = app.buttons["Clear status"].firstMatch
        XCTAssertTrue(clear.waitForExistence(timeout: 5), "the row has no Clear")
        clear.tap()
        value.tap()
        value.typeText("\n")
        attach("property-cleared")

        app.terminate()
        try openNotes()
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        let empty = NSPredicate(format: "value == '' OR value == 'Empty' OR value == nil")
        XCTAssertTrue(matches(empty, app.textFields["status"].firstMatch), "Return after Clear wrote the old value back")
        try deleteNotes([title])
    }

    /// Return on an emptied field writes the empty value; leaving an emptied
    /// field writes nothing and the value comes back.
    func testReturnEmptiesAPropertyAndLeavingDoesNot() throws {
        try openNotes()
        let title = "[agent] \(run) emptied"
        makeNote(title)
        let addProperty = app.buttons["Add a property"].firstMatch
        XCTAssertTrue(addProperty.waitForExistence(timeout: 10))
        addProperty.tap()
        let name = app.textFields["Property name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("status")
        app.buttons["Text"].firstMatch.tap()
        let value = app.textFields["status"].firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 10), "the property has no field")
        let erase = String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8)

        value.tap()
        value.typeText("kept\n")
        value.tap()
        value.typeText(erase)
        let addTag = app.buttons["Add a tag"].firstMatch
        XCTAssertTrue(addTag.waitForExistence(timeout: 10))
        addTag.tap()
        XCTAssertTrue(matches(NSPredicate(format: "value == 'kept'"), value), "leaving an emptied field lost the value")
        attach("property-emptied-left")

        value.tap()
        value.typeText(erase + "\n")
        attach("property-emptied-returned")

        app.terminate()
        try openNotes()
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        let empty = NSPredicate(format: "value == '' OR value == 'Empty' OR value == nil")
        XCTAssertTrue(matches(empty, app.textFields["status"].firstMatch), "Return on an emptied field wrote nothing")
        try deleteNotes([title])
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
        // Desktop lists `fullWidth` as a property and shows it on toggle.
        XCTAssertTrue(app.staticTexts["fullWidth"].waitForExistence(timeout: 5),
                      "the toggle's property row did not show until the note reopened")

        app.terminate()
        try openNotes()
        row(title).tap()
        XCTAssertTrue(page(title).waitForExistence(timeout: 10))
        XCTAssertTrue(matches(NSPredicate(format: "value CONTAINS %@", body), firstBlock),
                      "the body did not survive the width write")
        XCTAssertTrue(fullWidthIsOn(), "the note's Full width did not survive a relaunch")

        toggleFullWidth()
        XCTAssertFalse(fullWidthIsOn(), "the toggle did not turn Full width off")
        try deleteNotes([title])
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

    /// The tab bar's frame: the buttons on the row of its Tasks tab. `.null`
    /// while the page sidebar shows instead.
    private func tabBar() -> CGRect {
        let tasks = app.buttons["Tasks"].firstMatch
        guard tasks.waitForExistence(timeout: 5), tasks.isHittable else { return .null }
        return app.buttons.allElementsBoundByIndex
            .filter { $0.isHittable && abs($0.frame.midY - tasks.frame.midY) < 2 }
            .reduce(CGRect.null) { $0.union($1.frame) }
    }

    /// The tab bar's own sidebar button, on the row of its tabs.
    private func tabBarSidebarToggle() -> XCUIElement? {
        let tasks = app.buttons["Tasks"].firstMatch
        guard tasks.waitForExistence(timeout: 5), tasks.isHittable else { return nil }
        return app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'sidebar'")).allElementsBoundByIndex
            .first { $0.isHittable && abs($0.frame.midY - tasks.frame.midY) < 2 }
    }

    private func assertClear(_ control: XCUIElement, of tabBar: CGRect, line: UInt = #line) {
        XCTAssertFalse(tabBar.isNull, "no tab bar on screen", line: line)
        XCTAssertFalse(
            tabBar.intersects(control.frame),
            "\(control.label) at \(control.frame) is under the tab bar at \(tabBar)",
            line: line
        )
    }

    /// The app's page sidebar's own button, the leftmost sidebar toggle.
    private func togglePageSidebar() {
        let toggles = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'sidebar'")).allElementsBoundByIndex
        let toggle = toggles.filter(\.isHittable).min { $0.frame.minX < $1.frame.minX }
        XCTAssertNotNil(toggle, "no sidebar button: \(toggles.map(\.label))")
        toggle?.tap()
    }

    /// The split view's own sidebar button: every hittable sidebar button
    /// but the page sidebar's, the leftmost.
    private func toggleNotesSidebar() {
        let toggles = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'sidebar'")).allElementsBoundByIndex
            .filter(\.isHittable).sorted { $0.frame.minX < $1.frame.minX }
        XCTAssertGreaterThan(toggles.count, 1, "no split view sidebar button: \(toggles.map(\.label))")
        toggles.last?.tap()
    }

    /// The split view's sidebar button on the list column's toolbar row, in
    /// either orientation (portrait shows the tab bar's button too).
    private func toggleList() {
        let add = app.buttons["notes.addButton"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        let toggle = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'sidebar'")).allElementsBoundByIndex
            .first { $0.isHittable && abs($0.frame.midY - add.frame.midY) < 2 }
        XCTAssertNotNil(toggle, "no split view sidebar button")
        toggle?.tap()
    }

    private var firstBlock: XCUIElement {
        app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).firstMatch
    }

    private func block(in pane: XCUIElement) -> XCUIElement {
        pane.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'")).firstMatch
    }

    /// A note list row by title, not the open note's backlink to it.
    private func row(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(
            format: "label CONTAINS %@ AND NOT (identifier BEGINSWITH 'note.backlink.')", title
        )).firstMatch
    }

    /// The detail column showing `title`.
    private func page(_ title: String) -> XCUIElement {
        app.textFields.matching(NSPredicate(format: "value == %@", title)).firstMatch
    }

    private func sidebarRow(_ title: String) -> XCUIElement {
        app.collectionViews.containing(.any, identifier: "magnifyingglass").firstMatch
            .cells.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    /// `control` lies inside `pane`'s frame (#4699).
    private func assertOver(_ control: XCUIElement, _ pane: XCUIElement, line: UInt = #line) {
        XCTAssertTrue(
            pane.frame.contains(control.frame),
            "\(control.identifier) at \(control.frame) is not over \(pane.identifier) at \(pane.frame)",
            line: line
        )
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

    /// A new note titled `title`, with no claim about where the caret lands.
    private func addNote(_ title: String) {
        let add = app.buttons["notes.addButton"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        let field = app.textFields["Title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        if !matches(NSPredicate(format: "hasKeyboardFocus == true"), field) { field.tap() }
        field.typeText("\(title)\n")
        XCTAssertTrue(row(title).waitForExistence(timeout: 10), "the new note has no row in the list")
    }

    /// Deletes from a fresh launch, so no block holds the caret and the
    /// swipe's touch brings no on-screen keyboard up over the question.
    private func deleteNotes(_ titles: [String]) throws {
        app.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        try openNotes()
        titles.forEach(swipeToDelete)
    }

    /// Deletes by the row's swipe. The row's context menu cost two of
    /// XCTest's 60 s idle waits per note, and at times took no tap on
    /// Delete note: on the iPadOS 26 simulator an open context menu never
    /// reports its animations done, Photos' own included.
    private func swipeToDelete(_ title: String) {
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
        // A failed run may have left the page sidebar hidden, which the
        // launch restores: the tab bar's button brings it back.
        let pageSidebar = app.buttons["ToggleSideBar"].firstMatch
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !notes.exists {
            if signIn.exists { throw XCTSkip("Signed out: open a vault on this simulator first.") }
            if app.buttons["Menu"].exists { throw XCTSkip("Compact width: run on a full-screen iPad simulator.") }
            if vault.exists { vault.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            if app.buttons["Tasks"].firstMatch.isHittable, pageSidebar.isHittable { pageSidebar.tap() }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertTrue(notes.waitForExistence(timeout: 5), "the sidebar did not show")
        notes.tap()
        // An earlier run may have left a split, which the launch restores.
        let side = app.otherElements["notes.pane.side"]
        if side.waitForExistence(timeout: 3) {
            app.primeCommandKeys()
            app.typeKey("w", modifierFlags: [.command, .option])
            XCTAssertTrue(side.waitForNonExistence(timeout: 5), "a restored split did not close")
        }
        // An earlier run may have left the inspector open, which hides the list.
        hideInspector()
        XCTAssertTrue(app.buttons["notes.addButton"].waitForExistence(timeout: 10))
    }
}
