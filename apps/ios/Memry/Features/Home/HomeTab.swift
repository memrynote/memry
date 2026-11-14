import SwiftUI

// The Home page: pinned first in the bar. Its widgets are only on desktop for
// now, so the page says so. It carries the one global "+": write something
// down without choosing a page first (quick capture), Inbox picked. The shell
// owns the capture sheet, which ⇧⌘N opens from any page (#4355).

struct HomeTab: View {
    let switchVault: (() -> Void)?
    /// Opens the shell's quick capture sheet.
    let capture: () -> Void
    let open: (CaptureReceipt) -> Void

    @Environment(\.quickCapture) private var quickCapture
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var body: some View {
        let items = HomeChrome.items(
            width: LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass),
            canCapture: quickCapture != nil,
            canSwitchVault: switchVault != nil
        )
        NavigationStack {
            ContentUnavailableView {
                Label(VaultTab.home.title, systemImage: "house")
            } description: {
                Text(HomeCopy.limitation)
            }
            .measuredColumn(Tokens.Size.reading)
            .frame(maxHeight: .infinity)
            .background(Tokens.Canvas.background.color)
            .navigationTitle(VaultTab.home.title)
            .toolbar {
                if items.contains(.capture) {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(QuickCaptureCopy.add, systemImage: "square.and.pencil", action: capture)
                            .accessibilityHint(QuickCaptureCopy.addHint)
                            .accessibilityIdentifier("home.addButton")
                    }
                }
                if items.contains(.switchVault), let switchVault {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Switch vault", systemImage: "lock.square") { switchVault() }
                    }
                }
                if items.contains(.search) {
                    GlobalSearchToolbarItem()
                }
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if quickCapture != nil {
                HStack(spacing: Tokens.Space.medium) {
                    // The last capture's confirmation, beside the "+".
                    if let receipt = quickCapture?.receipt {
                        CaptureToast(receipt: receipt) { open(receipt) }
                    }
                    if items.contains(.floatingCapture) {
                        FloatingAddButton(
                            label: QuickCaptureCopy.add,
                            hint: QuickCaptureCopy.addHint,
                            identifier: "home.addButton"
                        ) { capture() }
                    }
                }
                .padding(.horizontal, Tokens.Space.inset)
                .padding(.bottom, Tokens.Space.medium)
            }
        }
    }
}

/// Home's chrome at a width (L2, L3 on #4353). At regular width quick capture
/// moves into the toolbar as `square.and.pencil`, and the sidebar header and
/// its Search row own vault switching and search, so Home drops them. Compact
/// width keeps the floating "+" and both toolbar items.
enum HomeChrome: Equatable {
    case capture, floatingCapture, switchVault, search

    static func items(width: LayoutWidth, canCapture: Bool, canSwitchVault: Bool) -> [HomeChrome] {
        switch width {
        case .regular: canCapture ? [.capture] : []
        case .compact: (canCapture ? [.floatingCapture] : []) + (canSwitchVault ? [.switchVault] : []) + [.search]
        }
    }
}

enum HomeCopy {
    static let limitation = "Home widgets are only on desktop for now."
}
