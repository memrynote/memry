import MemryCore
import SwiftUI

// IB01 / IB07 / IB08. One capture in the list (Paper 01): the type glyph in a
// 24pt lane, the title, a voice transcript line, one meta line (source or
// kind, then age), an image thumbnail trailing; stale rows dim with an amber
// age. Leading swipe files, trailing swipe snoozes or archives (07); a long
// press opens the row menu (08).

struct InboxRow: View {
    let item: InboxItemRecord
    let store: InboxStore
    let now: Date
    var selecting = false
    var selected = false
    /// A row in Archived: aged by `archivedAt`, never stale.
    var archived = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @ScaledMetric(relativeTo: .body) private var lane: CGFloat = Tokens.Space.section

    private var text: InboxRowText {
        InboxRowText.make(item, now: now, staleDays: Int(store.staleDays), archived: archived)
    }
    private var isStale: Bool {
        !archived && now.timeIntervalSince1970 * 1000 - Double(item.createdAtMs) > Double(store.staleDays) * 86_400_000
    }

    var body: some View {
        let text = text
        HStack(alignment: .top, spacing: Tokens.Space.medium) {
            if selecting {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(selected ? Tokens.Tint.base.color : Tokens.Text.tertiary.color)
                    .frame(width: lane, height: Tokens.Size.minimumHitArea)
                    .accessibilityHidden(true)
            } else {
                // Paper 16: the selection circle takes the type icon's lane.
                InboxTypeIcon(type: item.itemType)
            }
            HStack(alignment: .center, spacing: Tokens.Space.medium) {
                VStack(alignment: .leading, spacing: Tokens.Space.tight - 1) {
                    Text(text.title)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .lineLimit(2)
                    if let preview = text.preview {
                        Text(preview)
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                            .lineLimit(1)
                    }
                    InboxMetaLine(parts: text.meta)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if item.itemType == "image" {
                    InboxThumbnail(url: store.localFile(item.thumbnailPath ?? item.attachmentPath))
                }
            }
            .padding(.vertical, Tokens.Space.small + 3)
        }
        .opacity(isStale ? 0.6 : 1)
        .opacity(store.fresh.contains(item.id) && !appeared && !reduceMotion ? 0 : 1)
        .onAppear {
            guard store.fresh.contains(item.id), !reduceMotion else { return }
            withAnimation(.easeOut(duration: 0.35)) { appeared = true }
        }
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(InboxCopy.itemAccessibility(type: item.itemType, title: text.accessibility))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("inbox.row.\(item.id)")
    }
}

/// The one meta line: pieces separated by space, accented ones in amber.
struct InboxMetaLine: View {
    let parts: [InboxMetaPart]

    var body: some View {
        HStack(spacing: Tokens.Space.small + 2) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                Text(part.text)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(part.accented ? Tokens.Inbox.stale.color : Tokens.Text.tertiary.color)
                    .lineLimit(1)
            }
        }
    }
}

/// A group header (Paper 01): "Today 4".
struct InboxGroupHeader: View {
    let period: InboxPeriod
    let count: Int

    var body: some View {
        HStack(spacing: Tokens.Space.tight + 2) {
            Text(period.label)
                .font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
            Text("\(count)")
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(InboxCopy.sectionAccessibility(period.label, count: count))
        .accessibilityAddTraits(.isHeader)
    }
}
