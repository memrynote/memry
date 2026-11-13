import SwiftUI

// #4341. A picker tied to one control. At regular width a sheet ignores its
// detents and becomes a centred form sheet with no tie to the control that
// opened it; a popover points at that control instead. At compact width the
// popover adapts to the same sheet as before, so the content's own detents
// still apply there. The ideal size only sizes the popover: a sheet proposes
// its own size.

extension View {
    func pickerPopover(
        isPresented: Binding<Bool>,
        size: CGSize = PickerPopover.standard,
        @ViewBuilder content: @escaping () -> some View
    ) -> some View {
        popover(isPresented: isPresented) {
            content().frame(idealWidth: size.width, idealHeight: size.height)
        }
    }

    func pickerPopover<Item: Identifiable>(
        item: Binding<Item?>,
        size: CGSize = PickerPopover.standard,
        @ViewBuilder content: @escaping (Item) -> some View
    ) -> some View {
        popover(item: item) { value in
            content(value).frame(idealWidth: size.width, idealHeight: size.height)
        }
    }
}

enum PickerPopover {
    static let standard = CGSize(width: 375, height: 520)
    static let tall = CGSize(width: 375, height: 640)
    static let short = CGSize(width: 420, height: 240)
}
