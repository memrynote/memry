import SwiftUI

// #4341. A picker tied to one control. At regular width a sheet ignores its
// detents and becomes a centred form sheet with no tie to the control that
// opened it; a popover of `size` points at that control instead. Compact
// width keeps the sheet it always was, with the content's own detents: a
// popover's compact adaptation drops some of them (a `.height` detent opened
// full height). Regular means `LayoutWidth`: a large iPhone in landscape is
// regular width but keeps its sheets.
//
// Both presentations stay attached and only their bindings switch. Branching
// the view (`if regular { popover } else { sheet }`) gives the content a new
// identity when the size class changes, which tears down the view that
// presents, mid-presentation. A picker open across that change closes: the
// other style cannot present while the first is still on screen ("already
// presenting"), which left the binding set with nothing shown and the
// control dead until the window was resized back.

extension View {
    func pickerPopover(
        isPresented: Binding<Bool>,
        size: CGSize = PickerSize.standard,
        @ViewBuilder content: @escaping () -> some View
    ) -> some View {
        modifier(PickerPopover(isPresented: isPresented, size: size, picker: content))
    }

    func pickerPopover<Item: Identifiable>(
        item: Binding<Item?>,
        size: CGSize = PickerSize.standard,
        @ViewBuilder content: @escaping (Item) -> some View
    ) -> some View {
        modifier(PickerItemPopover(item: item, size: size, picker: content))
    }
}

struct PickerPopover<Picker: View>: ViewModifier {
    @Binding var isPresented: Bool
    let size: CGSize
    let picker: () -> Picker
    @Environment(\.horizontalSizeClass) private var horizontal
    @Environment(\.verticalSizeClass) private var vertical
    /// The size grows with Dynamic Type, never below `size`; the system keeps
    /// it on screen.
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    func body(content: Content) -> some View {
        let regular = LayoutWidth(horizontal: horizontal, vertical: vertical) == .regular
        content
            .popover(isPresented: regular ? $isPresented : .constant(false)) {
                picker().frame(idealWidth: size.width * max(scale, 1), idealHeight: size.height * max(scale, 1))
            }
            .sheet(isPresented: regular ? .constant(false) : $isPresented, content: picker)
            .onChange(of: regular) { isPresented = false }
    }
}

struct PickerItemPopover<Item: Identifiable, Picker: View>: ViewModifier {
    @Binding var item: Item?
    let size: CGSize
    let picker: (Item) -> Picker
    @Environment(\.horizontalSizeClass) private var horizontal
    @Environment(\.verticalSizeClass) private var vertical
    /// The size grows with Dynamic Type, never below `size`; the system keeps
    /// it on screen.
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    func body(content: Content) -> some View {
        let regular = LayoutWidth(horizontal: horizontal, vertical: vertical) == .regular
        content
            .popover(item: regular ? $item : .constant(nil)) {
                picker($0).frame(idealWidth: size.width * max(scale, 1), idealHeight: size.height * max(scale, 1))
            }
            .sheet(item: regular ? .constant(nil) : $item, content: picker)
            .onChange(of: regular) { item = nil }
    }
}

/// The popover sizes at regular width.
enum PickerSize {
    static let standard = CGSize(width: 375, height: 520)
    static let tall = CGSize(width: 375, height: 640)
    static let short = CGSize(width: 420, height: 240)
}
