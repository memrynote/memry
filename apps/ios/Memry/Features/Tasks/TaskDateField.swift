import MemryCore
import SwiftUI

// TP044. The date sheet's natural-language field (`natural-date-input.tsx`)
// and its suggestion rows (`due-date-picker.tsx` quick options). The field
// asks the core on every keystroke: the resolved date reads live under it,
// and the core's completion shows as ghost text after the caret.

/// Type "next friday", see "Friday, January 16, 2026", select it.
struct TaskDateNaturalField: View {
    let store: TasksStore
    let onSelect: (ParsedDate) -> Void

    @State private var query = ""

    private var reading: TaskDateReading { store.dateReading(query) }
    private var ghost: String? { store.dateGhost(query) }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack(spacing: Tokens.Space.small) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityHidden(true)
                ZStack(alignment: .leading) {
                    if let ghost {
                        HStack(spacing: 0) {
                            Text(query).hidden()
                            Text(ghost).foregroundStyle(Tokens.Text.tertiary.color)
                        }
                        .lineLimit(1)
                        .accessibilityHidden(true)
                    }
                    TextField(TasksCopy.naturalDatePlaceholder, text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(submit)
                        .accessibilityLabel(TasksCopy.naturalDateLabel)
                        .accessibilityIdentifier("tasks.date.natural")
                }
                .font(Tokens.Typography.body.font)
                if let ghost {
                    Button {
                        query += ghost
                    } label: {
                        Image(systemName: "arrow.forward.to.line")
                            .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .accessibilityLabel(TasksCopy.acceptDateCompletion(query + ghost))
                    .accessibilityIdentifier("tasks.date.acceptGhost")
                }
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            readingRow
        }
    }

    @ViewBuilder
    private var readingRow: some View {
        switch reading {
        case let .resolved(parsed):
            HStack(spacing: Tokens.Space.small) {
                Image(systemName: "checkmark").accessibilityHidden(true)
                Text(parsed.displayText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("tasks.date.naturalResult")
                Button(TasksCopy.naturalDateSelect) { select(parsed) }
                    .buttonStyle(.borderless)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityIdentifier("tasks.date.naturalSelect")
            }
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Task.complete.color)
        case .notUnderstood:
            Label(TasksCopy.naturalDateNotUnderstood, systemImage: "exclamationmark.circle")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Task.dueToday.color)
                .accessibilityIdentifier("tasks.date.naturalError")
        case .empty, .typing:
            EmptyView()
        }
    }

    /// Return selects a date that reads; otherwise it takes the ghost.
    private func submit() {
        if case let .resolved(parsed) = reading {
            select(parsed)
        } else if let ghost {
            query += ghost
        }
    }

    private func select(_ parsed: ParsedDate) {
        query = ""
        onSelect(parsed)
    }
}

/// A quick date: symbol, name, and the day it lands on.
struct TaskDateSuggestionRow: View {
    let suggestion: TaskDateSuggestion
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Tokens.Space.medium) {
                Image(systemName: symbol)
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                Text(TasksCopy.suggestionLabel(suggestion.kind))
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer(minLength: Tokens.Space.small)
                Text(TasksCopy.weekdayDate(suggestion.date))
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                if isSelected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Tokens.Text.primary.color)
                        .accessibilityHidden(true)
                }
            }
            .font(Tokens.Typography.body.font)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(TasksCopy.suggestionLabel(suggestion.kind)), \(TasksCopy.weekdayDate(suggestion.date))")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("tasks.date.suggestion.\(suggestion.kind.rawValue)")
    }

    private var symbol: String {
        switch suggestion.kind {
        case .today: "star"
        case .tomorrow, .nextWeek: "calendar"
        case .weekend: "sun.max"
        }
    }

    private var tint: Color {
        switch suggestion.kind {
        case .today: Tokens.Task.star.color
        case .tomorrow: Tokens.Task.dueTomorrow.color
        case .weekend: Tokens.Task.dueToday.color
        case .nextWeek: Tokens.Task.dueUpcoming.color
        }
    }
}
