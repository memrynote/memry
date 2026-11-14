import MemryCore
import SwiftUI

// Spec 006 ST20. One `NavigationStack` for More › Settings, every page a
// `SettingsRoute` on `TasksRouter.settingsPath`, so a deep link from Tasks
// (… › Task settings) lands on its section with Back returning to Settings.

enum SettingsRoute: Hashable, Sendable {
    case root
    case account, storage, devices, vaults
    case general, newNotesFolder
    case appearance, font
    case features, semanticSearch, about
    case inbox, tasks
    case templates, template(String)
    case tags, properties, property(String)
    case readwise

    /// A stable fragment for accessibility identifiers.
    var identifier: String {
        switch self {
        case let .template(id): "template.\(id)"
        case let .property(name): "property.\(name)"
        default: String(describing: self)
        }
    }

    /// The root row a page is opened from: itself for a row, the page that
    /// links to it otherwise. The split view selects this row (#4348).
    var section: SettingsRoute {
        switch self {
        case .storage, .devices: .account
        case .newNotesFolder: .general
        case .font: .appearance
        case .template: .templates
        case .property: .properties
        case .root, .account, .vaults, .general, .appearance, .features, .semanticSearch, .about,
             .inbox, .tasks, .templates, .tags, .properties, .readwise: self
        }
    }
}

extension EnvironmentValues {
    /// Which page the shell builds `MoreTabView` for: `.calendar` for the
    /// Calendar page, anything else for Settings.
    @Entry var shellPage: VaultTab = .more
}

/// The pages built over the Settings context: Settings (Menu › Settings,
/// F1) and Calendar, each on its own stack.
///
/// At regular width (`DESIGN.md` › Tablet, #4348) Settings is a split view:
/// the root list is the sidebar, the selected row's page the detail, and a
/// page's links push inside the detail column. The shell picks the width
/// (`TasksRouter.setSettingsSplit`), so an iPhone in landscape keeps the stack.
struct MoreTabView: View {
    let context: SettingsContext?
    let browse: VaultBrowseViewModel?
    @Environment(TasksRouter.self) private var router
    @Environment(\.calendarStore) private var calendarStore
    @Environment(\.shellPage) private var page

    var body: some View {
        @Bindable var router = router
        if page == .calendar {
            NavigationStack(path: $router.calendarPath) {
                CalendarDestination(route: .calendar, store: calendarStore, browse: browse, account: context?.account)
                    .navigationDestination(for: CalendarRoute.self) { route in
                        CalendarDestination(route: route, store: calendarStore, browse: browse, account: context?.account)
                    }
                    .noteDestinations(browse: browse, path: $router.calendarPath)
            }
        } else if router.settingsSplit {
            SettingsSplitView(context: context, browse: browse)
        } else {
            NavigationStack(path: $router.settingsPath) {
                Group {
                    if let context {
                        SettingsRootScreen(context: context)
                    } else {
                        ProgressView(SettingsCopy.loading)
                    }
                }
                .settingsPage()
                .toolbar { GlobalSearchToolbarItem() }
                .settingsDestinations(context: context, browse: browse, path: $router.settingsPath)
            }
        }
    }
}

/// Settings at regular width: the root list beside the selected page, both
/// columns shown in portrait too. No search item: the shell's Search row
/// owns search at this width (as on Home).
private struct SettingsSplitView: View {
    let context: SettingsContext?
    let browse: VaultBrowseViewModel?
    @Environment(TasksRouter.self) private var router
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var router = router
        // A row the list shows: the free vault has no Account row, and a
        // module turned off takes its row away.
        let shown = context.map { SettingsRootRows($0).page(router.settingsPage) } ?? .general
        let page = Binding<SettingsRoute?>(
            get: { shown },
            set: { if let route = $0 { router.openSettings(route) } }
        )
        NavigationSplitView(columnVisibility: $columns) {
            Group {
                if let context {
                    // The selected row is neutral (`--surface-active`), not
                    // the tint: the rows' own text colours stay legible on it.
                    SettingsRootScreen(context: context, selection: page)
                        .tint(Tokens.Canvas.surfaceActive.color)
                } else {
                    ProgressView(SettingsCopy.loading)
                }
            }
        } detail: {
            NavigationStack(path: $router.settingsPath) {
                SettingsDestinationPage(route: shown, context: context)
                    .settingsDestinations(context: context, browse: browse, path: $router.settingsPath)
            }
        }
        .navigationSplitViewStyle(.balanced)
    }
}

