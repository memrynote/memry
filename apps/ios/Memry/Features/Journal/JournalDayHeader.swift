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
    /// How far the fog reaches up past the heading: to the window top, so
    /// it lines up with the day screen's fog under the toolbar.
    let fogReach: CGFloat

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
        // The heading keeps the reading measure; the fog behind it spans the
        // pane, as it lines up with the fog under the toolbar.
        .readingColumn()
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

    /// The fog bleeding past the column and up to the window top.
    private var fog: some View {
        JournalFog(hour: hour)
            .padding(-Tokens.Space.screenInline)
            .padding(.top, Tokens.Space.screenInline - fogReach)
    }
}

/// Where the shown day's fog sits in the window. The day page clips its fog
/// at the toolbar, so the day screen draws the same fog under the toolbar.
struct JournalFogPlacement: Equatable {
    /// The heading's frame in the global space.
    let header: CGRect
    /// The heading's distance from the window top when not scrolled.
    let reach: CGFloat
    let hour: Int

    /// The fog's frame in the global space: the heading plus the overhang,
    /// reaching up to the window top when not scrolled.
    var frame: CGRect {
        let inline = Tokens.Space.screenInline
        return CGRect(
            x: header.minX - inline,
            y: header.minY - reach,
            width: header.width + inline * 2,
            height: reach + header.height + inline
        )
    }
}

/// Two static radial blobs behind the heading (Paper "Morning fog"). No
/// animation; absent under Reduce Transparency.
struct JournalFog: View {
    let hour: Int

    var body: some View {
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

    private var hasMetadata: Bool {
        !metadata.tags.isEmpty || !metadata.properties.isEmpty || !metadata.aliases.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            NoteNamesLine(names: metadata.aliases, write: nil, adding: .constant(false))
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
/// Return starts the block after the line's block, which takes the caret
/// and the keys typed after the Return (#4705).
struct JournalDayFirstLine: View {
    let placeholder: String
    let write: JournalFirstLineDraft.Write

    @State private var draft = JournalFirstLineDraft()
    @FocusState private var focused: Bool

    var body: some View {
        // The setter sees each keystroke as UIKit makes it. The Return is
        // split off there: a render later, keys typed after it are in the
        // text too, and the newline is no longer last.
        TextField(
            JournalCopy.firstLineLabel,
            text: Binding(get: { draft.text }, set: { draft.typed($0, write: write) }),
            prompt: prompt,
            axis: .vertical
        )
        .font(Tokens.Typography.body.font)
        .foregroundStyle(Tokens.Text.primary.color)
        .focused($focused)
        .frame(minHeight: Tokens.Size.minimumHitArea, alignment: .topLeading)
        .onChange(of: focused) { _, isFocused in
            draft.focused = isFocused
            if !isFocused { draft.landAll(write: write) }
        }
        .onDisappear { draft.landAll(write: write) }
        .accessibilityLabel(JournalCopy.firstLineLabel)
        .accessibilityHint(placeholder)
        .accessibilityIdentifier("journal.day.firstLine")
    }

    private var prompt: Text {
        Text(placeholder).foregroundStyle(Tokens.Text.tertiary.color)
    }
}

/// The first line's text and its writes, kept by reference: the block its
/// Return lands as takes the keys held for it once the field has gone away.
@MainActor
@Observable
final class JournalFirstLineDraft {
    /// Writes `line`, `true` when it landed; a failure keeps what was typed.
    /// `carrying` is the draft whose keys typed after the line's Return go to
    /// the block the line lands as, `nil` for a line without a Return.
    typealias Write = (_ line: String, _ carrying: JournalFirstLineDraft?) async -> Bool

    var text = ""
    /// The field has the caret: a Return's block may take it.
    @ObservationIgnored var focused = false
    /// The Return whose line is landing, while the keys after it wait.
    @ObservationIgnored private(set) var returned: LineReturn?
    /// The writes in flight, one after another so lines land in order.
    @ObservationIgnored private(set) var landing: Task<Void, Never>?

    func typed(_ value: String, write: @escaping Write) {
        if let burst = returned {
            text = value
            // An edit past the Return (a Backspace) joins the held keys to
            // the line, which is already landing: they land as typed.
            if burst.held(in: value) == nil { returned = nil }
            return
        }
        guard let burst = LineReturn(previous: text, value: value) else { return text = value }
        // Return on an empty line writes nothing and stays.
        guard !burst.line.trimmingCharacters(in: .whitespaces).isEmpty else {
            return text = burst.held(in: value) ?? ""
        }
        text = value
        returned = burst
        land(burst.line, returning: burst, write: write)
    }

    /// The field lost the caret or went away: what it holds lands as lines
    /// of their own. Keys held for a Return's block wait for the line's
    /// write and a turn after it, as that block takes them as it takes the
    /// caret. The day's new block removes the field before the write
    /// returns, so the field goes away first; they land here only when the
    /// block did not take them.
    func landAll(write: @escaping Write) {
        guard returned != nil else { return landRest(write: write) }
        let landing = landing
        Task {
            await landing?.value
            DispatchQueue.main.async { self.landRest(write: write) }
        }
    }

    /// The Return's block took the caret: the keys typed since the Return,
    /// after a Return of their own, which makes the next block as it does
    /// there, at any typing speed. `moved` false: the block refused the
    /// caret, and the keys stay in the field (`TitleBurst.Take`).
    func takeHeld(_ moved: Bool) -> String? {
        guard let burst = returned else { return nil }
        returned = nil
        let held = burst.held(in: text) ?? ""
        text = moved ? "" : held
        return moved ? "\n" + held : nil
    }

    private func landRest(write: @escaping Write) {
        let lines = returned.map { $0.held(in: text) ?? "" } ?? text
        returned = nil
        text = ""
        lines.split(separator: "\n").forEach { land(String($0), returning: nil, write: write) }
    }

    private func land(_ line: String, returning burst: LineReturn?, write: @escaping Write) {
        let line = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        let previous = landing
        landing = Task {
            await previous?.value
            guard !(await write(line, burst == nil ? nil : self)) else { return }
            // A failure keeps the line in the field to try again. A Return
            // still waiting has its line in the field already, as typed.
            if let burst, returned == burst { return returned = nil }
            text = text.isEmpty ? line : "\(line) \(text)"
        }
    }
}
