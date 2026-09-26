import MemryCore
import SwiftUI

// Spec 007 CL052/CL053/CL045 (artboards 18, 20, 21). The small sheets: a
// note or date reminder (Open note), a snoozed inbox item (Open in Inbox,
// Unsnooze now, Reschedule through the Inbox snooze menu), a reminder, the
// promote alert and Go to date.

/// Paper 20 / 21: a kind line with the close button beside it, the title,
/// one line of detail, the actions, a footnote.
struct CalendarSmallSheetFrame<Actions: View>: View {
    let item: CalendarItem
    let kind: String
    var detail: String?
    var footnote: String?
    @ViewBuilder let actions: () -> Actions
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            HStack(spacing: Tokens.Space.small) {
                if item.visualType == "note_date" {
                    Circle().strokeBorder(CalendarItemStyle.hue(item).rail.color, style: StrokeStyle(lineWidth: 1, dash: [2, 1.5]))
                        .frame(width: 8, height: 8)
                } else {
                    Circle().fill(CalendarItemStyle.hue(item).rail.color).frame(width: 7, height: 7)
                }
                Text(kind)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .foregroundStyle(Tokens.Text.primary.color)
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel(CalendarCopy.close)
            }
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(item.title)
                    .font(Tokens.Typography.sectionTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityAddTraits(.isHeader)
                if let detail {
                    Text(detail)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .lineLimit(3)
                }
            }
            actions()
            if let footnote {
                Text(footnote)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Space.inset + Tokens.Space.tight)
        .padding(.top, Tokens.Space.inset)
    }
}

/// Artboard 20.
struct CalendarNoteSheet: View {
    @Bindable var store: CalendarStore
    let item: CalendarItem
    @Environment(\.dismiss) private var dismiss
    @Environment(TasksRouter.self) private var router

    var body: some View {
        let isDateReminder = item.visualType == "note_date"
        CalendarSmallSheetFrame(
            item: item,
            kind: isDateReminder ? CalendarCopy.dateReminderKind : CalendarCopy.noteKind,
            detail: [item.descriptionPreview, CalendarSheetText.when(item)].compactMap { $0 }.joined(separator: " · "),
            footnote: CalendarCopy.noteFootnote
        ) {
            Button {
                // The note, opened on the More stack (Notes has no anchor
                // route; §6 CL052).
                router.settingsPath.append(NoteRoute(id: item.noteId ?? item.sourceId))
                dismiss()
            } label: {
                Text(CalendarCopy.openNote)
                    .font(Tokens.Typography.body.font.weight(.semibold))
                    .foregroundStyle(Tokens.Tint.foreground.color)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea)
            }
            .buttonStyle(.glassProminent)
            .tint(Tokens.Tint.base.color)
            .accessibilityIdentifier("calendar.note.open")
        }
        .presentationDetents([.fraction(0.4), .medium])
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
        CalendarSmallSheetFrame(
            item: item,
            kind: "\(CalendarCopy.snoozeKind) · \(CalendarCopy.backAt(CalendarItemStyle.time(item.startDate)))",
            detail: item.descriptionPreview,
            footnote: CalendarCopy.snoozeFootnote
        ) {
            VStack(spacing: 0) {
                row(CalendarCopy.openInInbox, systemImage: "tray") {
                    dismiss()
                    inboxRouter.openItem(item.sourceId, in: router)
                }
                .accessibilityIdentifier("calendar.snooze.open")
                Divider().padding(.leading, Tokens.Space.inset * 2 + Tokens.Space.small)
                row(CalendarCopy.unsnoozeNow, systemImage: "bell") {
                    Task { await inbox?.unsnooze(item.sourceId); await store.refreshAllWindows(); dismiss() }
                }
                .disabled(inbox == nil)
                .accessibilityIdentifier("calendar.snooze.unsnooze")
                Divider().padding(.leading, Tokens.Space.inset * 2 + Tokens.Space.small)
                Menu {
                    InboxSnoozeMenuItems(now: store.clock(), snooze: { date in
                        Task { await inbox?.snooze([item.sourceId], until: date); await store.refreshAllWindows(); dismiss() }
                    }, pickDate: { picking = true })
                } label: {
                    rowLabel(CalendarCopy.reschedule, systemImage: "clock", trailing: Image(systemName: "chevron.up.chevron.down"))
                }
                .disabled(inbox == nil)
                .accessibilityIdentifier("calendar.snooze.reschedule")
            }
            .background(Tokens.Canvas.surface.color, in: RoundedRectangle(cornerRadius: Tokens.Radius.container))
        }
        .sheet(isPresented: $picking) {
            InboxSnoozeDateSheet(now: store.clock()) { date in
                Task { await inbox?.snooze([item.sourceId], until: date); await store.refreshAllWindows(); dismiss() }
            }
        }
        .presentationDetents([.fraction(0.5), .medium])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.sheet.snooze")
    }

    private func row(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { rowLabel(title, systemImage: systemImage, trailing: nil as Image?) }
            .buttonStyle(.plain)
    }

    private func rowLabel(_ title: String, systemImage: String, trailing: Image?) -> some View {
        HStack(spacing: Tokens.Space.medium) {
            Image(systemName: systemImage)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(width: Tokens.Space.inset)
            Text(title).foregroundStyle(Tokens.Text.primary.color)
            Spacer()
            trailing?.foregroundStyle(Tokens.Text.tertiary.color)
        }
        .padding(.horizontal, Tokens.Space.inset)
        .frame(minHeight: Tokens.Size.minimumHitArea + 4)
        .contentShape(.rect)
    }
}

/// A reminder (desktop opens none; 00 rule 2 gives every item a sheet).
struct CalendarReminderSheet: View {
    @Bindable var store: CalendarStore
    let item: CalendarItem

    var body: some View {
        CalendarSmallSheetFrame(
            item: item,
            kind: [CalendarCopy.reminderKind, item.source.title].filter { !$0.isEmpty }.joined(separator: " · "),
            detail: [CalendarSheetText.when(item), item.descriptionPreview].compactMap { $0 }.joined(separator: " · ")
        ) { EmptyView() }
            .presentationDetents([.fraction(0.3)])
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
                        CalendarCloseButton { dismiss() }
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