/// A route's page at the settings measure, once the context exists.
private struct SettingsDestinationPage: View {
    let route: SettingsRoute
    let context: SettingsContext?

    var body: some View {
        if let context {
            SettingsDestination(route: route, context: context)
                .settingsPage()
        } else {
            ProgressView(SettingsCopy.loading)
        }
    }
}

private extension View {
    /// The pages a Settings page pushes, and the notes and tags it opens.
    func settingsDestinations(
        context: SettingsContext?,
        browse: VaultBrowseViewModel?,
        path: Binding<NavigationPath>
    ) -> some View {
        navigationDestination(for: SettingsRoute.self) { route in
            SettingsDestinationPage(route: route, context: context)
        }
        .noteDestinations(browse: browse, path: path)
    }

    /// The notes and tag lists a Settings or Calendar page opens, pushed on
    /// that page's own stack.
    func noteDestinations(
        browse: VaultBrowseViewModel?,
        path: Binding<NavigationPath>
    ) -> some View {
        navigationDestination(for: NoteRoute.self) { route in
            if let browse {
                NoteReadView(
                    route: route,
                    reader: browse.reader,
                    filler: browse.filler,
                    editor: browse.editor,
                    metadataWriter: browse.metadataWriter,
                    writer: browse.writer,
                    search: browse.searcher,
                    open: { path.wrappedValue.append($0) },
                    openTag: { path.wrappedValue.append(TagRoute(name: $0)) },
                    noteTasks: browse.noteTasks
                )
            }
        }
        .navigationDestination(for: TagRoute.self) { route in
            if let browse {
                TaggedNotesView(tag: route.name, browse: browse, open: { path.wrappedValue.append($0) })
            }
        }
    }
}

/// Settings › Inbox is the Inbox feature's own settings page (inbox spec),
/// over the vault's inbox store.
private struct InboxSettingsDestination: View {
    @Environment(\.inboxStore) private var store

    var body: some View {
        if let store { InboxSettingsView(store: store) } else { ProgressView(SettingsCopy.loading) }
    }
}

/// Maps a route to its page.
struct SettingsDestination: View {
    let route: SettingsRoute
    let context: SettingsContext

    var body: some View {
        switch route {
        case .root: SettingsRootScreen(context: context)
        case .account: AccountScreen(context: context)
        case .storage: StorageScreen(context: context)
        case .devices: DevicesScreen(context: context)
        case .vaults: VaultsScreen(context: context)
        case .general: GeneralScreen(context: context)
        case .newNotesFolder: NewNotesFolderScreen(context: context)
        case .appearance: AppearanceScreen(store: context.store)
        case .font: FontScreen(store: context.store)
        case .features: FeaturesScreen(local: context.local)
        case .semanticSearch: SemanticSearchScreen(vault: context.vault, executor: context.executor)
        case .about: AboutScreen()
        case .inbox: InboxSettingsDestination()
        case .tasks: TaskSettingsView(store: context.tasks)
        case .templates: TemplatesScreen(context: context)
        case let .template(id): TemplateEditorScreen(context: context, templateId: id)
        case .tags: TagsScreen(context: context)
        case .properties: PropertiesScreen(context: context)
        case let .property(name): PropertyDetailScreen(context: context, name: name)
        case .readwise: ReadwiseScreen(context: context)
        }
    }
}
