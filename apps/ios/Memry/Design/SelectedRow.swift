import SwiftUI

// #4832. The selected row in an iPad sidebar or list (Settings, Notes, Tasks,
// Inbox, the search palette): desktop's neutral `surface-active` fill, edged
// with `Line.selected` so the state clears WCAG 1.4.11's 3:1 in light, dark
// and Increase Contrast. The rows keep their own text colours on it.

struct SelectedRowFill: View {
    var body: some View {
        RoundedRectangle(cornerRadius: Tokens.Radius.small)
            .fill(Tokens.Canvas.surfaceActive.color)
            .strokeBorder(Tokens.Line.selected.color, lineWidth: 1.5)
    }
}

extension View {
    /// A list row's background while `selected`, which also hides the list's
    /// own selection highlight. The list's background otherwise.
    @ViewBuilder func selectedRowBackground(_ selected: Bool) -> some View {
        if selected { listRowBackground(SelectedRowFill()) } else { self }
    }
}
