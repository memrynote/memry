import UIKit
import XCTest

// #4345: at regular width every page is a sidebar row, Settings is the last
// one, and the Search row opens search instead of becoming a page.
//
// **Precondition:** an iPad simulator with a vault open (the staging test
// account, or the free vault on this device). A run that lands on sign-in, or
// on an iPhone, skips; a skip is not a pass. A full-screen iPad that shows
// the compact Menu tab fails.
//
// #4348: a "… › settings" link opens Settings' split view on its page.
@MainActor
final class ShellSidebarUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDown() async throws {
        XCUIDevice.shared.orientation = .portrait
    }

    func testTheSidebarSwitchesPagesAndKeepsSearchAside() throws {
        try openVault()
        for page in ["Journal", "Calendar", "Tasks", "Inbox", "Home", "Notes", "Settings"] {
            row(page).tap()
            XCTAssertTrue(row(page).wait(for: \.isSelected, toEqual: true, timeout: 5), page)
        }
        XCTAssertTrue(app.collectionViews["settings.root"].waitForExistence(timeout: 10))

        row("Search").tap()
        XCTAssertTrue(app.buttons["search.close"].waitForExistence(timeout: 5))
        app.buttons["search.close"].tap()
        XCTAssertTrue(row("Settings").wait(for: \.isSelected, toEqual: true, timeout: 5), "Search is not a page")
        XCTAssertFalse(app.buttons["Menu"].exists, "Menu is compact-only")
    }

    /// #4348: Tasks › Task settings lands in Settings' split view, the root
    /// list beside the page, and a page's link pushes inside the detail.
    func testADeepLinkedSettingsPageOpensBesideTheSettingsList() throws {
        try openVault()
        row("Tasks").tap()
        let more = app.buttons["tasks.moreMenu"].firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 20))
        more.tap()
        app.buttons["tasks.settingsLink"].firstMatch.tap()

        XCTAssertTrue(row("Settings").wait(for: \.isSelected, toEqual: true, timeout: 5))
        XCTAssertTrue(anything("tasks.settings.screen").waitForExistence(timeout: 10))
        XCTAssertTrue(app.collectionViews["settings.root"].exists, "the settings list stays beside the page")
        XCTAssertTrue(anything("settings.row.tasks").isSelected)

        anything("settings.row.account").tap()
        let devices = anything("settings.row.devices")
        XCTAssertTrue(devices.waitForExistence(timeout: 10))
        devices.tap()
        XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.collectionViews["settings.root"].exists)
        XCTAssertTrue(anything("settings.row.account").isSelected)

        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.collectionViews["settings.root"].waitForExistence(timeout: 5), "portrait shows both columns")
    }

    // MARK: Helpers

    private func anything(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    /// A sidebar row by its title. The sidebar is the collection view that
    /// holds the Search row; a badge adds its count to the row's label.
    private func row(_ title: String) -> XCUIElement {
        app.collectionViews.containing(.any, identifier: "magnifyingglass").firstMatch
            .cells.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func openVault() throws {
        app.launch()
        let name = ProcessInfo.processInfo.environment["MEMRY_UI_VAULT"] ?? "MemryNote"
        let vault = app.staticTexts[name].firstMatch
        let signIn = app.descendants(matching: .any).matching(NSPredicate(
            format: "label IN {'Sign in to Memry', 'Already have an account? Sign in'}"
        )).firstMatch
        let sidebar = row("Search")
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline, !sidebar.exists {
            if signIn.exists { throw XCTSkip("Signed out: open a vault on this simulator first.") }
            if app.buttons["Menu"].exists {
                guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("Compact width: run on an iPad simulator.") }
                XCTFail("a full-screen iPad shows the compact Menu tab")
                return
            }
            if vault.exists { vault.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertTrue(sidebar.waitForExistence(timeout: 5), "the sidebar did not show")
    }
}
