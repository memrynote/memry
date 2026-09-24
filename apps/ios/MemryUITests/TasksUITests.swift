import XCTest

// Spec 004 TP081: the Tasks tab end to end on a real vault.
//
// **Precondition:** the simulator is signed in to the staging test account
// with the MemryNote vault available (tasks.md §0.4). There is no sign-in in
// here: it needs an emailed code. A test that lands on the sign-in screen
// fails with that instruction instead of skipping, so a green UI plan always
// means the flows ran.
//
// Every task a test writes is named `[agent] ui-<run>…` and filed under the
// `Agent Test Parity` project; tasks.md TP094 deletes them. Each test narrows
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
        quickAdd("[agent] \(run) meeting @may 17 3pm !high #test +Agent-Test-Parity")
        search(run)
        let row = row(containing: "\(run) meeting")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.label.contains("Priority: High"), row.label)
        XCTAssertTrue(row.label.contains("May 17"), row.label)
        XCTAssertTrue(row.label.contains("15:00"), row.label)
        XCTAssertTrue(row.label.contains("Tags: test"), row.label)
        XCTAssertTrue(row.label.contains("Agent Test Parity"), row.label)
    }

    func testCompletingADailyRepeatingTaskCreatesTheNextOccurrence() throws {
        try openTasks()
        quickAdd("[agent] \(run) daily every day @today +Agent-Test-Parity")
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
            quickAdd("[agent] \(run) bulk \(index) @today +Agent-Test-Parity")
        }
        search(run)
        XCTAssertTrue(row(containing: "\(run) bulk 3").waitForExistence(timeout: 10))
        app.buttons["tasks.editButton"].firstMatch.tap()
        for index in 1 ... 3 {
            row(containing: "\(run) bulk \(index)").tap()
        }
        XCTAssertEqual(app.buttons["tasks.selection.count"].label, "3 selected")
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
    }

    func testCompletingEverySubtaskAsksAboutTheParent() throws {
        try openTasks()
        quickAdd("[agent] \(run) parent +Agent-Test-Parity")
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
        let saved = app.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        XCTAssertTrue(saved.isSelected, "a just-saved filter is the applied one")

        app.buttons["tasks.filter.clearAll"].tap()
        XCTAssertTrue(waitUntil { !saved.isSelected }, "clearing left the saved filter applied")
        saved.tap()
        XCTAssertTrue(waitUntil { saved.isSelected }, "tapping the saved filter did not reapply it")
        app.buttons["tasks.filter.done"].tap()
        XCTAssertTrue(app.buttons["tasks.scopePicker"].label.contains(name))
    }

    func testDraggingAKanbanCardToAnotherColumnChangesItsStatus() throws {
        try openTasks()
        quickAdd("[agent] \(run) kanban +Agent-Test-Parity")
        search(run)
        XCTAssertTrue(row(containing: "\(run) kanban").waitForExistence(timeout: 10))
        app.buttons["Kanban view"].tap()
        let card = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.kanban.card.' AND label CONTAINS %@", run))
            .firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        let inProgress = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'In Progress column'")).firstMatch
        XCTAssertTrue(inProgress.waitForExistence(timeout: 5))
        card.press(forDuration: 1.0, thenDragTo: inProgress, withVelocity: .slow, thenHoldForDuration: 0.5)
        XCTAssertTrue(waitUntil { inProgress.label.hasPrefix("In Progress column, 1 task") }, inProgress.label)
        app.buttons["List view"].tap()
    }

    // MARK: Steps

    /// Launches onto the Tasks tab with no filter, the All tab and list mode,
    /// scoped to every project.
    private func openTasks() throws {
        app.launch()
        let vault = app.staticTexts["MemryNote"]
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
        if app.buttons["List view"].exists { app.buttons["List view"].tap() }
        resetPage()
    }

    /// No filter, All tab, all projects: whatever an earlier run left behind.
    private func resetPage() {
        app.buttons["tasks.filterButton"].firstMatch.tap()
        let clear = app.buttons["tasks.filter.clearAll"]
        XCTAssertTrue(clear.waitForExistence(timeout: 5))
        if clear.isEnabled { clear.tap() }
        app.buttons["tasks.filter.done"].tap()
        let all = app.buttons["tasks.tab.all"]
        if all.waitForExistence(timeout: 5), all.isHittable { all.tap() }
        app.buttons["tasks.scopePicker"].tap()
        let everything = app.buttons["tasks.scope.all"]
        XCTAssertTrue(everything.waitForExistence(timeout: 5))
        everything.tap()
        let done = app.buttons["tasks.scope.done"]
        if done.exists { done.tap() }
    }

    private func quickAdd(_ text: String) {
        let field = app.textViews["tasks.quickAdd.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(text + "\n")
        XCTAssertTrue(waitUntil { (field.value as? String ?? "").isEmpty }, "quick add did not submit")
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
