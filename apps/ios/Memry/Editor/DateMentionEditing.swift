//
//  DateMentionEditing.swift
//  Tapping a date or reminder in a block opens the sheet that edits it:
//  the day, the time, the reminder, or turning it back into text.
//
//  Desktop reference: `date-mention-popover.tsx`, `date-mention-options.ts`,
//  and `ContentArea.tsx`'s `updateDateMention` / `removeDateMention`, which
//  rewrite the node under the same `anchorId`.
//

import MemryCore
import SwiftUI

/// On a date chip's U+FFFC: the node it draws, for a tap to edit.
final class DateMentionChip: NSObject {
    let anchorId: String
    let value: DateMentionValue

    init(anchorId: String, value: DateMentionValue) {
        self.anchorId = anchorId
        self.value = value
    }

    /// The node a `dateMention` run carries. `nil` without a date to edit.
    /// A node written before anchors existed gets one minted, as desktop
    /// mints one on its next write.
    static func from(_ run: InlineRun) -> DateMentionChip? {
        let attrs = run.markAttrs
        guard let iso = attrs["dateMention.dateISO"].flatMap({ $0.isEmpty ? nil : $0 }) ?? run.target,
              !iso.isEmpty
        else { return nil }
        var value = DateMentionValue(dateISO: iso, hasTime: attrs["dateMention.hasTime"] == "true")
        value.dateFormat = attrs["dateMention.dateFormat"].flatMap { $0.isEmpty ? nil : $0 } ?? "relative"
        let remind = attrs["dateMention.remind"] ?? "none"
        // The legacy boolean `false` and an empty value both mean no reminder.
        value.remind = ["", "false"].contains(remind) ? "none" : remind
        value.timeFormat = attrs["dateMention.timeFormat"].flatMap { $0.isEmpty ? nil : $0 } ?? "system"
        let anchor = attrs["dateMention.anchorId"].flatMap { $0.isEmpty ? nil : $0 }
            ?? DateMentionValue.mintAnchorId()
        return DateMentionChip(anchorId: anchor, value: value)
    }
}

/// A date chip whose sheet is open.
struct DateMentionEditRequest: Identifiable, Equatable {
    let blockId: String
    let anchorId: String
    let value: DateMentionValue
    var id: String { anchorId }
}

/// What the sheet asks the session to do with the chip.
enum DateMentionEdit: Equatable {
    /// Rewrite the node with these props, same anchor.
    case update(DateMentionValue)
    /// Replace the node with the words it shows, as plain text.
    case convertToText
    /// Remove the node (desktop's Clear).
    case remove
}

/// Desktop's Remind choices, which depend on whether the date has a time.
enum DateMentionRemind {
    static func options(hasTime: Bool) -> [(value: String, label: String)] {
        guard hasTime else {
            return [
                ("none", "None"),
                ("at", "On day of event (09:00)"),
                ("1d", "1 day before (09:00)"),
                ("2d", "2 days before (09:00)"),
                ("1w", "1 week before (09:00)"),
            ]
        }
        return [
            ("none", "None"),
            ("at", "At time of event"),
            ("5m", "5 minutes before"),
            ("10m", "10 minutes before"),
            ("15m", "15 minutes before"),
            ("30m", "30 minutes before"),
            ("1h", "1 hour before"),
            ("2h", "2 hours before"),
            ("1d", "1 day before (09:00)"),
            ("2d", "2 days before (09:00)"),
            ("1w", "1 week before (09:00)"),
        ]
    }

    /// Desktop's `handleToggleTime`: a reminder the new list lacks falls back
    /// to `at`.
    static func afterToggle(_ remind: String, hasTime: Bool) -> String {
        options(hasTime: hasTime).contains { $0.value == remind } ? remind : "at"
    }

    /// The text a converted chip leaves behind: an absolute date, because a
    /// relative word ("Tomorrow") stops being true once it is plain text.
    static func plainText(_ value: DateMentionValue) -> String {
        let run = InlineRun(
            text: "", marks: ["dateMention"],
            markAttrs: [
                "dateMention.dateISO": value.dateISO,
                "dateMention.hasTime": value.hasTime ? "true" : "false",
                "dateMention.dateFormat": "full",
            ],
            target: nil
        )
        return NoteInlineLabel.dateMention(run, now: .now)
    }
}

/// The sheet a tapped date chip opens.
struct DateMentionEditSheet: View {
    let apply: (DateMentionEdit) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var value: DateMentionValue
    @State private var date: Date

    init(value: DateMentionValue, apply: @escaping (DateMentionEdit) -> Void) {
        self.apply = apply
        _value = State(initialValue: value)
        _date = State(initialValue: Self.parse(value.dateISO) ?? .now)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    Toggle("Include time", isOn: Binding(
                        get: { value.hasTime },
                        set: { hasTime in
                            value.hasTime = hasTime
                            value.remind = DateMentionRemind.afterToggle(value.remind, hasTime: hasTime)
                        }
                    ))
                    if value.hasTime {
                        DatePicker("Time", selection: $date, displayedComponents: .hourAndMinute)
                    }
                }
                Section {
                    Picker("Remind", selection: $value.remind) {
                        ForEach(DateMentionRemind.options(hasTime: value.hasTime), id: \.value) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                }
                Section {
                    Button("Convert to text") { finish(.convertToText) }
                    Button("Remove", role: .destructive) { finish(.remove) }
                }
            }
            .navigationTitle(value.remind == "none" ? "Date" : "Reminder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        var next = value
                        next.dateISO = DateMentionValue.iso(date)
                        finish(.update(next))
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func finish(_ edit: DateMentionEdit) {
        apply(edit)
        dismiss()
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}
