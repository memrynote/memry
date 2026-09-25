import SwiftUI

// A list screen's large title with its title menu and the subtitle under it
// (spec 005 RD01/RD02, moved here by spec 006 IB032 so the Inbox's views menu
// is the same control as the Tasks views menu).
//
// iOS 26.5 offers `toolbarTitleMenu` on an inline title only (a large title
// shows no menu affordance), so the large title is this `Menu`, drawn as the
// list's first element; the collapsed inline title keeps the system menu.
// Without menu items (select mode) it is plain text.

struct TitleMenuHeader<Items: View, Leading: View, Accessory: View>: View {
    let title: String
    let subtitle: String
    /// `false` draws the title as plain text ("3 selected").
    var showsMenu = true
    let menuHint: String
    /// `<prefix>.titleMenu`, `<prefix>.subtitle` for UI tests.
    let identifier: String
    @ViewBuilder var items: () -> Items
    /// Drawn before the title (a project's colour dot).
    @ViewBuilder var leading: () -> Leading
    /// Drawn after the subtitle (the Inbox's "1 fetching").
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight / 2) {
            if showsMenu {
                Menu {
                    items()
                } label: {
                    label(chevron: true)
                }
                .buttonStyle(.plain)
                .accessibilityHint(menuHint)
                .accessibilityIdentifier("\(identifier).titleMenu")
            } else {
                label(chevron: false)
            }
            HStack(spacing: Tokens.Space.small) {
                Text(subtitle)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityIdentifier("\(identifier).subtitle")
                accessory()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(chevron: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            leading()
            Text(title)
                .font(Tokens.Typography.screenTitle.font.weight(.bold))
                .foregroundStyle(Tokens.Text.primary.color)
                .multilineTextAlignment(.leading)
                .accessibilityAddTraits(.isHeader)
            if chevron {
                Image(systemName: "chevron.down")
                    .font(Tokens.Typography.body.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(.rect)
    }
}

extension TitleMenuHeader where Leading == EmptyView, Accessory == EmptyView {
    init(
        title: String,
        subtitle: String,
        showsMenu: Bool = true,
        menuHint: String,
        identifier: String,
        @ViewBuilder items: @escaping () -> Items
    ) {
        self.init(
            title: title, subtitle: subtitle, showsMenu: showsMenu, menuHint: menuHint,
            identifier: identifier, items: items, leading: { EmptyView() }, accessory: { EmptyView() }
        )
    }
}
