import XCTest

// #4350: at regular width Tasks is a split view. A task opened from the list
// or from search fills the detail column, the list stays beside it, and text
// typed into one task's detail survives picking another task.
//
// **Precondition:** a full-screen iPad simulator with a vault open (the
// staging test account, or a free vault on this device). A run that lands on
// sign-in, or on a compact window, skips; a skip is not a pass. Every task a
// test writes is titled `[agent] <run>…` and deleted by the test. After a
// failure, tearDown relaunches and deletes what is left of that run's tasks,
// so a red run leaves nothing in the vault.
@MainActor
final class TasksSplitUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""
    /// tearDown's steps only wait: a failed check there would stop it before
    /// it resets the filter and the orientation.
    private var tearingDown = false

    override func setUp() async throws {
        continueAfterFailure = false
        run = "tsplit-\(UUID().uuidString.prefix(6).lowercased())"
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDown() async throws {
        tearingDown = true
        if let result = testRun, result.failureCount + result.unexpectedExceptionCount > 0 { sweep() }
        narrow("")
        XCUIDevice.shared.orientation = .portrait
    }

    func testASearchHitOpensTheTaskInTheDetailColumn() throws {
        try openTasks()
        let title = "[agent] \(run) found"
        quickAdd(title)
        XCTAssertNotEqual(detailTitle, title, "the new task opened on its own")
        // A free vault indexes a local write only at the next launch (#4537).
        app.terminate()
        try openTasks()

        // From another page: the hit selects Tasks and fills its detail column.
        sidebarRow("Notes").tap()
        sidebarRow("Search").tap()
        let field = app.textFields["search.palette.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "the Search row did not open the palette")
        field.typeText("\(run) found")
        let hit = app.buttons.matching(identifier: "search.result.task")
            .matching(NSPredicate(format: "label CONTAINS %@", "\(run) found")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 15), "search did not find the task")
        hit.tap()
        XCTAssertTrue(waitUntil { self.detailTitle == title }, "the hit did not open in the detail column: \(detailTitle ?? "none")")
        XCTAssertTrue(app.buttons["tasks.filterButton"].firstMatch.isHittable, "the list left the screen")
        XCTAssertTrue(row(title).wait(for: \.isSelected, toEqual: true, timeout: 5), "the hit's row is not selected")
        attach("search-hit")
        deleteOpenTask()
    }

    /// Text typed into a task's title or notes, left by picking another task
    /// with no Return and no Done, is kept.
    func testTextTypedInADetailSurvivesPickingAnotherTask() throws {
        try openTasks()
        let first = "[agent] \(run) first"
        let second = "[agent] \(run) second"
        quickAdd(first)
        quickAdd(second)
        let firstRow = rowId(first)
        let secondRow = rowId(second)

        open(firstRow, showing: first)
        let title = app.descendants(matching: .any)["tasks.detail.title"].firstMatch
        title.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
        title.typeText(" renamed")
        open(secondRow, showing: second)
        XCTAssertTrue(
            waitUntil { self.app.buttons[firstRow].label.contains("renamed") },
            "the typed title did not reach the list: \(app.buttons[firstRow].label)"
        )
        open(firstRow, showing: "\(first) renamed")

        app.buttons["tasks.detail.description"].firstMatch.tap()
        let notes = app.textViews["tasks.detail.descriptionEditor"].firstMatch
        XCTAssertTrue(notes.waitForExistence(timeout: 5))
        notes.typeText("typed notes \(run)")
        open(secondRow, showing: second)
        open(firstRow, showing: "\(first) renamed")
        let description = app.buttons["tasks.detail.description"].firstMatch
        XCTAssertTrue(
            waitUntil { (description.value as? String ?? "").contains("typed notes \(run)") },
            "the typed notes were lost: \(description.value as? String ?? "")"
        )

        deleteOpenTask()
        open(secondRow, showing: second)
        deleteOpenTask()
    }

    /// Select mode works beside an open task: rows select instead of opening,
    /// and the detail column keeps its task. Deleting the selection with the
    /// open task in it empties the detail column.
    func testSelectModeKeepsTheDetailColumn() throws {
        try openTasks()
        let first = "[agent] \(run) one"
        let second = "[agent] \(run) two"
        quickAdd(first)
        quickAdd(second)
        let firstRow = rowId(first)
        let secondRow = rowId(second)
        open(firstRow, showing: first)

        app.buttons["tasks.moreMenu"].firstMatch.tap()
        app.buttons["tasks.more.select"].firstMatch.tap()
        app.buttons[firstRow].tap()
        app.buttons[secondRow].tap()
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "label == '2 selected'")).firstMatch
                .waitForExistence(timeout: 5),
            "the title did not count 2"
        )
        XCTAssertEqual(detailTitle, first, "a tap in select mode opened a task")
        attach("select-mode")

        app.buttons["tasks.bulk.more"].firstMatch.tap()
        app.buttons["tasks.bulk.delete"].firstMatch.tap()
        let confirm = app.buttons["tasks.bulk.delete.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["tasks.detail.empty"].waitForExistence(timeout: 10),
            "the deleted open task did not leave the detail column empty"
        )
        XCTAssertFalse(app.descendants(matching: .any)["tasks.detail.missing"].exists)
        app.buttons["tasks.editButton"].firstMatch.tap()
    }

    /// D4: at regular width the "+" is the list column's toolbar button, not
    /// a floating disc over the list.
    func testTheAddButtonIsInTheListColumnToolbar() throws {
        try openTasks()
        let add = app.buttons["tasks.addButton"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        let bar = app.navigationBars.containing(.button, identifier: "tasks.filterButton").firstMatch
        XCTAssertTrue(bar.buttons["tasks.addButton"].exists, "the + is not in the list column's toolbar")
        attach("add-in-toolbar")
    }

    /// The scopes sidebar picks the list's view, as the title menu does.
    /// Read-only: it changes the saved view and puts All back.
    func testTheScopeSidebarPicksTheView() throws {
        try openTasks()
        narrow("")
        app.buttons["Show Sidebar"].firstMatch.tap()
        let today = app.buttons["tasks.sidebar.tab.today"].firstMatch
        XCTAssertTrue(today.waitForExistence(timeout: 5), "the scopes sidebar did not show")
        attach("scope-sidebar")
        today.tap()
        let title = app.buttons["tasks.titleMenu"].firstMatch
        XCTAssertTrue(waitUntil { title.label.hasPrefix("Today") }, title.label)
        let all = app.buttons["tasks.sidebar.tab.all"].firstMatch
        if !all.isHittable { app.buttons["Show Sidebar"].firstMatch.tap() }
        XCTAssertTrue(waitUntil { today.isSelected }, "the sidebar did not mark Today")
        all.tap()
        XCTAssertTrue(waitUntil { title.label.hasPrefix("All") }, title.label)
    }

    /// The board takes the full pane: three or more whole columns in 13"
    /// landscape. A card's task pushes over the board, and Back returns to it.
    func testTheBoardShowsThreeColumnsAndACardOpensOverIt() throws {
        try openTasks()
        let title = "[agent] \(run) card"
        quickAdd(title)
        app.buttons["tasks.moreMenu"].firstMatch.tap()
        app.buttons["tasks.more.board"].firstMatch.tap()
        let board = app.descendants(matching: .any)["tasks.kanban.board"]
        XCTAssertTrue(board.waitForExistence(timeout: 10))
        let window = app.windows.firstMatch.frame
        let columns = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.kanban.column.'"))
        let whole = { columns.allElementsBoundByIndex.filter { window.contains($0.frame) }.count }
        XCTAssertTrue(waitUntil { whole() >= 3 }, "\(whole()) whole columns on the board")
        attach("board")

        let card = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.kanban.card.' AND label CONTAINS %@", run))
            .firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        card.tap()
        XCTAssertTrue(waitUntil { self.detailTitle == title }, "the task shows \(detailTitle ?? "none")")
        attach("board-task")
        // A title typed and left by Back, with no Return, is kept.
        let field = app.descendants(matching: .any)["tasks.detail.title"].firstMatch
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
        field.typeText(" renamed")
        app.navigationBars.buttons["BackButton"].firstMatch.tap()
        XCTAssertTrue(waitUntil { self.detailTitle == nil && board.exists }, "Back did not return to the board")
        XCTAssertTrue(waitUntil { card.label.contains("renamed") }, "Back dropped the typed title: \(card.label)")

        card.tap()
        XCTAssertTrue(waitUntil { self.detailTitle == "\(title) renamed" }, "the card did not reopen its task")
        app.buttons["tasks.detail.more"].firstMatch.tap()
        app.buttons["tasks.detail.delete"].firstMatch.tap()
        let confirm = app.buttons["tasks.detail.deleteConfirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(waitUntil { !card.exists && board.exists }, "the delete did not return to the board")
        app.buttons["tasks.moreMenu"].firstMatch.tap()
        app.buttons["tasks.more.list"].firstMatch.tap()
    }

    // MARK: Helpers

    /// The detail column's title, or `nil` when no task is open.
    private var detailTitle: String? {
        let field = app.descendants(matching: .any)["tasks.detail.title"].firstMatch
        return field.exists ? field.value as? String : nil
    }

    private func row(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.row.' AND label CONTAINS %@", title)).firstMatch
    }

    /// A row's identifier, which survives a rename.
    private func rowId(_ title: String) -> String {
        let row = row(title)
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for \(title)")
        return row.identifier
    }

    private func open(_ rowId: String, showing title: String) {
        let row = app.buttons[rowId]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no row \(rowId)")
        row.tap()
        XCTAssertTrue(waitUntil { self.detailTitle == title }, "the detail shows \(detailTitle ?? "none"), not \(title)")
        XCTAssertTrue(app.buttons["tasks.filterButton"].firstMatch.isHittable, "the list left the screen")
    }

    private func deleteOpenTask() {
        let more = app.buttons["tasks.detail.more"].firstMatch
        guard check(more.waitForExistence(timeout: 5), "no detail menu") else { return }
        more.tap()
        let delete = app.buttons["tasks.detail.delete"].firstMatch
        guard check(delete.waitForExistence(timeout: 5), "no Delete in the detail menu") else { return }
        delete.tap()
        let confirm = app.buttons["tasks.detail.deleteConfirm"].firstMatch
        guard check(confirm.waitForExistence(timeout: 5), "no delete confirmation") else { return }
        confirm.tap()
        _ = check(
            app.descendants(matching: .any)["tasks.detail.empty"].waitForExistence(timeout: 10),
            "the detail column did not empty after the delete"
        )
    }

    /// Fails the test on `false`, except in tearDown, which only waits.
    private func check(_ ok: Bool, _ message: @autoclosure () -> String) -> Bool {
        if !ok, !tearingDown { XCTFail(message()) }
        return ok
    }

    /// Adds a task through the "+" composer and closes it again.
    private func quickAdd(_ title: String) {
        app.buttons["tasks.addButton"].firstMatch.tap()
        let field = app.textViews["tasks.composer.title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText(title + "\n")
        XCTAssertTrue(waitUntil { (field.value as? String ?? "").isEmpty }, "the composer did not submit")
        // A tap outside the composer, in the list column, closes it.
        app.buttons["tasks.titleMenu"].firstMatch.tap()
        XCTAssertTrue(waitUntil { !field.exists }, "the composer did not close")
        XCTAssertTrue(row(title).waitForExistence(timeout: 10), "the new task has no row")
    }

    /// The app's page sidebar row.
    private func sidebarRow(_ title: String) -> XCUIElement {
        app.collectionViews.containing(.any, identifier: "magnifyingglass").firstMatch
            .cells.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func waitUntil(_ seconds: TimeInterval = 10, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }

    private func attach(_ name: String) {
        Thread.sleep(forTimeInterval: 1)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// After a failure: relaunches onto this run's rows and deletes each.
    private func sweep() {
        app.terminate()
        guard (try? openTasks()) != nil else { return }
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.row.' AND label CONTAINS %@", run))
        var left = 10
        while left > 0, rows.firstMatch.waitForExistence(timeout: 3) {
            rows.firstMatch.tap()
            deleteOpenTask()
            left -= 1
        }
    }

    /// Launches onto Tasks with the All view and every project.
    private func openTasks() throws {
        app.launchArguments = ["-MEMRY_HIDE_TIPS", "YES"]
        app.launch()
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name].firstMatch
        let signIn = app.descendants(matching: .any).matching(NSPredicate(
            format: "label IN {'Sign in to Memry', 'Already have an account? Sign in'}"
        )).firstMatch
        let tasks = sidebarRow("Tasks")
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !tasks.exists {
            if signIn.exists { throw XCTSkip("Signed out: open a vault on this simulator first.") }
            if app.buttons["Menu"].exists { throw XCTSkip("Compact width: run on a full-screen iPad simulator.") }
            if vault.exists { vault.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            Thread.sleep(forTimeInterval: 1)
        }
        guard check(tasks.waitForExistence(timeout: 5), "the sidebar did not show") else { return }
        tasks.tap()
        guard check(app.buttons["tasks.filterButton"].firstMatch.waitForExistence(timeout: 20), "Tasks did not open") else {
            return
        }
        if app.descendants(matching: .any)["tasks.kanban.board"].exists {
            app.buttons["tasks.moreMenu"].firstMatch.tap()
            app.buttons["tasks.more.list"].firstMatch.tap()
        }
        let all = app.buttons["tasks.sidebar.tab.all"].firstMatch
        if all.waitForExistence(timeout: 5) { all.tap() }
        let everything = app.buttons["tasks.sidebar.project.all"].firstMatch
        if everything.exists { everything.tap() }
        narrow(run)
    }

    /// Narrows the list to this run's rows with the filter search (an
    /// empty string clears it), so a long list never hides them.
    private func narrow(_ text: String) {
        let button = app.buttons["tasks.filterButton"].firstMatch
        guard button.exists else { return }
        button.tap()
        let field = app.textFields["tasks.filter.search"]
        guard check(field.waitForExistence(timeout: 5), "the filter did not open") else { return }
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        field.typeText(text)
        Thread.sleep(forTimeInterval: 0.6)
        app.buttons["tasks.filter.done"].tap()
    }
}
