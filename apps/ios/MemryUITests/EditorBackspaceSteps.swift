import XCTest

/// #4152: Backspace at a block's start, the same on a note and a journal
/// day. From the caret at the end of a block reading `line`: Return then
/// Backspace leaves one block, the caret after `line`; Return, `cd`, the caret
/// before `c`, then Backspace joins the two blocks, the caret at the join.
@MainActor
func assertBackspaceJoinsBlocks(in app: XCUIApplication, line: String, file: StaticString = #filePath, line number: UInt = #line) {
    let blocks = app.textViews.matching(NSPredicate(format: "identifier BEGINSWITH 'note.block.'"))
    func text(_ index: Int) -> String { blocks.element(boundBy: index).value as? String ?? "" }
    func focused(_ index: Int) -> Bool {
        blocks.element(boundBy: index).value(forKey: "hasKeyboardFocus") as? Bool ?? false
    }
    func waitUntil(_ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }
    let start = blocks.count

    app.typeText("\n")
    XCTAssertTrue(waitUntil { blocks.count == start + 1 && focused(start) }, "Return made no block", file: file, line: number)
    app.typeText(XCUIKeyboardKey.delete.rawValue)
    XCTAssertTrue(waitUntil { blocks.count == start }, "Backspace left the empty block", file: file, line: number)
    XCTAssertTrue(waitUntil { focused(start - 1) }, "the caret did not go to the block above", file: file, line: number)
    app.typeText("b")
    XCTAssertTrue(waitUntil { text(start - 1) == line + "b" }, "the caret is not after the text: \(text(start - 1))", file: file, line: number)

    app.typeText("\n")
    XCTAssertTrue(waitUntil { blocks.count == start + 1 && focused(start) }, "Return made no block", file: file, line: number)
    app.typeText("cd")
    XCTAssertTrue(waitUntil { text(start) == "cd" }, text(start), file: file, line: number)
    // A tap snaps the caret to the end of the word: the arrow keys put it
    // before "c".
    app.typeKey(.leftArrow, modifierFlags: [])
    app.typeKey(.leftArrow, modifierFlags: [])
    app.typeText(XCUIKeyboardKey.delete.rawValue)
    XCTAssertTrue(waitUntil { blocks.count == start }, "Backspace did not join the blocks", file: file, line: number)
    XCTAssertTrue(waitUntil { text(start - 1) == line + "bcd" }, text(start - 1), file: file, line: number)
    XCTAssertTrue(waitUntil { focused(start - 1) }, "the caret did not stay in the joined block", file: file, line: number)
    app.typeText("X")
    XCTAssertTrue(waitUntil { text(start - 1) == line + "bXcd" }, "the caret is not at the join: \(text(start - 1))", file: file, line: number)
}
