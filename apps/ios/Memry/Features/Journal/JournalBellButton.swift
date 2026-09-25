import MemryCore
import SwiftUI

// JP046 (J07, J08). The Day page's reminder bell, after desktop's
// `journal-reminder-button.tsx`.
//
// With no active reminder the bell is a menu: desktop's four journal presets
// with their resolved local date and time, and "Pick date & time…" (a sheet
// with a date, a time and an optional note). With an active reminder the
// bell is filled, carries a count when the day has several, and opens the
// J08 sheet, where the day's reminders are managed and a new time moves the
// next one (D8).

struct JournalBellButton: View {
    let store: JournalStore
    let date: String

    @Environment(\.journalTasks) private var tasks
    @State private var sheet: JournalBellSheet?

    private var active: [JournalReminder] { store.activeReminders(date) }

    var body: some View {
        Group {
            if active.isEmpty {
                presetMenu
            } else {
                Button {
                    sheet = .manage
                } label: {
                    bell
                }
                .accessibilityLabel(activeLabel)
                .accessibilityIdentifier("journal.reminder.bell")
            }
        }
        .task(id: date) { await store.loadReminders(date) }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .pick:
                JournalReminderPickSheet(
                    title: JournalCopy.remindMe,
                    initial: JournalReminderPresets.inDays(1, from: store.clock.instant()),
                    initialNote: "",
                    now: store.clock.instant()
                ) { instant, note in
                    self.sheet = nil
                    Task { await store.setReminder(on: date, at: instant, note: note, tasks: tasks) }
                }
            case .manage:
                JournalReminderSheet(store: store, date: date, tasks: tasks)
            }
        }
    }

    private var presetMenu: some View {
        let now = store.clock.instant()
        return Menu {
            Section(JournalCopy.reminderMenuTitle) {
                ForEach(JournalReminderPresets.all(now: now)) { preset in
                    Button {
                        choose(preset.id)
                    } label: {
                        Text(preset.label)
                        Text(JournalReminderPresets.text(preset.date, now: now))
                    }
                    .accessibilityIdentifier("journal.reminder.preset.\(preset.id)")
                }
            }
            Button(JournalCopy.pickDateAndTime, systemImage: "calendar") { sheet = .pick }
                .accessibilityIdentifier("journal.reminder.pickDateTime")
        } label: {
            bell
        }
        .accessibilityLabel(JournalCopy.setToRevisit)
        .accessibilityIdentifier("journal.reminder.bell")
    }

    private var bell: some View {
        Image(systemName: active.isEmpty ? "bell" : "bell.fill")
            .font(Tokens.Typography.body.font)
            .foregroundStyle(active.isEmpty ? Tokens.Text.secondary.color : Tokens.Text.tint.color)
            .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
            .overlay(alignment: .topTrailing) {
                if active.count > 1 {
                    Text(active.count > 9 ? "9+" : "\(active.count)")
                        .font(Tokens.Typography.caption.font)
                        .monospacedDigit()
                        .foregroundStyle(Tokens.Tint.foreground.color)
                        .padding(.horizontal, Tokens.Space.tight)
                        .background(Capsule().fill(Tokens.Tint.base.color))
                        .accessibilityHidden(true)
                }
            }
            .contentShape(.rect)
    }

    /// Desktop's tooltip: the next reminder, and how many more there are.
    private var activeLabel: String {
        guard let next = active.first, let fire = JournalReminderPresets.fireDate(next) else {
            return JournalCopy.hasReminders
        }
        let when = JournalReminderPresets.text(fire, now: store.clock.instant())
        return active.count > 1
            ? JournalCopy.reminderTooltipMore(when, more: active.count - 1)
            : JournalCopy.reminderTooltip(when)
    }

    /// Resolves the preset at tap time, so a menu left open past midnight
    /// still counts from now.
    private func choose(_ presetId: String) {
        let now = store.clock.instant()
        guard let preset = JournalReminderPresets.all(now: now).first(where: { $0.id == presetId }) else { return }
        Task { await store.setReminder(on: date, at: preset.date, note: nil, tasks: tasks) }
    }
}

private enum JournalBellSheet: String, Identifiable {
    case pick, manage
    var id: String { rawValue }
}
