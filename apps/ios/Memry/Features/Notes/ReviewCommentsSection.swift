import MemryCore
import SwiftUI

/// The note's review comments and suggestions, read only (N604).
///
/// **A list rather than marks drawn over the text.** A mark's offsets are
/// byte offsets into the markdown desktop writes, and this client never holds
/// that markdown (§12.1), so there is nothing here to lay them over. What
/// each mark says — what it covers, what it proposes, what the reviewer wrote
/// — is all in the mark itself, and that is what this shows.
///
/// Absent when the note has none, like the other sections under the body.
struct ReviewCommentsSection: View {
    let comments: [ReviewComment]

    var body: some View {
        if !comments.isEmpty {
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                Text("Review")
                    .font(Tokens.Typography.sectionTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityAddTraits(.isHeader)
                ForEach(comments, id: \.id) { comment in
                    ReviewCommentRow(comment: comment)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct ReviewCommentRow: View {
    let comment: ReviewComment

    private var kindLabel: String {
        switch comment.kind {
        case .addition: "Suggested insertion"
        case .deletion: "Suggested deletion"
        case .substitution: "Suggested replacement"
        case .comment: "Comment"
        }
    }

    private var symbol: String {
        switch comment.kind {
        case .addition: "plus.circle"
        case .deletion: "minus.circle"
        case .substitution: "arrow.left.arrow.right.circle"
        case .comment: "text.bubble"
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(kindLabel)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                if comment.kind == .substitution, let original = comment.originalText, !original.isEmpty {
                    Text(original)
                        .strikethrough()
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                Text(comment.visibleText)
                    .strikethrough(comment.kind == .deletion)
                    .foregroundStyle(Tokens.Text.primary.color)
                if let body = comment.body, !body.isEmpty {
                    Text(body)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            .font(Tokens.Typography.body.font)
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
        .accessibilityElement(children: .combine)
    }
}
