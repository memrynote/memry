import MemryCore
import SwiftUI

// The advanced filter (desktop's rule builder, `rule-builder.tsx`), pushed
// from the filter sheet. Match all / any / none at the top, one section per
// top-level rule or group, and Add rule / Add group below. Groups are offered
// one level deep, as on desktop; a deeper tree from another device still
// renders. Every edit writes the store's filters at once, so the list behind
// the sheet and the count in the header are always the answer.

struct TaskFilterRulesView: View {
    let store: TasksStore

    private var root: TaskFilterNode { store.rules }

    var body: some View {
        Form {
            Section {
                MatchRow(match: root.match) { match in
                    Task { await store.editRules { root in
                        var copy = root
                        copy.match = match
                        return copy
                    } }
                }
            } footer: {
                Text(countLine)
                    .monospacedDigit()
                    .accessibilityIdentifier("tasks.rules.count")
            }

            if root.rules.isEmpty {
                Section { Text(TasksCopy.rulesEmpty).foregroundStyle(Tokens.Text.secondary.color) }
            }

            ForEach(Array(root.rules.enumerated()), id: \.offset) { index, node in
                if node.isGroup {
                    groupSection(node, path: [index])
                } else {
                    Section { TaskFilterRuleRow(store: store, rule: node, path: [index]) }
                }
            }

            Section {
                Button {
                    Task { await store.appendRule(.rule("priority"), toGroupAt: []) }
                } label: {
                    Label(TasksCopy.rulesAddRule, systemImage: "plus")
                }
                .accessibilityIdentifier("tasks.rules.addRule")
                Button {
                    Task { await store.appendRule(.group("any", [.rule("priority")]), toGroupAt: []) }
                } label: {
                    Label(TasksCopy.rulesAddGroup, systemImage: "plus.square.on.square")
                }
                .accessibilityIdentifier("tasks.rules.addGroup")
            }

            if store.state.filters.expression != nil {
                Section {
                    Button(TasksCopy.rulesClear, role: .destructive) {
                        Task { await store.clearRules() }
                    }
                    .accessibilityIdentifier("tasks.rules.clear")
                }
            }
        }
        .font(Tokens.Typography.body.font)
        .navigationTitle(TasksCopy.rulesTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.beginRuleEditing() }
        .accessibilityIdentifier("tasks.rules.page")
    }

    private var countLine: String {
        let matches = TasksCopy.rulesMatchCount(Int(store.result?.filteredCount ?? 0))
        let skipped = leafCount(root) - store.ruleCount
        guard store.state.filters.expression != nil, skipped > 0 else { return matches }
        return "\(matches) · \(TasksCopy.rulesSkipped(skipped))"
    }

    private func leafCount(_ group: TaskFilterNode) -> Int {
        group.rules.reduce(0) { $0 + ($1.isGroup ? leafCount($1) : 1) }
    }

    @ViewBuilder
    private func groupSection(_ group: TaskFilterNode, path: [Int]) -> some View {
        Section {
            ForEach(Array(group.rules.enumerated()), id: \.offset) { index, node in
                if node.isGroup {
                    // Deeper than the builder offers: shown as its sentence, kept as is.
                    HStack {
                        Text(TasksCopy.rulesSummary(.group("all", [node]), projects: store.projects))
                            .foregroundStyle(Tokens.Text.secondary.color)
                        Spacer()
                        removeButton(TasksCopy.rulesRemoveGroup) { await store.updateRule(at: path + [index]) { _ in nil } }
                    }
                } else {
                    TaskFilterRuleRow(store: store, rule: node, path: path + [index])
                }
            }
            Button {
                Task { await store.appendRule(.rule("priority"), toGroupAt: path) }
            } label: {
                Label(TasksCopy.rulesAddRule, systemImage: "plus")
            }
        } header: {
            HStack(spacing: Tokens.Space.small) {
                MatchRow(match: group.match) { match in
                    Task { await store.updateRule(at: path) { node in
                        var copy = node
                        copy.match = match
                        return copy
                    } }
                }
                removeButton(TasksCopy.rulesRemoveGroup) { await store.updateRule(at: path) { _ in nil } }
            }
            .textCase(nil)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.rules.group")
    }

    private func removeButton(_ label: String, action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(Tokens.Text.tertiary.color)
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// "Match [all ▾] of these".
private struct MatchRow: View {
    let match: String
    let onChange: (String) -> Void

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Text(TasksCopy.rulesMatch)
            Menu {
                ForEach(TaskFilterRuleVocabulary.matches, id: \.self) { value in
                    Button {
                        onChange(value)
                    } label: {
                        if value == match {
                            Label(TasksCopy.ruleMatchLabel(value), systemImage: "checkmark")
                        } else {
                            Text(TasksCopy.ruleMatchLabel(value))
                        }
                    }
                }
            } label: {
                Text(TasksCopy.ruleMatchLabel(match))
                    .fontWeight(.semibold)
                    .foregroundStyle(match == "none" ? Tokens.Text.tint.color : Tokens.Text.primary.color)
            }
            .accessibilityIdentifier("tasks.rules.match")
            Text(TasksCopy.rulesOfThese)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Tokens.Text.secondary.color)
        .frame(minHeight: Tokens.Size.minimumHitArea)
    }
}
