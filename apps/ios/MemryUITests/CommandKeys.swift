import XCTest

extension XCUIApplication {
    /// #4626: on a simulator with a hardware keyboard connected, iPadOS
    /// raises its "Hold ⌘" overlay after each launch. It is a second, empty
    /// window in the AX tree that `simctl io` does not capture, and it takes
    /// the first ⌘ key, plus the keys pressed while it animates in. The app
    /// never sees them. ⌘0 is bound to nothing, so it spends that key and
    /// does nothing when no overlay is up. Call it once after `launch()`,
    /// before a test's first ⌘ key.
    func primeCommandKeys() {
        typeKey("0", modifierFlags: .command)
        Thread.sleep(forTimeInterval: 3)
    }
}
