import MemryCore

// The trailing ` ^anchor` a block carries so a portal can name it (§12.6.3).
// It stays in the text and the markdown; a reader never draws it.

enum PortalAnchor {
    /// The runs without a trailing anchor. Same rule as the core's
    /// `extract_anchor`: whitespace (or the start), a caret, an anchor, then
    /// only whitespace. A caret inside a word is text.
    static func stripped(_ runs: [InlineRun]) -> [InlineRun] {
        let text = runs.map(\.text).joined()
        guard text.contains("^"), let keep = textLength(beforeAnchorIn: text) else { return runs }
        var left = keep
        var out: [InlineRun] = []
        for run in runs {
            guard left > 0 else { break }
            let count = run.text.utf16.count
            if count <= left {
                out.append(run)
                left -= count
            } else {
                var cut = run
                cut.text = String(run.text.utf16.prefix(left)) ?? ""
                out.append(cut)
                left = 0
            }
        }
        return out
    }

    /// UTF-16 length of the text before the anchor suffix, or `nil` with none.
    private static func textLength(beforeAnchorIn text: String) -> Int? {
        let units = Array(text.utf16)
        var end = units.count
        while end > 0, isSpace(units[end - 1]) { end -= 1 }
        var caret = end
        while caret > 0, units[caret - 1] != 0x5E, caret > end - 33 { caret -= 1 }
        guard caret > 0, units[caret - 1] == 0x5E else { return nil }
        let body = String(decoding: units[caret..<end], as: UTF16.self)
        guard PortalFence.isAnchor(body) else { return nil }
        let caretIndex = caret - 1
        if caretIndex == 0 { return 0 }
        return isSpace(units[caretIndex - 1]) ? caretIndex - 1 : nil
    }

    private static func isSpace(_ unit: UInt16) -> Bool {
        unit == 0x20 || (0x09...0x0D).contains(unit) || unit == 0xA0
    }
}
