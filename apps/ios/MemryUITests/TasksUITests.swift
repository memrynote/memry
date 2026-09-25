import XCTest

// Spec 004 TP081, moved onto the spec 005 redesign (RD92): the Tasks tab end
// to end on a real vault. Capture is the "+" composer, views and scope are in
// the title menu, List / Board / Select in the "…" menu, saved views are
// named in the title.
//
// **Precondition:** the simulator is signed in to the staging test account
// with the MemryNote vault available (tasks.md §0.4). There is no sign-in in
// here: it needs an emailed code. A test that lands on the sign-in screen
// fails with that instruction instead of skipping, so a green UI plan always
// means the flows ran.
//
// Every task a test writes is named `[agent] ui-<run>…` and filed under the
// `Agent Test Redesign` project (made on first use); spec 005 RD93 deletes them with it. Each test narrows
// the list with the filter search so it only ever sees its own rows.
@MainActor
final class TasksUITests: XCTestCase {
    let app = XCUIApplication()
    /// Unique per test, so reruns and parallel leftovers never collide.
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "ui-\(UUID().uuidString.prefix(6).lowercased())"
    }

    // MARK: Flows

    func testQuickAddReadsDateTimePriorityAndTag() throws {
        try openTasks()
        quickAdd("[agent] \(run) meeting @may 17 3pm !high #test +Agent-Test-Redesign")
        search(run)
        let row = row(containing: "\(run) meeting")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.label.contains("Priority: High"), row.label)
        XCTAssertTrue(row.label.contains("May 17"), row.label)
        XCTAssertTrue(row.label.contains("15:00"), row.label)
        XCTAssertTrue(row.label.contains("Tags: test"), row.label)
        XCTAssertTrue(row.label.contains("Agent Test Redesign"), row.label)
    }

    func testCompletingADailyRepeatingTaskCreatesTheNextOccurrence() throws {
        try openTasks()
        quickAdd("[agent] \(run) daily every day @today +Agent-Test-Redesign")
        search(run)
        let row = row(containing: "\(run) daily")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.label.contains("Due Today"), row.label)
        row.buttons["tasks.row.status"].tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Next occurrence'"))
                .firstMatch.waitForExistence(timeout: 10)
        )
        let next = app.buttons.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS 'Due Tomorrow' AND label CONTAINS 'Repeats'",
            "\(run) daily"
        )).firstMatch
        XCTAssertTrue(next.waitForExistence(timeout: 10))
    }

    func testBulkCompletingThreeTasksIsOneUndo() throws {
        try openTasks()
        for index in 1 ... 3 {
            quickAdd("[agent] \(run) bulk \(index) @today +Agent-Test-Redesign")
        }
        search(run)
        XCTAssertTrue(row(containing: "\(run) bulk 3").waitForExistence(timeout: 10))
        moreMenu("tasks.more.select")
        for index in 1 ... 3 {
            row(containing: "\(run) bulk \(index)").tap()
        }
        XCTAssertTrue(anything(labelled: "3 selected").waitForExistence(timeout: 5), "the title did not count 3")
        app.buttons["tasks.bulk.complete"].tap()
        let undo = app.buttons["tasks.toast.undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5))
        undo.tap()
        XCTAssertTrue(
            app.staticTexts["tasks.toast.message"].waitForExistence(timeout: 5)
        )
        for index in 1 ... 3 {
            let reopened = row(containing: "\(run) bulk \(index)")
            XCTAssertTrue(reopened.waitForExistence(timeout: 5))
            XCTAssertFalse(reopened.label.contains("completed"), reopened.label)
        }
        app.buttons["tasks.editButton"].firstMatch.tap()
    }

    func testCompletingEverySubtaskAsksAboutTheParent() throws {
        try openTasks()
        quickAdd("[agent] \(run) parent +Agent-Test-Redesign")
        search(run)
        let parent = row(containing: "\(run) parent")
        XCTAssertTrue(parent.waitForExistence(timeout: 10))
        parent.tap()
        let add = app.buttons["tasks.subtasks.add"]
        scroll(to: add)
        add.tap()
        let field = app.textFields["tasks.subtasks.addField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("[agent] \(run) child one\n")
        field.typeText("[agent] \(run) child two\n\n")
        let toggles = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.subtask.toggle.'"))
        XCTAssertTrue(toggles.element(boundBy: 1).waitForExistence(timeout: 5))
        toggles.element(boundBy: 0).tap()
        toggles.element(boundBy: 1).tap()
        let keepOpen = app.buttons["Keep task open"].firstMatch
        XCTAssertTrue(keepOpen.waitForExistence(timeout: 5), "the all-subtasks-done prompt did not appear")
        keepOpen.tap()
    }

    func testAFilterCanBeSavedClearedAndReapplied() throws {
        try openTasks()
        let name = "Agent Test \(run)"
        app.buttons["tasks.filterButton"].firstMatch.tap()
        app.buttons["tasks.filter.preset.repeating"].tap()
        let save = app.buttons["tasks.filter.save"]
        scroll(to: save)
        save.tap()
        let nameField = app.textFields.firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 5))
        nameField.typeText(name)
        app.buttons["tasks.filter.saveConfirm"].firstMatch.tap()
        // The saved view is the applied one: the sheet's Saved views page
        // marks it, and the title names it.
        let savedViews = app.buttons["tasks.filter.savedViews"]
        scroll(to: savedViews)
        savedViews.tap()
        let saved = app.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
        // Earlier runs leave saved filters behind; the new one may be below
        // the fold, where a lazy list has not built its row yet.
        for _ in 0 ..< 6 where !saved.waitForExistence(timeout: 1) {
            app.swipeUp()
        }
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        XCTAssertTrue(saved.isSelected, "a just-saved filter is the applied one")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        let clear = app.buttons["tasks.filter.clearAll"]
        scroll(to: clear)
        clear.tap()
        savedViews.tap()
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        XCTAssertTrue(waitUntil { !saved.isSelected }, "clearing left the saved filter applied")
        saved.tap()
        XCTAssertTrue(waitUntil { saved.isSelected }, "tapping the saved filter did not reapply it")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["tasks.filter.done"].tap()
        XCTAssertTrue(waitUntil { title.label.contains(name) }, title.label)
    }

    func testDraggingAKanbanCardToAnotherColumnChangesItsStatus() throws {
        try openTasks()
        quickAdd("[agent] \(run) kanban +Agent-Test-Redesign")
        search(run)
        XCTAssertTrue(row(containing: "\(run) kanban").waitForExistence(timeout: 10))
        moreMenu("tasks.more.board")
        let card = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.kanban.card.' AND label CONTAINS %@", run))
            .firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        // The next column peeks in at the trailing edge; the card is dropped
        // on that visible part.
        let inProgress = app.descendants(matching: .any)["tasks.kanban.column.in_progress"]
        XCTAssertTrue(inProgress.waitForExistence(timeout: 5))
        let peek = inProgress.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.1))
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 1.0, thenDragTo: peek, withVelocity: .slow, thenHoldForDuration: 0.5)
        XCTAssertTrue(waitUntil { inProgress.label.hasPrefix("In Progress column, 1 task") }, inProgress.label)
        moreMenu("tasks.more.list")
    }

    // MARK: Steps

    /// Launches onto the Tasks tab with no filter, the All tab and list mode,
    /// scoped to every project.
    private func openTasks() throws {
        app.launch()
        // The staging vault's name is whatever a desktop peer last set it to;
        // `TEST_RUNNER_MEMRY_UI_VAULT` overrides the usual one.
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name]
        let tasksTab = app.buttons["Tasks"].firstMatch
        let signIn = app.staticTexts["Sign in to Memry"]
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, !tasksTab.exists {
            if signIn.exists {
                XCTFail("Signed out: sign in to the staging test account first (tasks.md §0.4).")
                throw XCTSkip("signed out")
            }
            if vault.exists, vault.isHittable { vault.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(tasksTab.waitForExistence(timeout: 5), "the vault did not open")
        tasksTab.tap()
        XCTAssertTrue(app.buttons["tasks.filterButton"].firstMatch.waitForExistence(timeout: 20))
        if app.descendants(matching: .any)["tasks.kanban.board"].exists { moreMenu("tasks.more.list") }
        ensureTestProject()
        resetPage()
    }

    /// The `Agent Test Redesign` project every `+Agent-Test-Redesign` token
    /// files into. RD93 deletes it after the last run, so the next run makes
    /// it again from Title menu > Projects > New.
    private func ensureTestProject() {
        title.tap()
        let projects = app.buttons["tasks.projectsLink"].firstMatch
        XCTAssertTrue(projects.waitForExistence(timeout: 5))
        projects.tap()
        let newProject = app.buttons["tasks.projects.new"].firstMatch
        XCTAssertTrue(newProject.waitForExistence(timeout: 10))
        let existing = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'tasks.projects.row.' AND label BEGINSWITH %@", Self.project
        )).firstMatch
        if !existing.waitForExistence(timeout: 3) {
            newProject.tap()
            let name = app.textFields["tasks.projectEditor.name"].firstMatch
            XCTAssertTrue(name.waitForExistence(timeout: 5))
            name.tap()
            name.typeText(Self.project)
            app.buttons["tasks.projectEditor.save"].firstMatch.tap()
            XCTAssertTrue(existing.waitForExistence(timeout: 10), "the test project was not created")
        }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["tasks.filterButton"].firstMatch.waitForExistence(timeout: 10))
    }

    private static let project = "Agent Test Redesign"

    /// The large title (a menu of views and scope) at the top of the list.
    private var title: XCUIElement { app.buttons["tasks.titleMenu"].firstMatch }

    /// No filter, All view, all projects: whatever an earlier run left behind.
    private func resetPage() {
        app.buttons["tasks.filterButton"].firstMatch.tap()
        let clear = app.buttons["tasks.filter.clearAll"]
        scroll(to: clear)
        if clear.exists, clear.isEnabled { clear.tap() }
        app.buttons["tasks.filter.done"].tap()
        title.tap()
        let all = app.descendants(matching: .any)["tasks.tab.all"]
        XCTAssertTrue(all.waitForExistence(timeout: 5))
        all.tap()
        title.tap()
        app.buttons["tasks.titleMenu.project"].firstMatch.tap()
        let everything = app.buttons["All projects"].firstMatch
        XCTAssertTrue(everything.waitForExistence(timeout: 5))
        everything.tap()
        XCTAssertTrue(waitUntil { title.label.hasPrefix("All") }, title.label)
    }

    /// Adds a task through the "+" composer and closes it again.
    private func quickAdd(_ text: String) {
        app.buttons["tasks.addButton"].firstMatch.tap()
        let field = app.textViews["tasks.composer.title"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText(text + "\n")
        XCTAssertTrue(waitUntil { (field.value as? String ?? "").isEmpty }, "the composer did not submit")
        // A tap outside the composer closes it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(waitUntil { !field.exists }, "the composer did not close")
    }

    /// Narrows the page to rows whose title contains `text`.
    private func search(_ text: String) {
        app.buttons["tasks.filterButton"].firstMatch.tap()
        let field = app.textFields["tasks.filter.search"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(text)
        Thread.sleep(forTimeInterval: 0.6)
        app.buttons["tasks.filter.done"].tap()
        // Folded groups stay folded between runs; open them so rows exist.
        let folded = app.buttons.matching(NSPredicate(format: "label ENDSWITH ', collapsed'"))
        for _ in 0 ..< 6 where folded.firstMatch.exists {
            folded.firstMatch.tap()
        }
    }

    /// Picks an item (List, Board, Select) from the "…" menu.
    private func moreMenu(_ identifier: String) {
        app.buttons["tasks.moreMenu"].firstMatch.tap()
        let item = app.buttons[identifier].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.tap()
    }

    private func anything(labelled label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func row(containing text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'tasks.row.' AND label CONTAINS %@", text
        )).firstMatch
    }

    private func scroll(to element: XCUIElement) {
        for _ in 0 ..< 6 where !(element.exists && element.isHittable) {
            app.swipeUp()
        }
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
