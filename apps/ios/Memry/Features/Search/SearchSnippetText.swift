import MemryCore
import SwiftUI

/// The body text around a hit's match, under its title (#4316), after
/// desktop's highlighted search snippet. The core hands over segments; the
/// matched ones are drawn semibold. A title-only match carries plain segments
/// and still shows them; a hit with an empty body shows nothing.
struct SearchSnippetText: View {
    let segments: [SnippetSegment]

    var body: some View {
        if let text = Self.attributed(segments) {
            Text(text)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .lineLimit(2)
        }
    }

    static func attributed(_ segments: [SnippetSegment]) -> AttributedString? {
        guard !segments.isEmpty else { return nil }
        var text = AttributedString()
        for segment in segments {
            var run = AttributedString(segment.text)
            if segment.highlighted {
                run.font = Tokens.Typography.supporting.font.weight(.semibold)
            }
            text.append(run)
        }
        return text
    }
}
