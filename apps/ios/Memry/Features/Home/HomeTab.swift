import SwiftUI

// The Home page: pinned first in the bar. Its widgets are not built on
// iPhone yet, so the page says so. It carries the one global "+": write
// something down without choosing a page first (quick capture), Inbox picked.

struct HomeTab: View {
    let open: (CaptureReceipt) -> Void

    @Environment(\.quickCapture) private var capture
    @State private var capturing = false
    @State private var receipt: CaptureReceipt?

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label(VaultTab.home.title, systemImage: "house")
            } description: {
                Text("Home widgets are not on iPhone yet.")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Tokens.Canvas.background.color)
            .navigationTitle(VaultTab.home.title)
            .toolbar { GlobalSearchToolbarItem() }
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
                    FloatingAddButton(
                        label: QuickCaptureCopy.add,
                        hint: QuickCaptureCopy.addHint,
                        identifier: "home.addButton"
                    ) { capturing = true }
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
