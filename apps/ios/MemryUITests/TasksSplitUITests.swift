import XCTest

// #4350: at regular width Tasks is a split view. A task opened from the list
// or from search fills the detail column, the list stays beside it, and text
// typed into one task's detail survives picking another task.
//
// **Precondition:** a full-screen iPad simulator with a vault open (the
// staging test account, or a free vault on this device). A run that lands on
// sign-in, or on a compact window, skips; a skip is not a pass. Every task a
// test writes is titled `[agent] <run>…` and deleted by the test.
@MainActor
final class TasksSplitUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "tsplit-\(UUID().uuidString.prefix(6).lowercased())"
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDown() async throws {
        narrow("")
        XCUIDevice.shared.orientation = .portrait
    }

    func testASearchHitOpensTheTaskInTheDetailColumn() throws {
        try openTasks()
        let title = "[agent] \(run) found"
        quickAdd(title)
        XCTAssertNotEqual(detailTitle, title, "the new task opened on its own")

        // From another page: the hit selects Tasks and fills its detail column.
        sidebarRow("Notes").tap()
        sidebarRow("Search").tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
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
    /// and the detail column keeps its task.
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
        app.buttons["tasks.editButton"].firstMatch.tap()

        deleteOpenTask()
        open(secondRow, showing: second)
        deleteOpenTask()
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
        app.buttons["tasks.detail.more"].firstMatch.tap()
        app.buttons["tasks.detail.delete"].firstMatch.tap()
        let confirm = app.buttons["tasks.detail.deleteConfirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["tasks.detail.empty"].waitForExistence(timeout: 10),
            "the detail column did not empty after the delete"
        )
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
        XCTAssertTrue(tasks.waitForExistence(timeout: 5), "the sidebar did not show")
        tasks.tap()
        XCTAssertTrue(app.buttons["tasks.filterButton"].firstMatch.waitForExistence(timeout: 20))
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
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        field.typeText(text)
        Thread.sleep(forTimeInterval: 0.6)
        app.buttons["tasks.filter.done"].tap()
    }
}
