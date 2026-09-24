import SwiftUI

// TP042. The quick-add syntax, as desktop's `quick-add-help.tsx` lists it,
// updated to the grammar the core parses today (D1: `@` before a date).

/// The quick-add shortcuts help.
struct QuickAddHelpSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(TasksCopy.quickAddHelpRows, id: \.syntax) { row in
                        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.medium) {
                            Text(row.syntax)
                                .font(Tokens.Typography.technicalCaption.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                                .padding(.horizontal, Tokens.Space.tight)
                                .background(
                                    Tokens.Canvas.surfaceActive.color,
                                    in: .rect(cornerRadius: Tokens.Radius.small)
                                )
                            Text(row.meaning)
                                .font(Tokens.Typography.supporting.font)
                                .foregroundStyle(Tokens.Text.secondary.color)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: Tokens.Space.small) {
                        Text(TasksCopy.quickAddHelpExample)
                        Text(TasksCopy.quickAddHelpAccept)
                    }
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            .navigationTitle(TasksCopy.quickAddHelpTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityIdentifier("tasks.quickAdd.helpDone")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("tasks.quickAdd.helpSheet")
    }
}
