import SwiftUI

// TP048. The name prompt for saving and renaming a saved filter
// (`save-filter-dialog.tsx`): one text field, Save disabled until the name is
// 1 to 100 characters (the core's rule), Cancel leaves everything as it was.

private struct SavedFilterNamePrompt: ViewModifier {
    @Binding var isPresented: Bool
    let title: String
    let confirm: String
    let initialName: String
    let onSubmit: @MainActor (String) async -> Bool

    @State private var name = ""

    func body(content: Content) -> some View {
        content
            .alert(title, isPresented: $isPresented) {
                TextField(TasksCopy.saveFilterPlaceholder, text: $name)
                    .accessibilityIdentifier("tasks.filter.saveName")
                Button(TasksCopy.filterCancel, role: .cancel) {}
                Button(confirm) {
                    let submitted = name
                    Task { _ = await onSubmit(submitted) }
                }
                .disabled(!TaskFilterOptions.isValidSavedFilterName(name))
                .accessibilityIdentifier("tasks.filter.saveConfirm")
            } message: {
                Text(TasksCopy.saveFilterNameRule)
            }
            .onChange(of: isPresented) { _, shown in
                if shown { name = initialName }
            }
    }
}

extension View {
    /// Asks for a saved filter's name; `onSubmit` returns whether it was kept.
    func savedFilterNamePrompt(
        isPresented: Binding<Bool>,
        title: String,
        confirm: String,
        initialName: String,
        onSubmit: @escaping @MainActor (String) async -> Bool
    ) -> some View {
        modifier(SavedFilterNamePrompt(
            isPresented: isPresented,
            title: title,
            confirm: confirm,
            initialName: initialName,
            onSubmit: onSubmit
        ))
    }
}
