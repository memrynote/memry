import SwiftUI

/// Which layout a view takes: the tablet one needs regular width and regular
/// height. An iPad window narrow enough to be compact, and a large iPhone in
/// landscape (compact height, regular width), keep the phone layout
/// (`DESIGN.md` › Tablet, "Size class decides").
enum LayoutWidth: Equatable {
    case compact, regular

    init(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?) {
        self = horizontal == .regular && vertical == .regular ? .regular : .compact
    }
}
