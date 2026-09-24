import SwiftUI

// TP047. Small pieces the bulk bar and the list's edit mode share.

/// One action in the bulk bar: its symbol over a caption, never below the
/// 44pt hit area (`bulk-action-button.tsx`).
struct TaskBulkActionLabel: View {
    let title: String
    let systemImage: String
    var isDestructive = false

    var body: some View {
        VStack(spacing: Tokens.Space.tight) {
            Image(systemName: systemImage)
                .font(Tokens.Typography.body.font)
                .accessibilityHidden(true)
            Text(title)
                .font(Tokens.Typography.caption.font)
                .lineLimit(1)
        }
        .foregroundStyle(isDestructive ? Tokens.Interaction.destructive.color : Tokens.Text.primary.color)
        .padding(.horizontal, Tokens.Space.small)
        .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// "Select all" / "Deselect all" for the list's toolbar in edit mode
/// (`toggleSelectAll`).
struct TaskSelectAllButton: View {
    @Binding var selection: Set<String>
    let visibleIds: [String]

    var body: some View {
        let all = selection.containsAll(of: visibleIds)
        Button(all ? TasksCopy.deselectAll : TasksCopy.selectAll) {
            selection.toggleAll(in: visibleIds)
        }
        .disabled(visibleIds.isEmpty)
        .accessibilityIdentifier("tasks.selection.selectAll")
    }
}
