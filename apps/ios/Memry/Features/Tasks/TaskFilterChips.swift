import MemryCore
import SwiftUI

// TP048. The active filters bar (`filters/active-filters-bar.tsx`): one pill
// per set dimension with its own clear, then Save and Clear all. Nothing when
// no filter is set.

/// The active filter chips.
struct ActiveFilterChips: View {
    let store: TasksStore
    @State private var isSaving = false

    private var chips: [TaskFilterChip] {
        TaskFilterChip.chips(for: store.state.filters, projects: store.projects)
    }

    var body: some View {
        if !chips.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: Tokens.Space.small) {
                    ForEach(chips) { chip in
                        TaskFilterChipView(chip: chip) {
                            Task { await store.clearFilterChip(chip) }
                        }
                    }
                    saveButton
                    Button(TasksCopy.filterClearAll, role: .destructive) {
                        Task { await store.clearFilters() }
                    }
                    .font(Tokens.Typography.label.font)
                    .foregroundStyle(Tokens.Interaction.destructive.color)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .accessibilityLabel(TasksCopy.filterClearAllLabel)
                    .accessibilityIdentifier("tasks.filterChips.clearAll")
                }
                .padding(.horizontal, Tokens.Space.inset)
            }
            .scrollIndicators(.hidden)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(TasksCopy.chipsLabel)
            .accessibilityIdentifier("tasks.filterChips")
            .savedFilterNamePrompt(
                isPresented: $isSaving,
                title: TasksCopy.saveFilter,
                confirm: TasksCopy.saveFilter,
                initialName: ""
            ) { name in
                await store.saveCurrentFilter(name: name)
            }
        }
    }

    /// "Save", or "Saved" while a saved filter is applied unchanged.
    private var saveButton: some View {
        let isSaved = store.activeSavedFilterId != nil
        return Button {
            isSaving = true
        } label: {
            Label(isSaved ? TasksCopy.savedChip : TasksCopy.saveChip, systemImage: isSaved ? "star.fill" : "star")
                .font(Tokens.Typography.label.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(minHeight: Tokens.Size.minimumHitArea)
        }
        .buttonStyle(.plain)
        .disabled(isSaved)
        .accessibilityIdentifier("tasks.filterChips.save")
    }
}

/// One pill: "Priority is High, Urgent" and its remove button.
struct TaskFilterChipView: View {
    let chip: TaskFilterChip
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Space.tight) {
            if let prefix = chip.prefix {
                Text(prefix)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            Text(chip.value)
                .fontWeight(.medium)
                .foregroundStyle(Tokens.Text.primary.color)
                .lineLimit(1)
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(TasksCopy.chipRemoveLabel(chip.dimensionName.lowercased()))
            .accessibilityIdentifier("tasks.filterChip.\(chip.id).remove")
        }
        .font(Tokens.Typography.label.font)
        .padding(.leading, Tokens.Space.medium)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.control))
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.control)
                .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel([chip.prefix, chip.value].compactMap(\.self).joined(separator: " "))
        .accessibilityAction(named: TasksCopy.chipRemoveLabel(chip.dimensionName.lowercased()), onRemove)
        .accessibilityIdentifier("tasks.filterChip.\(chip.id)")
    }
}

/// A list group's header that collapses the group; the choice persists in
/// `state.collapsedGroups`. The list block draws the rows under it.
struct TaskFilterGroupHeader: View {
    let group: TaskGroupItem
    let store: TasksStore

    private var isCollapsed: Bool { store.isGroupCollapsed(group.key) }

    /// A user-data group (project, status, folder) carries its name; the rest
    /// a label key.
    private var title: String {
        group.name ?? TasksCopy.groupLabel(group.labelKey ?? group.key)
    }

    var body: some View {
        Button {
            store.toggleGroupCollapsed(group.key)
        } label: {
            HStack(spacing: Tokens.Space.small) {
                Image(systemName: "chevron.forward")
                    .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                    .calmAnimation(.fast, .moving, value: isCollapsed)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityHidden(true)
                if let color = group.color {
                    Circle()
                        .fill(Tokens.Palette.color(color))
                        .frame(width: Tokens.Space.small, height: Tokens.Space.small)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(Tokens.Typography.label.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Text("\(group.taskIds.count)")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .monospacedDigit()
                Spacer(minLength: 0)
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            TasksCopy.filterGroupToggleLabel("\(title), \(group.taskIds.count)", collapsed: isCollapsed)
        )
        .accessibilityHint(TasksCopy.filterGroupToggleHint(collapsed: isCollapsed))
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("tasks.group.\(group.key)")
    }
}
