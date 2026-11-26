import SwiftUI

/// Menu's sheet: the pages that did not fit the bar, then Settings. A pick
/// shows under the Menu tab; the page behind the sheet does not change until
/// then.
struct VaultMenuSheet: View {
    let pages: [VaultTab]
    let select: (VaultTab) -> Void

    var body: some View {
        NavigationStack {
            List {
                if !pages.isEmpty {
                    Section {
                        ForEach(pages, id: \.self) { page in
                            row(page, title: page.title, symbol: page.symbol)
                        }
                    }
                }
                Section {
                    row(.more, title: SettingsCopy.title, symbol: "gearshape")
                }
            }
            .navigationTitle(VaultTab.more.title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func row(_ page: VaultTab, title: String, symbol: String) -> some View {
        Button { select(page) } label: {
            Label(title, systemImage: symbol)
                .foregroundStyle(Tokens.Text.primary.color)
        }
        .accessibilityIdentifier(page == .more ? "menu.settings" : "menu.\(page.rawValue)")
    }
}
