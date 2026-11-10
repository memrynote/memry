import MemryCore
import SwiftUI

// One rule of the advanced filter: field and operator menus, then the value
// editor for the field (desktop's `rule-row.tsx` and `rule-value.tsx`). A rule
// from a newer build reads as such and can only be removed; a location rule
// shows its places, since iOS has no location picker yet.

struct TaskFilterRuleRow: View {
    let store: TasksStore
    let rule: TaskFilterNode
    let path: [Int]

    @State private var title = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if rule.isKnownRule {
                HStack(spacing: Tokens.Space.small) {
                    fieldMenu
                    opMenu
                    Spacer(minLength: 0)
                    removeButton
                }
                if !TaskFilterRuleVocabulary.isValueless(rule.op) { valueEditor }
            } else {
                HStack {
                    Text(TasksCopy.rulesUnknown).foregroundStyle(Tokens.Text.secondary.color)
                    Spacer(minLength: 0)
                    removeButton
                }
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.rules.rule")
    }

    // MARK: Field and operator

    /// Location is left out: iOS cannot pick folders or notes yet.
    private var offeredFields: [String] {
        TaskFilterRuleVocabulary.fields.filter { $0 != "location" || rule.field == "location" }
    }

    private var fieldMenu: some View {
        Menu {
            ForEach(offeredFields, id: \.self) { field in
                checkButton(TasksCopy.ruleFieldLabel(field), isOn: field == rule.field) {
                    guard field != rule.field else { return }
                    edit { _ in .rule(field) }
                }
            }
        } label: {
            menuLabel(TasksCopy.ruleFieldLabel(rule.field), weight: .medium, tint: false)
        }
        .accessibilityIdentifier("tasks.rules.field")
    }

    private var opMenu: some View {
        Menu {
            ForEach(TaskFilterRuleVocabulary.ops[rule.field] ?? [], id: \.self) { op in
                checkButton(TasksCopy.ruleOpLabel(field: rule.field, op: op), isOn: op == rule.op) {
                    edit { node in
                        var copy = node
                        copy.op = op
                        if TaskFilterRuleVocabulary.isValueless(op) { copy.values = [] }
                        return copy
                    }
                }
            }
        } label: {
            menuLabel(
                TasksCopy.ruleOpLabel(field: rule.field, op: rule.op),
                weight: TaskFilterRuleVocabulary.isNegative(rule.op) ? .semibold : .regular,
                tint: TaskFilterRuleVocabulary.isNegative(rule.op)
            )
        }
        .accessibilityIdentifier("tasks.rules.op")
    }

    // MARK: Values

    @ViewBuilder
    private var valueEditor: some View {
        switch rule.field {
        case "title":
            TextField(TasksCopy.rulesTitlePlaceholder, text: $title)
                .textInputAutocapitalization(.never)
                .onAppear { title = rule.values.first ?? "" }
                .onChange(of: title) { _, text in
                    guard text != (rule.values.first ?? "") else { return }
                    edit { node in
                        var copy = node
                        copy.values = [text]
                        return copy
                    }
                }
                .accessibilityIdentifier("tasks.rules.title")
        case "location":
            Text(TasksCopy.ruleValues(rule, projects: store.projects).joined(separator: ", "))
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHint(TasksCopy.rulesLocationReadOnly)
        default:
            valueMenu
            if rule.field == "due", rule.values.contains("custom") { dueRange }
        }
    }

    private var single: Bool { rule.field == "repeat" || rule.field == "hasTime" }

    private var options: [(value: String, label: String)] {
        switch rule.field {
        case "priority":
            TaskFilterOptions.priorities.map { ($0, TaskFilterOptions.priorityLabel($0)) }
        case "project":
            store.projects.filter { $0.archivedAt == nil }.map { ($0.id, $0.name) }
        case "status":
            store.projects.filter { $0.archivedAt == nil }.flatMap { project in
                project.statuses.map { ($0.id, "\(project.name) · \($0.name)") }
            }
        case "tags":
            store.filterTags.map { ($0.tag, "#\($0.tag)") }
        case "due":
            TaskFilterRuleVocabulary.dueValues.map {
                ($0, $0 == "custom" ? TasksCopy.filterCustomRange : TasksCopy.dueFilterLabel($0))
            }
        case "repeat":
            ["repeating", "one-time"].map { ($0, TasksCopy.repeatFilterLabel($0)) }
        case "hasTime":
            ["with-time", "without-time"].map { ($0, TasksCopy.hasTimeFilterLabel($0)) }
        default:
            []
        }
    }

