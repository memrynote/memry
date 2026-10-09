import XCTest

// Issue #2818: with the keyboard up on the recovery-phrase screen, the
// sign-out bar rode up over Unlock, and a tap aimed at Unlock opened the
// sign-out dialog.
//
// **Precondition:** signed in to the staging test account but not unlocked
// (OTP done, recovery phrase not entered yet), so the app opens on the unlock
// route. The test never types a phrase.
@MainActor
final class RecoveryPhraseUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testUnlockStaysTappableWithTheKeyboardUp() throws {
        app.launch()
        let chooser = app.buttons["Enter your recovery phrase"].firstMatch
        let field = app.descendants(matching: .any).matching(NSPredicate(
            format: "label == 'Recovery phrase' AND (elementType == %d OR elementType == %d)",
            XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue
        )).firstMatch
        if chooser.waitForExistence(timeout: 15), !field.exists { chooser.tap() }
        guard field.waitForExistence(timeout: 10) else {
            return XCTFail("Not on the recovery-phrase screen. Sign in to staging without unlocking first.")
        }
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "software keyboard did not appear")

        let unlock = app.buttons["Unlock"].firstMatch
        XCTAssertTrue(unlock.waitForExistence(timeout: 5))
        attach("keyboard-up")

        XCTAssertFalse(app.buttons["Sign out"].firstMatch.exists, "Sign out is drawn over the phrase entry while the keyboard is up")
        XCTAssertTrue(unlock.isHittable)
        unlock.tap()
        XCTAssertFalse(
            app.staticTexts["Sign out of Memry on this phone?"].waitForExistence(timeout: 2),
            "tapping Unlock opened the sign-out dialog"
        )
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
