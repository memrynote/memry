import SwiftUI

// #4341. A picker tied to one control. At regular width a sheet ignores its
// detents and becomes a centred form sheet with no tie to the control that
// opened it; a popover of `size` points at that control instead. Compact
// width keeps the sheet it always was, with the content's own detents: a
// popover's compact adaptation drops some of them (a `.height` detent opened
// full height).

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
    @Environment(\.horizontalSizeClass) private var sizeClass

    func body(content: Content) -> some View {
        if sizeClass == .regular {
            content.popover(isPresented: $isPresented) {
                picker().frame(idealWidth: size.width, idealHeight: size.height)
            }
        } else {
            content.sheet(isPresented: $isPresented, content: picker)
        }
    }
}

struct PickerItemPopover<Item: Identifiable, Picker: View>: ViewModifier {
    @Binding var item: Item?
    let size: CGSize
    let picker: (Item) -> Picker
    @Environment(\.horizontalSizeClass) private var sizeClass

    func body(content: Content) -> some View {
        if sizeClass == .regular {
            content.popover(item: $item) { picker($0).frame(idealWidth: size.width, idealHeight: size.height) }
        } else {
            content.sheet(item: $item, content: picker)
        }
    }
}

/// The popover sizes at regular width.
enum PickerSize {
    static let standard = CGSize(width: 375, height: 520)
    static let tall = CGSize(width: 375, height: 640)
    static let short = CGSize(width: 420, height: 240)
}
