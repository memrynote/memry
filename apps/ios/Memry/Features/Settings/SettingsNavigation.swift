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
    case features, about
    case inbox, tasks
    case templates, template(String)
    case tags, properties, property(String)

    /// A stable fragment for accessibility identifiers.
    var identifier: String {
        switch self {
        case let .template(id): "template.\(id)"
        case let .property(name): "property.\(name)"
        default: String(describing: self)
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
        } else {
            NavigationStack(path: $router.settingsPath) {
                Group {
                    if let context {
                        SettingsRootScreen(context: context)
                    } else {
                        ProgressView(SettingsCopy.loading)
                    }
                }
                .toolbar { GlobalSearchToolbarItem() }
                .navigationDestination(for: SettingsRoute.self) { route in
                    if let context {
                        SettingsDestination(route: route, context: context)
                    } else {
                        ProgressView(SettingsCopy.loading)
                    }
                }
                .noteDestinations(browse: browse, path: $router.settingsPath)
            }
        }
    }
}

private extension View {
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
        case .about: AboutScreen()
        case .inbox: InboxSettingsDestination()
        case .tasks: TaskSettingsView(store: context.tasks)
        case .templates: TemplatesScreen(context: context)
        case let .template(id): TemplateEditorScreen(context: context, templateId: id)
        case .tags: TagsScreen(context: context)
        case .properties: PropertiesScreen(context: context)
        case let .property(name): PropertyDetailScreen(context: context, name: name)
        }
    }
}
