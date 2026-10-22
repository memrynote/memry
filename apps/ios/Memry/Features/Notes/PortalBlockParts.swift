import SwiftUI

// The frame a portal draws in: a quiet rail on the leading edge, a header with
// the source's title and an Open source action, and the body or the notice
// under it. Split from `PortalBlockView.swift`, which decides what goes inside.

/// Desktop's `common.json` `portalBlock.*`.
enum PortalCopy {
    static let openSource = "Open source"
    static let loading = "Opening the source…"
    static let untitled = "Untitled"
    static let sourceDeletedTitle = "Source note was deleted"
    static let sourceDeletedBody = "The reference is kept. If the note is restored, this comes back."
    static let missingBlockTitle = "This block no longer exists"
    static let missingBlockBody = "The note is still there. The block was deleted or its ID changed."
    static let cycleTitle = "This portal contains itself"
    static let cycleBody = "The source leads back to this portal. Shown once, then stopped."
    static let tooDeepTitle = "Portal limit reached"
    static let tooDeepBody = "Portals nest up to \(PortalAncestry.maxDepth) levels. Deeper ones open as links."
    static let invalidTitle = "This portal’s definition could not be read"
    static let invalidBody = "It is kept exactly as written. Edit it on desktop, or remove the block there."
    static let failedBody = "This portal could not be opened. Open the source note instead."
    static let searchTitle = "Search portal"
    static let searchHint = "Open this note on desktop to see the matching blocks."

    static func hidden(_ count: Int) -> String { "\(count) hidden" }

    static func searchQuery(text: String?, tag: String?) -> String {
        [text, tag.map { "#\($0)" }].compactMap { $0 }.joined(separator: " ")
    }
}

struct PortalFrame<Content: View>: View {
    let title: String?
    var hiddenCount = 0
    /// `nil` hides the action: a page with no stack to push onto, or a source
    /// that does not exist.
    var openSource: (() -> Void)?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            header
            content()
        }
        .padding(.leading, Tokens.Space.medium)
        .overlay(alignment: .leading) {
            Capsule()
                .fill(Tokens.Text.tertiary.color.opacity(0.45))
                .frame(width: 2)
                .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: "arrow.up.forward.square")
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
            if let title {
                Text(title.isEmpty ? PortalCopy.untitled : title)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
            }
            if hiddenCount > 0 {
                Text(PortalCopy.hidden(hiddenCount))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .padding(.horizontal, Tokens.Space.small)
                    .padding(.vertical, Tokens.Space.tight / 2)
                    .background(Tokens.Canvas.surfaceActive.color, in: Capsule())
            }
            Spacer(minLength: 0)
            if let openSource {
                Button(action: openSource) {
                    Text(PortalCopy.openSource)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.tint.color)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// A portal that shows no blocks, said in the frame the blocks would use.
struct PortalNotice: View {
    var title: String?
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            if let title {
                Text(title)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.primary.color)
            }
            Text(message)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
