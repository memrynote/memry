import MemryCore
import SwiftUI

// JP040. The Day page's own parts above the note page content: the date
// header over its time-of-day fog (J01, J10), the read-only tags and
// properties with the ghost row while the metadata gate is off (D5), and the
// editable placeholder line of an empty day (J01, J10).

/// Weekday line, TODAY badge and the serif date title (Paper "Date title").
struct JournalDayHeader: View {
    let date: String
    let today: String
    /// The hour the fog is tinted for (desktop's buckets).
    let hour: Int

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var isToday: Bool { date == today }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            HStack(spacing: Tokens.Space.small) {
                Text(JournalCopy.weekdayLine(date: date, today: today))
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                if isToday { todayBadge }
            }
            // J04: the title opens the same menu as the inline title.
            Menu {
                JournalTitleMenu(date: date)
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
                    Text(JournalCopy.dayTitle(date))
                        .font(Tokens.Journal.title.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .multilineTextAlignment(.leading)
                    Image(systemName: "chevron.down")
                        .font(Tokens.Typography.body.font.weight(.semibold))
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("journal.day.titleMenu")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { if !reduceTransparency { fog } }
        // One heading for VoiceOver (JP057); `.combine` keeps the title
        // menu's activation, so double-tap still opens Month / Year / Go to.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(JournalCopy.headerLabel(date: date, today: today))
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("journal.day.header")
    }

    private var todayBadge: some View {
        Text(JournalCopy.todayBadge)
            .font(Tokens.Typography.caption.font.weight(.semibold))
            .foregroundStyle(Tokens.Text.tint.color)
            .padding(.horizontal, Tokens.Space.small)
            .padding(.vertical, Tokens.Space.tight / 2)
            .background(
                Capsule().fill(Tokens.Tint.base.color.opacity(Tokens.Palette.chipFillAlpha))
            )
    }

    /// Two static radial blobs behind the heading (Paper "Morning fog"),
    /// bleeding past the column. No animation; absent under Reduce
    /// Transparency.
    private var fog: some View {
        let tint = Tokens.Journal.fog(hour: hour).color
        let alpha = Tokens.Journal.fogAlpha
        return ZStack {
            EllipticalGradient(
                colors: [tint.opacity(alpha), tint.opacity(0)],
                center: UnitPoint(x: 0.2, y: 0.35),
                endRadiusFraction: 0.55
            )
            EllipticalGradient(
                colors: [tint.opacity(alpha * 0.64), tint.opacity(0)],
                center: UnitPoint(x: 0.75, y: 0.45),
                endRadiusFraction: 0.45
            )
        }
        .padding(-Tokens.Space.screenInline)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The tags and properties while the phone may not write them (D5, G0): the
/// note page's read-only rows, the ghost row drawn disabled, and the one
/// limitation line when the day carries metadata or a ghost was tapped.
struct JournalDayReadOnlyMetadata: View {
    let metadata: NoteMetadata
    @Binding var explains: Bool

    private var hasMetadata: Bool { !metadata.tags.isEmpty || !metadata.properties.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            NoteMetaView(metadata: metadata)
            // Side by side, stacked when the two do not fit (AX sizes, JP057)
            // rather than hyphenating a word across lines.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Tokens.Space.medium) { ghosts }
                VStack(alignment: .leading, spacing: 0) { ghosts }
            }
            if hasMetadata || explains {
                Text(JournalCopy.metadataReadOnly)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("journal.day.metadataReadOnly")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var ghosts: some View {
        ghost(JournalCopy.ghostTag, label: JournalCopy.addTag, id: "journal.day.addTag")
        ghost(JournalCopy.ghostProperty, label: JournalCopy.addProperty, id: "journal.day.addProperty")
    }

    private func ghost(_ title: String, label: String, id: String) -> some View {
        Button {
            explains = true
        } label: {
            Label(title, systemImage: "plus")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(JournalCopy.metadataReadOnlyHint)
        .accessibilityIdentifier(id)
    }
}

/// The empty day's first line: the placeholder as an editable field.
/// Text lands on Return, when the field loses focus, and when the page goes
/// away, always on this field's own day; an empty field writes nothing (D2).
struct JournalDayFirstLine: View {
    let placeholder: String
    /// `true` when the line landed; a failure keeps what was typed.
    let write: (String) async -> Bool

    @State private var text = ""
    @State private var committing = false
    @FocusState private var focused: Bool

    var body: some View {
        TextField(JournalCopy.firstLineLabel, text: $text, prompt: prompt, axis: .vertical)
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .focused($focused)
            .frame(minHeight: Tokens.Size.minimumHitArea, alignment: .topLeading)
            .onChange(of: text) { _, value in
                // Return in a vertical field is a newline: treat it as done.
                guard value.contains("\n") else { return }
                text = value.replacingOccurrences(of: "\n", with: "")
                commit()
            }
            .onChange(of: focused) { _, isFocused in
                if !isFocused { commit() }
            }
            .onDisappear { commit() }
            .accessibilityLabel(JournalCopy.firstLineLabel)
            .accessibilityHint(placeholder)
            .accessibilityIdentifier("journal.day.firstLine")
    }

    private var prompt: Text {
        Text(placeholder).foregroundStyle(Tokens.Text.tertiary.color)
    }

    private func commit() {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, !committing else { return }
        committing = true
        Task {
            if await write(line) { text = "" }
            committing = false
        }
    }
}
