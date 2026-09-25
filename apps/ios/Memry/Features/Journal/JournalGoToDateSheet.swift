import SwiftUI

// JP042. Go to date… (Paper J04): a graphical calendar in a sheet with the
// xmark / checkmark chrome of the Tasks date sheet. The checkmark opens the
// picked day in place of the shown one; the xmark leaves everything as it
// was. Picking a day reads it, it does not create it (D2).

struct JournalGoToDateSheet: View {
    let today: String
    let onPick: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: String

    init(date: String, today: String, onPick: @escaping (String) -> Void) {
        self.today = today
        self.onPick = onPick
        _draft = State(initialValue: JournalDates.date(date) == nil ? today : date)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker(
                        JournalCopy.goToDatePicker,
                        selection: Binding(
                            get: { JournalDates.date(draft) ?? Date() },
                            set: { draft = JournalDates.key($0) }
                        ),
                        displayedComponents: .date
                    )
                    .datePickerStyle(.graphical)
                    .labelsHidden()
                    .tint(Tokens.Text.tint.color)
                    .environment(\.calendar, JournalDates.calendar)
                    .accessibilityIdentifier("journal.goToDate.calendar")
                    Button(JournalCopy.today) { draft = today }
                        .buttonStyle(.borderless)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .accessibilityIdentifier("journal.goToDate.today")
                }
            }
            .navigationTitle(JournalCopy.goToDateTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityLabel(JournalCopy.goToDateCancel)
                        .accessibilityIdentifier("journal.goToDate.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetConfirmButton(label: JournalCopy.goToDateConfirm) {
                        onPick(draft)
                        dismiss()
                    }
                    .accessibilityIdentifier("journal.goToDate.confirm")
                }
            }
        }
    }
}
