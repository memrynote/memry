import MemryCore
import SwiftUI

// Spec 007 CL040 (artboard 12). Quick create: after a long press + drag on the
// grid (or across Month days), a composer rises above the keyboard with the
// title, the range chip, the calendar chip and More…, which opens the full
// sheet (13). Send creates the event; a save error keeps the composer open with
// the message (desktop `calendar-quick-create-dialog.tsx`).

struct CalendarComposerRequest: Identifiable, Equatable {
    let id = UUID()
    let day: String
    let startMinute: Int
    let endMinute: Int
    let isAllDay: Bool
    var lastDay: String?

    var editor: CalendarEditorRequest {
        CalendarEditorRequest.new(day: day, startMinute: startMinute, endMinute: endMinute, allDay: isAllDay, lastDay: lastDay)
    }
}

struct CalendarComposer: View {
    @Bindable var store: CalendarStore
    let request: CalendarComposerRequest
    let close: () -> Void
    let more: (CalendarEditorRequest) -> Void
    @State private var title = ""
    @State private var target: String?
    @State private var error: String?
    @State private var saving = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack(spacing: Tokens.Space.small) {
                TextField(CalendarCopy.titlePlaceholder, text: $title)
                    .font(Tokens.Typography.body.font)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit { Task { await send() } }
                    .accessibilityIdentifier("calendar.composer.title")
                Button { Task { await send() } } label: {
                    Image(systemName: "arrow.up")
                        .fontWeight(.semibold)
                        .foregroundStyle(Tokens.Tint.foreground.color)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .tint(Tokens.Tint.base.color)
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                .accessibilityLabel(CalendarCopy.createEvent)
                .accessibilityIdentifier("calendar.composer.send")
            }
            if let error {
                Text(error)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Interaction.destructive.color)
            }
            ScrollView(.horizontal) {
                HStack(spacing: Tokens.Space.small) {
                    chip(systemImage: "clock", text: rangeText)
                    Menu {
                        Picker(CalendarCopy.calendar, selection: $target) {
                            Text(CalendarCopy.memryCalendarDefault).tag(String?.none)
                            ForEach(store.sources.filter { $0.kind == "calendar" && ($0.provider == "google" || $0.provider == "caldav") }, id: \.id) {
                                Text($0.title).tag(Optional($0.remoteId))
                            }
                        }
                    } label: {
                        chip(systemImage: nil, text: targetTitle)
                    }
                    .accessibilityIdentifier("calendar.composer.calendar")
                    Button {
                        var draft = request.editor
                        draft.title = title
                        draft.targetCalendarId = target
                        more(draft)
                    } label: {
                        chip(systemImage: nil, text: CalendarCopy.more)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("calendar.composer.more")
                }
            }
            .scrollIndicators(.hidden)
        }
        .padding(Tokens.Space.medium)
        .chromeGlass(in: RoundedRectangle(cornerRadius: Tokens.Radius.container))
        .padding(.horizontal, Tokens.Space.small)
        .padding(.bottom, Tokens.Space.small)
        .onAppear { focused = true }
        .onChange(of: focused) { _, now in if !now, title.isEmpty, !saving { close() } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.composer")
    }

    /// Paper 12: the range chip carries a clock, the others are words.
    private func chip(systemImage: String?, text: String) -> some View {
        HStack(spacing: Tokens.Space.tight + 2) {
            if let systemImage { Image(systemName: systemImage) }
            Text(text)
        }
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.pill)
            .background(Tokens.Canvas.surface.color, in: .capsule)
            .frame(minHeight: Tokens.Size.minimumHitArea)
    }

    private var rangeText: String {
        let day = CalendarDates.start(of: request.day).formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        if request.isAllDay {
            guard let last = request.lastDay, last != request.day else { return "\(day) · \(CalendarCopy.allDay)" }
            let lastText = CalendarDates.start(of: last).formatted(.dateTime.month(.abbreviated).day())
            return "\(day) – \(lastText)"
        }
        // "Thu 14:15 – 15:15": the week strip above already shows the date.
        let weekday = CalendarDates.start(of: request.day).formatted(.dateTime.weekday(.abbreviated))
        return "\(weekday) \(CalendarSelectionBlock.clock(request.startMinute)) – \(CalendarSelectionBlock.clock(request.endMinute))"
    }

    private var targetTitle: String {
        target.flatMap { id in store.sources.first { $0.remoteId == id }?.title } ?? CalendarCopy.memryCalendarShort
    }

    private func send() async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !saving else { return }
        saving = true
        defer { saving = false }
        let editor = request.editor
        let draft = CalendarEventDraft(
            title: trimmed, description: nil, location: nil, startAt: editor.startIso, endAt: editor.endIso,
            timezone: TimeZone.current.identifier, isAllDay: request.isAllDay, targetCalendarId: target, color: nil
        )
        if await store.write({ try $0.createEvent(draft: draft) }) != nil {
            close()
        } else {
            error = CalendarCopy.couldNotCreate
            store.clearFailure()
        }
    }
}

extension CalendarCopy {
    static let memryCalendarShort = "memrynote"
}
