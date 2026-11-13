import SwiftUI

// The Home page: pinned first in the bar. Its widgets are only on desktop for
// now, so the page says so. It carries the one global "+": write something
// down without choosing a page first (quick capture), Inbox picked.

struct HomeTab: View {
    let switchVault: (() -> Void)?
    let open: (CaptureReceipt) -> Void

    @Environment(\.quickCapture) private var capture
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var capturing = false
    @State private var receipt: CaptureReceipt?

    var body: some View {
        let items = HomeChrome.items(
            width: LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass),
            canCapture: capture != nil,
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
                        Button(QuickCaptureCopy.add, systemImage: "square.and.pencil") { capturing = true }
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
            if capture != nil {
                HStack(spacing: Tokens.Space.medium) {
                    if let receipt {
                        CaptureToast(receipt: receipt) {
                            self.receipt = nil
                            open(receipt)
                        }
                    }
                    if items.contains(.floatingCapture) {
                        FloatingAddButton(
                            label: QuickCaptureCopy.add,
                            hint: QuickCaptureCopy.addHint,
                            identifier: "home.addButton"
                        ) { capturing = true }
                    }
                }
                .padding(.horizontal, Tokens.Space.inset)
                .padding(.bottom, Tokens.Space.medium)
            }
        }
        .sheet(isPresented: $capturing) {
            if let capture {
                QuickCaptureSheet(kinds: CaptureKind.allCases.filter(\.isShown), capture: capture) { made in
                    receipt = made
                }
            }
        }
        .task(id: receipt) {
            guard receipt != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            receipt = nil
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