    private var valueMenu: some View {
        let labels = TasksCopy.ruleValues(rule, projects: store.projects)
        return Menu {
            ForEach(options, id: \.value) { option in
                checkButton(option.label, isOn: isSelected(option.value)) { toggle(option.value) }
            }
        } label: {
            menuLabel(labels.isEmpty ? TasksCopy.rulesPick : labels.joined(separator: ", "), weight: .regular, tint: false)
                .lineLimit(2)
        }
        .menuActionDismissBehavior(single ? .automatic : .disabled)
        .accessibilityIdentifier("tasks.rules.value")
    }

    private func isSelected(_ value: String) -> Bool {
        rule.field == "tags"
            ? rule.values.contains { $0.lowercased() == value.lowercased() }
            : rule.values.contains(value)
    }

    private func toggle(_ value: String) {
        edit { node in
            var copy = node
            if single {
                copy.values = [value]
            } else if node.field == "tags" {
                copy.values = TasksStore.toggledTag(value, in: node.values)
            } else {
                copy.values = TasksStore.toggled(value, in: node.values)
            }
            return copy
        }
    }

    private var dueRange: some View {
        let start = rule.dueStart.flatMap(TaskDates.date) ?? Date()
        let end = rule.dueEnd.flatMap(TaskDates.date) ?? start
        return VStack(spacing: Tokens.Space.small) {
            DatePicker(TasksCopy.filterRangeStart, selection: dateBinding(start) { node, key in node.dueStart = key }, displayedComponents: .date)
            DatePicker(TasksCopy.filterRangeEnd, selection: dateBinding(end) { node, key in node.dueEnd = key }, displayedComponents: .date)
        }
        .onAppear {
            // A range needs both ends; seed them so the rule is not skipped.
            guard rule.dueStart == nil || rule.dueEnd == nil else { return }
            edit { node in
                var copy = node
                copy.dueStart = copy.dueStart ?? TaskDates.key(start)
                copy.dueEnd = copy.dueEnd ?? TaskDates.key(end)
                return copy
            }
        }
    }

    private func dateBinding(_ date: Date, set: @escaping (inout TaskFilterNode, String) -> Void) -> Binding<Date> {
        Binding(get: { date }, set: { next in
            edit { node in
                var copy = node
                set(&copy, TaskDates.key(next))
                return copy
            }
        })
    }

    // MARK: Pieces

    private func edit(_ change: @escaping (TaskFilterNode) -> TaskFilterNode?) {
        let path = path
        Task { await store.updateRule(at: path, change) }
    }

    private var removeButton: some View {
        Button {
            edit { _ in nil }
        } label: {
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(Tokens.Text.tertiary.color)
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(TasksCopy.rulesRemoveRule)
        .accessibilityIdentifier("tasks.rules.remove")
    }

    private func checkButton(_ title: String, isOn: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            if isOn { Label(title, systemImage: "checkmark") } else { Text(title) }
        }
    }

    private func menuLabel(_ text: String, weight: Font.Weight, tint: Bool) -> some View {
        HStack(spacing: Tokens.Space.tight) {
            Text(text).fontWeight(weight).multilineTextAlignment(.leading)
            Image(systemName: "chevron.up.chevron.down")
                .font(Tokens.Typography.caption.font)
                .accessibilityHidden(true)
        }
        .foregroundStyle(tint ? Tokens.Text.tint.color : Tokens.Text.primary.color)
        .padding(.horizontal, Tokens.Space.small)
        .frame(minHeight: Tokens.Size.pill)
        .background(Tokens.Canvas.surfaceActive.color, in: .rect(cornerRadius: Tokens.Radius.small))
    }
}
