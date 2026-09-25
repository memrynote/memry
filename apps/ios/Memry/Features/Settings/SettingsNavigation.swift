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
    case journal, perDayTemplates, inbox, tasks
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

/// The More tab: Settings, and Inbox once it ships (F1, F9).
struct MoreTabView: View {
    let context: SettingsContext?
    let browse: VaultBrowseViewModel?
    @Environment(TasksRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.settingsPath) {
            List {
                Section {
                    if SettingsFeatureGates.inbox, LocalSettings.shared.isOn(.inbox) {
                        SettingsRowLabel(title: SettingsCopy.inbox, symbol: "tray")
                    }
                    NavigationLink(value: SettingsRoute.root) {
                        SettingsRowLabel(title: SettingsCopy.title, symbol: "gearshape")
                    }
                    .accessibilityIdentifier("more.settings")
                }
            }
            .settingsList()
            .navigationTitle(SettingsCopy.moreTitle)
            .navigationDestination(for: SettingsRoute.self) { route in
                if let context {
                    SettingsDestination(route: route, context: context)
                } else {
                    ProgressView(SettingsCopy.loading)
                }
            }
            .navigationDestination(for: NoteRoute.self) { route in
                if let browse {
                    NoteReadView(
                        route: route,
                        reader: browse.reader,
                        filler: browse.filler,
                        editor: browse.editor,
                        metadataWriter: browse.metadataWriter,
                        writer: browse.writer,
                        search: browse.searcher,
                        open: { router.settingsPath.append($0) },
                        openTag: { router.settingsPath.append(TagRoute(name: $0)) },
                        noteTasks: browse.noteTasks
                    )
                }
            }
            .navigationDestination(for: TagRoute.self) { route in
                if let browse {
                    TaggedNotesView(tag: route.name, reader: browse.reader, open: { router.settingsPath.append($0) })
                }
            }
        }
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
        case .journal: JournalSettingsScreen(context: context)
        case .perDayTemplates: PerDayTemplatesScreen(context: context)
        case .inbox: InboxSettingsScreen(context: context)
        case .tasks: TaskSettingsView(store: context.tasks)
        case .templates: TemplatesScreen(context: context)
        case let .template(id): TemplateEditorScreen(context: context, templateId: id)
        case .tags: TagsScreen(context: context)
        case .properties: PropertiesScreen(context: context)
        case let .property(name): PropertyDetailScreen(context: context, name: name)
        }
    }
}
