import MemryCore
import SwiftUI

// Spec 006 ST30, artboards 01 / 01b. The account card, then the groups, each
// row showing its current value trailing. No Voice memos row (F4); Journal and
// Inbox appear once those features ship (F9).
struct SettingsRootScreen: View {
    let context: SettingsContext
    /// The split view's selected row (#4348); `nil` in a stack, where a row
    /// pushes its page.
    var selection: Binding<SettingsRoute?>?
    @Environment(JournalRouter.self) private var journalRouter

    var body: some View {
        let rows = SettingsRootRows(context)
        List(selection: selection) {
            SettingsAccountSection(context: context)
            Section {
                SettingsLinkRow(title: SettingsCopy.general, symbol: "gearshape", route: .general)
                SettingsLinkRow(
                    title: SettingsCopy.appearance, symbol: "paintpalette",
                    value: SettingsLabels.theme(context.store.theme), route: .appearance
                )
                SettingsLinkRow(
                    title: SettingsCopy.features, symbol: "square.grid.2x2",
                    value: SettingsCopy.featuresOn(context.local.shippedOn.count), route: .features
                )
            }
            Section(SettingsCopy.modules) {
                if context.local.isOn(.journal) {
                    // Journal owns its settings page (journal spec), in the
                    // Journal tab's stack; this row opens it there.
                    Button { journalRouter.openSettings() } label: {
                        SettingsRowLabel(title: SettingsCopy.journal, symbol: "book")
                    }
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityIdentifier("settings.row.journal")
                }
                if rows.shows(.tasks) {
                    SettingsLinkRow(title: SettingsCopy.tasks, symbol: "checkmark.circle", route: .tasks)
                }
                if rows.shows(.inbox) {
                    SettingsLinkRow(title: SettingsCopy.inbox, symbol: "tray", route: .inbox)
                }
            }
            Section(SettingsCopy.content) {
                SettingsLinkRow(title: SettingsCopy.templates, symbol: "doc.on.doc", route: .templates)
                SettingsLinkRow(title: SettingsCopy.tags, symbol: "number", route: .tags)
                SettingsLinkRow(title: SettingsCopy.properties, symbol: "list.bullet.rectangle", route: .properties)
                SettingsLinkRow(
                    title: ReadwiseCopy.title, symbol: "books.vertical",
                    value: context.store.readwise.map { ReadwiseDisplay($0, devices: context.account.devices).summary },
                    route: .readwise
                )
            }
            Section(SettingsCopy.data) {
                SettingsLinkRow(title: SettingsCopy.vaults, symbol: "externaldrive", route: .vaults)
                SettingsLinkRow(title: SettingsCopy.about, symbol: "info.circle", route: .about)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.title)
        .accessibilityIdentifier("settings.root")
        .refreshable { await context.tasks.sync() }
        .task { await context.account.load() }
    }
}

/// The root list's selectable rows, in order (#4348): the one owner of which
/// pages the list shows, read by the list and by the split view's selection.
/// Journal is a row too, but it opens the Journal tab, not a page.
struct SettingsRootRows {
    let routes: [SettingsRoute]

    init(account: AccountCardState, isOn: (AppFeature) -> Bool) {
        // The free vault's card leads to sign-in, not to Account.
        var routes: [SettingsRoute] = account == .local ? [] : [.account]
        routes += [.general, .appearance, .features]
        if isOn(.tasks) { routes.append(.tasks) }
        if isOn(.inbox) { routes.append(.inbox) }
        routes += [.templates, .tags, .properties, .readwise, .vaults, .about]
        self.routes = routes
    }

    @MainActor init(_ context: SettingsContext) {
        self.init(account: .of(context), isOn: context.local.isOn)
    }

    func shows(_ route: SettingsRoute) -> Bool { routes.contains(route) }

    /// The page the split view shows: the selected row while the list shows
    /// it, else the first row, which is Account (desktop's default) when
    /// there is one.
    func page(_ selected: SettingsRoute?) -> SettingsRoute {
        if let selected, shows(selected) { return selected }
        return routes.first ?? .general
    }
}

/// Words for a value shown trailing.
enum SettingsLabels {
    static func theme(_ theme: ThemeChoice) -> String {
        switch theme {
        case .system: SettingsCopy.system
        case .light: SettingsCopy.warm
        case .white: SettingsCopy.white
        case .dark: SettingsCopy.dark
        }
    }

    static func font(_ font: FontChoice) -> String {
        switch font {
        case .system: "System Default"
        case .sansSerif: "Sans-serif"
        case .serif: "Serif (Crimson Pro)"
        case .gelasio: "Gelasio"
        case .geist: "Geist"
        case .inter: "Inter"
        case .monospace: "Monospace"
        }
    }

    static func plan(_ plan: String) -> String {
        plan.prefix(1).uppercased() + plan.dropFirst()
    }

    static func relative(_ date: Date, now: Date = .now) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }
}

/// The sync line and dot, from the tasks store's pass state and the local
/// "last synced" (spec 006 ST15).
@MainActor
enum SyncStatusText {
    static func status(_ context: SettingsContext) -> String {
        if context.tasks.isSyncing { return SettingsCopy.syncing }
        if context.account.isOffline { return SettingsCopy.offline }
        if context.account.pending > 0 { return SettingsCopy.pending(Int(context.account.pending)) }
        guard let last = context.local.lastSyncedAt else { return SettingsCopy.neverSynced }
        return SettingsCopy.syncedAgo(SettingsLabels.relative(last))
    }

    static func cardLine(_ context: SettingsContext) -> String {
        let status = status(context)
        guard let plan = context.account.billing?.plan else { return status }
        return "\(SettingsLabels.plan(plan)) · \(status)"
    }

    static func dot(_ context: SettingsContext) -> SyncDot.State {
        if context.account.isOffline { return .offline }
        if context.tasks.isSyncing || context.account.pending > 0 { return .pending }
        return .synced
    }
}
