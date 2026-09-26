import MemryCore
import SwiftUI

// Spec 007 CL052/CL053/CL045 (artboards 18, 20, 21). The small sheets: a
// note or date reminder (Open note), a snoozed inbox item (Open in Inbox,
// Unsnooze now, Reschedule through the Inbox snooze menu), a reminder, the
// promote alert and Go to date.

/// Artboard 20.
struct CalendarNoteSheet: View {
    @Bindable var store: CalendarStore
    let item: CalendarItem
    @Environment(\.dismiss) private var dismiss
    @Environment(TasksRouter.self) private var router

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                CalendarSheetHeader(item: item, kind: item.visualType == "note_date" ? CalendarCopy.dateReminderKind : CalendarCopy.noteKind)
                if let preview = item.descriptionPreview {
                    Text(preview)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                Button {
                    // The note, opened on the More stack (Notes has no anchor
                    // route; §6 CL052).
                    router.settingsPath.append(NoteRoute(id: item.noteId ?? item.sourceId))
                    dismiss()
                } label: {
                    Label(CalendarCopy.openNote, systemImage: "doc.text").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .tint(Tokens.Tint.base.color)
                .foregroundStyle(Tokens.Tint.foreground.color)
                .accessibilityIdentifier("calendar.note.open")
                Spacer()
            }
            .padding(Tokens.Space.inset)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(CalendarCopy.close)
                }
            }
        }
        .presentationDetents([.fraction(0.35), .medium])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.sheet.note")
    }
}

/// Artboard 21.
struct CalendarSnoozeSheet: View {
    @Bindable var store: CalendarStore
    let item: CalendarItem
    @State private var picking = false
    @Environment(\.dismiss) private var dismiss
    @Environment(TasksRouter.self) private var router
    @Environment(InboxRouter.self) private var inboxRouter
    @Environment(\.inboxStore) private var inbox

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                CalendarSheetHeader(item: item, kind: CalendarCopy.snoozeKind)
                Text(CalendarCopy.backAt(CalendarItemStyle.time(item.startDate)))
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                Button {
                    dismiss()
                    inboxRouter.openItem(item.sourceId, in: router)
                } label: {
                    Label(CalendarCopy.openInInbox, systemImage: "tray").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .tint(Tokens.Tint.base.color)
                .foregroundStyle(Tokens.Tint.foreground.color)
                HStack {
                    Button(CalendarCopy.unsnoozeNow) {
                        Task { await inbox?.unsnooze(item.sourceId); await store.refreshAllWindows(); dismiss() }
                    }
                    .buttonStyle(.bordered)
                    Menu {
                        InboxSnoozeMenuItems(now: store.clock(), snooze: { date in
                            Task { await inbox?.snooze([item.sourceId], until: date); await store.refreshAllWindows(); dismiss() }
                        }, pickDate: { picking = true })
                    } label: {
                        Text(CalendarCopy.reschedule)
                    }
                    .buttonStyle(.bordered)
                }
                .disabled(inbox == nil)
                Spacer()
            }
            .padding(Tokens.Space.inset)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(CalendarCopy.close)
                }
            }
            .sheet(isPresented: $picking) {
                InboxSnoozeDateSheet(now: store.clock()) { date in
                    Task { await inbox?.snooze([item.sourceId], until: date); await store.refreshAllWindows(); dismiss() }
                }
            }
        }
        .presentationDetents([.fraction(0.35), .medium])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.sheet.snooze")
    }
}

/// A reminder (desktop opens none; 00 rule 2 gives every item a sheet).
struct CalendarReminderSheet: View {
    @Bindable var store: CalendarStore
    let item: CalendarItem
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                CalendarSheetHeader(item: item, kind: CalendarCopy.reminderKind)
                if let preview = item.descriptionPreview {
                    Text(preview).font(Tokens.Typography.supporting.font).foregroundStyle(Tokens.Text.secondary.color)
                }
                Spacer()
            }
            .padding(Tokens.Space.inset)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(CalendarCopy.close)
                }
            }
        }
        .presentationDetents([.fraction(0.35)])
    }
}

/// Artboard 18: "Edit this event in memrynote?", with the AI notice while the
/// provider's AI read consent is off, and Don't ask again.
struct CalendarPromoteAlert: ViewModifier {
    @Bindable var store: CalendarStore
    @Binding var item: CalendarItem?
    let opened: (String) -> Void
    @State private var agentAccessOff = false
    @State private var dontAsk = false

    func body(content: Content) -> some View {
        content
            .sheet(item: $item) { target in
                NavigationStack {
                    Form {
                        Section {
                            Text(CalendarCopy.promoteBody)
                            if agentAccessOff {
                                Text(CalendarCopy.promoteAgentNotice)
                                    .font(Tokens.Typography.caption.font)
                                    .foregroundStyle(Tokens.Text.secondary.color)
                            }
                            Toggle(CalendarCopy.promoteDontAsk, isOn: $dontAsk)
                                .accessibilityIdentifier("calendar.promote.dontAsk")
                        }
                        Section {
                            Button(CalendarCopy.promoteConfirm) {
                                Task {
                                    let id = await store.promote(target, dontAskAgain: dontAsk)
                                    item = nil
                                    if let id { opened(id) } else { store.fail(ErrorMapping.userFacing(CalendarPromoteFailure())) }
                                }
                            }
                            .accessibilityIdentifier("calendar.promote.confirm")
                            Button(CalendarCopy.cancel, role: .cancel) { item = nil }
                        }
                    }
                    .navigationTitle(CalendarCopy.promoteTitle)
                    .navigationBarTitleDisplayMode(.inline)
                }
                .presentationDetents([.medium])
                .task { agentAccessOff = await store.isAgentAccessOff(target) }
            }
    }
}

struct CalendarPromoteFailure: Error {}

extension View {
    func calendarPromoteAlert(store: CalendarStore, item: Binding<CalendarItem?>, opened: @escaping (String) -> Void) -> some View {
        modifier(CalendarPromoteAlert(store: store, item: item, opened: opened))
    }
}

/// Title menu › Go to date… (a graphical date picker).
struct CalendarGoToDateSheet: View {
    let initial: String
    let pick: (String) -> Void
    @State private var date = Date()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            DatePicker(CalendarCopy.goToDate, selection: $date, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .padding(Tokens.Space.inset)
                .navigationTitle(CalendarCopy.goToDate)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(CalendarCopy.close)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        SheetConfirmButton(label: CalendarCopy.goToDate) { pick(CalendarDates.key(date)) }
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .onAppear { date = CalendarDates.start(of: initial) }
    }
}
