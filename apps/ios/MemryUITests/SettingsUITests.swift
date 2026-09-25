import XCTest

// Spec 006 ST93: More › Settings end to end on the staging vault.
//
// **Precondition:** signed in to the staging test account with the MemryNote
// vault available (spec 006 goal "Simulator and sign-in"). A test that lands on
// sign-in fails with that instruction instead of skipping.
//
// Every value a test changes is put back before it ends: the device name, the
// colour mode, and the `agentui…` test tag (deleted with its `[agent]` task's
// tag removed).
@MainActor
final class SettingsUITests: XCTestCase {
    let app = XCUIApplication()
    private var run = ""

    override func setUp() async throws {
        continueAfterFailure = false
        run = "agentui\(UUID().uuidString.prefix(5).lowercased())"
    }

    func testRootNavigatesToEverySectionAndBack() throws {
        try openSettings()
        for row in ["account", "general", "appearance", "features"] {
            let link = app.buttons["settings.row.\(row)"].firstMatch
            XCTAssertTrue(link.waitForExistence(timeout: 10), row)
            link.tap()
            XCTAssertTrue(app.buttons["BackButton"].waitForExistence(timeout: 5), row)
            app.buttons["BackButton"].tap()
        }
        XCTAssertTrue(app.buttons["settings.row.account"].waitForExistence(timeout: 5))
    }

    func testAColourModeChoiceIsAppliedAndPutBack() throws {
        try openSettings()
        app.buttons["settings.row.appearance"].firstMatch.tap()
        let dark = app.buttons["settings.theme.dark"].firstMatch
        XCTAssertTrue(dark.waitForExistence(timeout: 5))
        let original = ["system", "light", "white", "dark"].first {
            app.buttons["settings.theme.\($0)"].firstMatch.isSelected
        } ?? "system"
        let target = original == "dark" ? app.buttons["settings.theme.white"].firstMatch : dark
        target.tap()
        XCTAssertTrue(target.wait(for: \.isSelected, toEqual: true, timeout: 5))
        app.buttons["BackButton"].tap()
        XCTAssertTrue(app.buttons["settings.row.appearance"].firstMatch.label.contains(original == "dark" ? "White" : "Dark"))
        app.buttons["settings.row.appearance"].firstMatch.tap()
        app.buttons["settings.theme.\(original)"].firstMatch.tap()
        XCTAssertTrue(app.buttons["settings.theme.\(original)"].firstMatch.wait(for: \.isSelected, toEqual: true, timeout: 5))
    }

    func testThisDeviceCanBeRenamedAndRenamedBack() throws {
        try openSettings()
        app.buttons["settings.row.account"].firstMatch.tap()
        let devices = app.buttons["settings.row.devices"].firstMatch
        XCTAssertTrue(devices.waitForExistence(timeout: 10))
        devices.tap()
        let current = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier BEGINSWITH 'settings.device.' AND label CONTAINS 'This device'"
        )).firstMatch
        XCTAssertTrue(current.waitForExistence(timeout: 15))
        let name = String(current.identifier.dropFirst("settings.device.".count))
        rename(current, to: "Agent Test \(run)")
        let renamed = app.descendants(matching: .any)["settings.device.Agent Test \(run)"]
        XCTAssertTrue(renamed.waitForExistence(timeout: 10))
        rename(renamed, to: name)
        XCTAssertTrue(app.descendants(matching: .any)["settings.device.\(name)"].waitForExistence(timeout: 10))
    }

    func testATagIsRenamedEverywhereAndDeleted() throws {
        try openTasksAndAdd("[agent] \(run) tag #\(run) @today")
        app.buttons["More"].firstMatch.tap()
        let tags = app.buttons["settings.row.tags"].firstMatch
        if !tags.waitForExistence(timeout: 3) {
            app.buttons["more.settings"].firstMatch.tap()
        }
        XCTAssertTrue(tags.waitForExistence(timeout: 10))
        if !tags.isHittable { app.collectionViews.firstMatch.swipeUp() }
        tags.tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText(run)
        let row = app.descendants(matching: .any)["settings.tag.\(run)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.press(forDuration: 1)
        app.buttons["Rename"].firstMatch.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.clearAndType("\(run)x")
        app.buttons["Rename"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Renamed' AND label CONTAINS '(1 items)'"))
            .firstMatch.waitForExistence(timeout: 10))
        let renamed = app.descendants(matching: .any)["settings.tag.\(run)x"]
        XCTAssertTrue(renamed.waitForExistence(timeout: 10))
        renamed.press(forDuration: 1)
        app.buttons["Delete"].firstMatch.tap()
        app.buttons["Delete tag"].firstMatch.tap()
        XCTAssertTrue(renamed.waitForNonExistence(timeout: 10))
        deleteTask(containing: "[agent] \(run) tag")
    }

    // MARK: Helpers

    private func openVault() throws {
        app.launch()
        let more = app.buttons["More"].firstMatch
        let vault = app.staticTexts["MemryNote"]
        let signIn = app.staticTexts["Sign in to Memry"]
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !more.exists {
            if signIn.exists {
                XCTFail("Signed out: sign in to the staging test account first (spec 006 goal).")
                throw XCTSkip("signed out")
            }
            if vault.exists { vault.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertTrue(more.waitForExistence(timeout: 5), "the vault did not open")
    }

    private func openSettings() throws {
        try openVault()
        app.buttons["More"].firstMatch.tap()
        let back = app.buttons["BackButton"]
        while back.exists { back.tap() }
        let settings = app.buttons["more.settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        XCTAssertTrue(app.buttons["settings.row.account"].firstMatch.waitForExistence(timeout: 10))
    }

    private func openTasksAndAdd(_ text: String) throws {
        try openVault()
        app.buttons["Tasks"].firstMatch.tap()
        let add = app.buttons["tasks.addButton"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        app.typeText(text)
        app.buttons["tasks.composer.send"].firstMatch.tap()
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        app.buttons["More"].firstMatch.tap()
        let back = app.buttons["BackButton"]
        while back.exists { back.tap() }
        app.buttons["Tasks"].firstMatch.tap()
    }

    /// Removes the test's own task: Tasks › filter search › swipe › Delete.
    private func deleteTask(containing title: String) {
        app.buttons["Tasks"].firstMatch.tap()
        app.buttons["tasks.filterButton"].firstMatch.tap()
        let search = app.textFields["tasks.filter.search"].firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.clearAndType(run)
        app.buttons["tasks.filter.done"].firstMatch.tap()
        let row = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'tasks.row.' AND label BEGINSWITH %@", title
        )).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.swipeLeft()
        app.buttons["tasks.row.swipe.delete"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
        app.buttons["tasks.filterButton"].firstMatch.tap()
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.clearAndType("")
        app.buttons["tasks.filter.done"].firstMatch.tap()
    }

    private func rename(_ element: XCUIElement, to name: String) {
        element.press(forDuration: 1)
        app.buttons["Rename"].firstMatch.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.clearAndType(name)
        app.buttons["Rename"].firstMatch.tap()
    }
}

private extension XCUIElement {
    func clearAndType(_ text: String) {
        if let current = value as? String, !current.isEmpty, current != placeholderValue {
            typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        typeText(text)
    }
}
