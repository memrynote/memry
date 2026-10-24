import Foundation
import MemryCore

// Where in a note's blocks a plain-text mention sits, so the Link action can
// replace exactly that range with a wiki link (#3330).
//
// The core lists mentions as the text written, in body order, and matches them
// (whole word, title and aliases, 3 characters minimum). It cannot say which
// block holds one, so the shell finds the block. Every spot found here must
// agree with the core's count for that text; when it does not, the body moved
// on since the list was read and the caller refuses rather than link another
// word.

@MainActor
enum UnlinkedMentionLocator {
    /// A range of one block's text, in core bytes (what `insertInline` takes).
    struct Spot: Equatable {
        let blockId: String
        let start: Int
        let end: Int
    }

    /// Every whole-word, exact-text occurrence of `text`, in body order.
    ///
    /// An inline node splits a block's text, and a mention never spans one, so
    /// each stretch of consecutive plain runs is searched on its own. Marks do
    /// not split it: "**Foo** Bar" is still one mention of "Foo Bar".
    static func spots(of text: String, in blocks: [Block]) -> [Spot] {
        guard !text.isEmpty else { return [] }
        var out: [Spot] = []
        for block in blocks {
            guard let blockId = block.id else { continue }
            var offset = 0
            var stretch = ""
            var stretchStart = 0
            func flush() {
                out += occurrences(of: text, in: stretch).map {
                    Spot(blockId: blockId, start: stretchStart + $0.lowerBound, end: stretchStart + $0.upperBound)
                }
                stretch = ""
            }
            for run in block.inline {
                if BlockText.isNode(run) {
                    flush()
                } else {
                    if stretch.isEmpty { stretchStart = offset }
                    stretch += run.text
                }
                offset += run.text.utf8.count
            }
            flush()
        }
        return out
    }

    /// UTF-8 byte ranges of the whole-word occurrences of `needle` in `text`.
    private static func occurrences(of needle: String, in text: String) -> [Range<Int>] {
        var out: [Range<Int>] = []
        var from = text.startIndex
        while from < text.endIndex,
              let found = text.range(of: needle, options: .literal, range: from..<text.endIndex) {
            let before = found.lowerBound == text.startIndex ? nil : text[text.index(before: found.lowerBound)]
            let after = found.upperBound == text.endIndex ? nil : text[found.upperBound]
            if !isWordCharacter(before), !isWordCharacter(after) {
                out.append(
                    text.utf8.distance(from: text.startIndex, to: found.lowerBound)
                        ..< text.utf8.distance(from: text.startIndex, to: found.upperBound)
                )
            }
            from = found.upperBound
        }
        return out
    }

    /// The core's word rule: a letter, a digit or `_`.
    private static func isWordCharacter(_ character: Character?) -> Bool {
        guard let character else { return false }
        return character.isLetter || character.isNumber || character == "_"
    }
}
