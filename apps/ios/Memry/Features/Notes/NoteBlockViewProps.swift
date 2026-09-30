import MemryCore
import SwiftUI
import UIKit

// What a `Block`'s props and runs say, split from `NoteBlockView.swift`.

extension NoteBlockView {
    /// All six levels the schema allows.
    ///
    /// This used to answer three, so a level-four heading and a level-six
    /// heading rendered identically and the note lost structure it really
    /// carried. `DESIGN.md`'s ramp was extended rather than the content
    /// clamped; the clamp that remains is the document's own 1...6.
    var headingRole: TypeRole {
        Tokens.Typography.bodyHeading(level: Int(value("level") ?? "") ?? 1)
    }

    /// BlockNote's bullet ladder: filled, hollow, square, then repeating.
    var bullet: String {
        ["\u{2022}", "\u{25E6}", "\u{25AA}"][Int(block.depth) % 3]
    }

    func value(_ name: String) -> String? {
        block.props.first { $0.name == name }?.value
    }

    /// `textAlignment`, as SwiftUI spells it. `props_of` has always returned
    /// it and nothing read it.
    var alignment: TextAlignment {
        switch value("textAlignment") {
        case "center": .center
        case "right": .trailing
        // `justify` has no `TextAlignment`, and faking it by stretching
        // spaces would be worse than reading as the default.
        default: .leading
        }
    }

    /// The frame alignment that matches [`alignment`], so a centred block sits
    /// centred rather than merely wrapping centred.
    var frameAlignment: Alignment {
        switch alignment {
        case .center: .center
        case .trailing: .trailing
        default: .leading
        }
    }

    func flag(_ name: String) -> Bool {
        value(name) == "true"
    }

    var plainText: String {
        block.inline.map(\.text).joined()
    }

    var inlineImages: [InlineRun] {
        block.inline.filter { $0.marks.contains("inlineImage") }
    }

    var blockInkName: String? {
        value("textColor")
    }

    /// `textAlignment` for a text view, which unlike SwiftUI's `Text` can
    /// justify.
    var textViewAlignment: NSTextAlignment {
        switch value("textAlignment") {
        case "center": .center
        case "right": .right
        case "justify": .justified
        default: .natural
        }
    }
}
