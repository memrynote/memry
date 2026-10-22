import SwiftUI

// The frame a portal draws in: a quiet 2pt rail on the leading edge, a header
// with the source's title and an Open source action, and the body under it. A
// portal that shows no blocks swaps both for one state row (Paper board 8).
// Split from `PortalBlockView.swift`, which decides what goes inside.

/// Why a portal shows no blocks.
enum PortalState: Equatable {
    case cycle
    case tooDeep
    case missingNote
    case missingBlock
    case invalid
    case search(text: String?, tag: String?)
    case failed

    /// Whether Open source is a useful next step from here.
    var offersSource: Bool {
        switch self {
        case .cycle, .tooDeep, .missingBlock, .failed: true
        case .missingNote, .invalid, .search: false
        }
    }
}

/// Desktop's `common.json` `portalBlock.*`, in the app's language.
enum PortalCopy {
    static let openSource = String(localized: "Open source")
    static let loading = String(localized: "Opening the source…")
    static let untitled = String(localized: "Untitled")

    static func text(for state: PortalState, source: String?) -> String {
        switch state {
        case .missingNote:
            String(localized: "The source note was deleted. The reference is kept.")
        case .missingBlock:
            String(localized: "The block was deleted in \(source.flatMap { $0.isEmpty ? nil : $0 } ?? untitled).")
        case .cycle:
            String(localized: "This portal leads back to itself.")
        case .tooDeep:
            String(localized: "Portals nest \(PortalAncestry.maxDepth) deep. This one opens as a link.")
        case .invalid:
            String(localized: "This portal’s definition could not be read. It is kept as written.")
        case let .search(text, tag):
            String(localized: "Search portal: \(searchQuery(text: text, tag: tag)). Shown on desktop.")
        case .failed:
            String(localized: "This portal could not be opened. Open the source note instead.")
        }
    }

    static func searchQuery(text: String?, tag: String?) -> String {
        [text, tag.map { "#\($0)" }].compactMap { $0 }.joined(separator: " ")
    }
}

/// The rail and its gutter. `overlay(alignment: .leading)` and `padding(.leading)`
/// follow the layout direction, so the rail sits on the right in RTL.
private struct PortalRail<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
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
}

struct PortalFrame<Content: View>: View {
    let title: String?
    /// A portal that shows no blocks draws this row instead of a header.
    var state: PortalState?
    /// `nil` hides the action: a page with no stack to push onto, or a source
    /// that does not exist.
    var openSource: (() -> Void)?
    @ViewBuilder let content: () -> Content

    var body: some View {
        PortalRail {
            if let state {
                PortalStateRow(
                    text: PortalCopy.text(for: state, source: title),
                    openSource: state.offersSource ? openSource : nil
                )
            } else {
                VStack(alignment: .leading, spacing: Tokens.Space.small) {
                    header
                    content()
                }
            }
        }
    }

    private var header: some View {
        HStack(spacing: Tokens.Space.small) {
            if let title {
                Text(title.isEmpty ? PortalCopy.untitled : title)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer(minLength: 0)
            PortalOpenSourceButton(action: openSource)
        }
    }
}

private struct PortalOpenSourceButton: View {
    let action: (() -> Void)?

    var body: some View {
        if let action {
            Button(action: action) {
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

/// One quiet line: what is wrong, and Open source when that helps. It wraps
/// at large Dynamic Type sizes rather than truncating.
struct PortalStateRow: View {
    let text: String
    var openSource: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Text(text)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            PortalOpenSourceButton(action: openSource)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
