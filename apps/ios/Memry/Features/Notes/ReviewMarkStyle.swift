import MemryCore
import SwiftUI

extension EnvironmentValues {
    /// Whether a note title exists in this vault (`nil`: not known yet).
    @Entry var noteTitleExists: ((String) -> Bool)?
    /// Review marks to draw over the body text.
    @Entry var reviewMarks: [ReviewComment] = []
    /// Each task block's task, by task id.
    @Entry var taskCards: [String: TaskCard] = [:]
}

/// Review marks drawn over the text they cover, as desktop draws them.
///
/// **Found by text, not by offset.** A mark's offsets are byte offsets into
/// the markdown desktop writes, and this client never holds that markdown
/// (§12.1), so there is nothing to count them against. What a mark does carry
/// is the text it covers, and a mark whose text occurs exactly once in the
/// note can only mean that occurrence. A mark whose text repeats is left to
/// the Review list under the body rather than drawn over a guess:
/// highlighting the wrong sentence is worse than not highlighting at all.
enum ReviewMarkStyle {
    /// The marks whose covered text occurs exactly once in `text`.
    static func unambiguous(_ marks: [ReviewComment], in text: String) -> [ReviewComment] {
        marks.filter { mark in
            let needle = mark.visibleText
            guard !needle.isEmpty, let first = text.range(of: needle) else { return false }
            return text.range(of: needle, range: first.upperBound..<text.endIndex) == nil
        }
    }

    static func apply(_ marks: [ReviewComment], to text: AttributedString) -> AttributedString {
        guard !marks.isEmpty else { return text }
        var out = text
        for mark in marks {
            guard let range = out.range(of: mark.visibleText) else { continue }
            switch mark.kind {
            case .comment, .substitution:
                out[range].backgroundColor = (Tokens.Content.fill(named: "orange")
                    ?? Tokens.Canvas.surface).color
                out[range].underlineStyle = .single
            case .addition:
                out[range].backgroundColor = (Tokens.Content.fill(named: "blue")
                    ?? Tokens.Canvas.surface).color
                out[range].foregroundColor = (Tokens.Content.ink(named: "blue")
                    ?? Tokens.Text.primary).color
            case .deletion:
                out[range].backgroundColor = (Tokens.Content.fill(named: "red")
                    ?? Tokens.Canvas.surface).color
                out[range].foregroundColor = (Tokens.Content.ink(named: "red")
                    ?? Tokens.Text.primary).color
                out[range].strikethroughStyle = .single
            }
        }
        return out
    }
}
