import XCTest

/// Toggles Reduce Transparency through the Settings app.
///
/// `xcrun simctl spawn <udid> defaults write com.apple.Accessibility
/// ReduceTransparencyEnabled -bool true` does **not** reach
/// `UIAccessibility.isReduceTransparencyEnabled`: it was tried, it survived a
/// device reboot in the plist, and the app still read `false`. Driving the real
/// switch is the only route that changes what the app sees, and the toolbar
/// badge in the screenshot is what proves it landed.
final class SpikeReduceTransparencyUITests: XCTestCase {
    func testEnableReduceTransparency() {
        setReduceTransparency(enabled: true)
    }

    func testDisableReduceTransparency() {
        setReduceTransparency(enabled: false)
    }

    private func setReduceTransparency(enabled: Bool) {
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.launch()
        XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 20))

        tapCell(settings, "Accessibility")
        tapCell(settings, "Display & Text Size")

        let toggle = settings.switches["Reduce Transparency"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 20), "Reduce Transparency switch not found")
        settings.scrollViews.firstMatch.scrollToElement(toggle)
        let isOn = (toggle.value as? String) == "1"
        if isOn != enabled {
            toggle.switches.firstMatch.tap()
        }
        XCTAssertEqual((toggle.value as? String) == "1", enabled, "the switch did not change")
    }

    private func tapCell(_ app: XCUIApplication, _ label: String) {
        let cell = app.cells.staticTexts[label].firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 20), "\(label) row not found")
        cell.tap()
    }
}

private extension XCUIElement {
    /// Settings rows below the fold are not hittable until scrolled to.
    func scrollToElement(_ element: XCUIElement) {
        var attempts = 0
        while !element.isHittable && attempts < 10 {
            swipeUp()
            attempts += 1
        }
    }
}
