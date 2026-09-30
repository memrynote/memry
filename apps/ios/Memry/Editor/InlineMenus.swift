//
//  InlineMenus.swift
//  The three menus that put an inline node into a block.
//
//  N601 (dates), N602 (wiki links), N603 (pasted links). All three write
//  through `insertInline`, because y-prosemirror carries these as elements
//  beside the block's text rather than as marks.
//

import MemryCore
import SwiftUI

/// Dates, spelled the one way the document stores them.
enum NoteDates {
    /// The `yyyy-MM-dd` a `dateMention` carries, for the day this date falls
    /// on **in the given calendar**.
    ///
    /// **Built from calendar components rather than by a formatter with a
    /// fixed time zone**, and the difference is a real bug rather than a
    /// nicety: a `DatePicker` hands back local midnight, so formatting that
    /// instant in UTC spells the *previous* day for anyone east of Greenwich.
    /// A user in Istanbul picking the 23rd would have written the 22nd.
    ///
    /// A calendar day has no time zone. What the note records is the day the
    /// user saw in the picker, so the components are taken in their calendar
    /// and spelled verbatim.
    static func string(from date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            parts.year ?? 0,
            parts.month ?? 0,
            parts.day ?? 0
        )
    }

    /// The suggestions desktop offers, as (label, date) pairs.
    ///
    /// Computed from `today` rather than from `Date()` so the list is
    /// testable: a suggestion list that depends on the wall clock can only be
    /// asserted by guessing what the clock said.
    static func suggestions(from today: Date, calendar: Calendar = .current) -> [(String, Date)] {
        let start = calendar.startOfDay(for: today)
        return [
            ("Today", start),
            ("Tomorrow", calendar.date(byAdding: .day, value: 1, to: start) ?? start),
            ("Next week", calendar.date(byAdding: .day, value: 7, to: start) ?? start),
            ("Next month", calendar.date(byAdding: .month, value: 1, to: start) ?? start),
        ]
    }

    /// How a chosen date reads in the note.
    static func label(for date: Date, calendar: Calendar = .current, now: Date = Date()) -> String {
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

/// Picking a date to mention (N601), from the page menu.
struct DateMentionSheet: View {
    let insert: (DateMentionValue) -> Void
    let cancel: () -> Void

    @State private var day = Date()
    @State private var remindMe = false

    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Date", selection: $day, displayedComponents: .date)
                Toggle("Remind me", isOn: $remindMe)
            }
            .navigationTitle("Mention a date")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Insert") {
                        let at9 = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
                        var value = DateMentionValue(dateISO: DateMentionValue.iso(at9), hasTime: false)
                        if remindMe { value.remind = "at" }
                        insert(value)
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                }
            }
        }
    }
}

/// Linking to another note (N602), from the page menu. The same rows as the
/// `[[` menu, including desktop's create row for a title nothing carries.
struct WikiLinkSheet: View {
    let titles: [String]
    let insert: (EditorSuggestion.Kind) -> Void
    let cancel: () -> Void

    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                TextField("Search notes", text: $query)
                    .accessibilityLabel("Search notes")
                ForEach(EditorSuggestions.wiki(query: query, titles: titles)) { item in
                    Button {
                        insert(item.kind)
                    } label: {
                        Label(item.title, systemImage: item.symbol)
                    }
                }
            }
            .navigationTitle("Link to a note")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                }
            }
        }
    }
}

/// What a pasted link can become (N603).
enum PastedLink: Equatable, Sendable {
    /// An ordinary link over the pasted text.
    case url
    /// A wiki link to a note of that name.
    case mention
    /// A `youtubeEmbed` block.
    case video
    /// A `bookmark` block.
    case bookmark

    /// The choices worth offering for one address.
    ///
    /// **A video option only where the address is a video**, because an
    /// option that produces an empty player is worse than not offering it.
    static func choices(for address: String) -> [PastedLink] {
        var out: [PastedLink] = [.url, .bookmark, .mention]
        if videoId(of: address) != nil {
            out.insert(.video, at: 1)
        }
        return out
    }

    /// The YouTube id in an address, or `nil`.
    ///
    /// Both spellings YouTube uses, because a user pastes whichever one the
    /// share sheet gave them.
    static func videoId(of address: String) -> String? {
        guard let url = URL(string: address), let host = url.host()?.lowercased() else {
            return nil
        }
        if host.contains("youtu.be") {
            let id = url.lastPathComponent
            return id.isEmpty ? nil : id
        }
        guard host.contains("youtube.") else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first { $0.name == "v" }?
            .value
    }

    var name: String {
        switch self {
        case .url: "Link"
        case .mention: "Mention a note"
        case .video: "Embed the video"
        case .bookmark: "Bookmark card"
        }
    }

    var symbol: String {
        switch self {
        case .url: "link"
        case .mention: "at"
        case .video: "play.rectangle"
        case .bookmark: "bookmark"
        }
    }
}

/// The menu shown after a link is pasted (N603).
struct PasteLinkMenu: View {
    let address: String
    let choose: (PastedLink) -> Void

    var body: some View {
        Menu {
            ForEach(PastedLink.choices(for: address), id: \.self) { choice in
                Button {
                    choose(choice)
                } label: {
                    Label(choice.name, systemImage: choice.symbol)
                }
            }
        } label: {
            Label("Paste as", systemImage: "doc.on.clipboard")
                .labelStyle(.iconOnly)
        }
        .accessibilityLabel("Choose what this link becomes")
    }
}
