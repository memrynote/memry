import XCTest

/// B0/S3's screenshot half. XCTest, not Swift Testing: UI automation has no
/// Swift Testing equivalent.
///
/// The tap is not optional. R16: "keyboard up without a tap" has no public API,
/// so the guest calls `.focus()` inside a real touch handler — and the
/// simulator's hardware keyboard must be off, or the software keyboard never
/// appears and the accessory view is never rendered. The keyboard assertion
/// below is there so that misconfiguration fails the test instead of quietly
/// producing a screenshot with no toolbar in it.
final class SpikeS3ToolbarUITests: XCTestCase {
    func testKeyboardToolbarScreenshot() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike-s3"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))

        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 15), "the S3 web view never appeared")
        attach(named: "01-before-tap")

        // A real touch: the guest's `touchend` handler is what calls `.focus()`.
        webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).tap()

        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 15),
            "no software keyboard — the simulator's hardware keyboard is still connected (⇧⌘K)"
        )
        // iOS shows the QuickPath introduction over the keyboard on a fresh
        // simulator, which covers the accessory view.
        let continueButton = app.buttons["Continue"]
        if continueButton.waitForExistence(timeout: 3) {
            continueButton.tap()
        }

        // The accessory view animates in with the keyboard.
        Thread.sleep(forTimeInterval: 2)
        attach(named: "02-keyboard-toolbar")
    }

    private func attach(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
