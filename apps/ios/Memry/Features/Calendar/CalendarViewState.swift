import Foundation

// Spec 007 CL023. Desktop keeps the calendar's view state per tab
// (`calendar-view-state.ts`: view, anchor date, the memrynote / imported
// switches, the explicit imported-source selection, visual types, timeline
// settings); the phone has one calendar, so it keeps them per device. Every
// field is optional on decode so a state saved by an older build still loads.

enum CalendarViewMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case day, week, month, year, timeline
    var id: String { rawValue }
}

/// `VISUAL_TYPE_ORDER` (`visual-type-meta.ts`).
enum CalendarVisualType: String, Codable, CaseIterable, Identifiable, Sendable {
    case event
    case externalEvent = "external_event"
    case task, reminder, snooze, note
    case noteDate = "note_date"
    var id: String { rawValue }
}

enum TimelineZoom: String, Codable, CaseIterable, Identifiable, Sendable {
    case weeks, months, quarters
    var id: String { rawValue }
}

enum TimelineGroupBy: String, Codable, CaseIterable, Identifiable, Sendable {
    case project, status, priority, none
    var id: String { rawValue }
}

enum TimelineOrderBy: String, Codable, CaseIterable, Identifiable, Sendable {
    case start, due, title
    var id: String { rawValue }
}

/// `TimelineSettings`, `DEFAULT_TIMELINE_SETTINGS`.
struct TimelineSettings: Codable, Equatable, Sendable {
    var zoom: TimelineZoom = .months
    var groupBy: TimelineGroupBy = .project
    var orderBy: TimelineOrderBy = .start
    var showEvents = true
    var showUndated = true
    var showCompleted = false
    var showSubtasks = false
}

struct CalendarViewState: Codable, Equatable, Sendable {
    /// Day is the phone's default (artboard 01); desktop's global default is Month.
    var view: CalendarViewMode = .day
    var anchorDate: String?
    var showMemryItems = true
    var showImportedCalendars = true
    /// `nil` = "has not picked a subset" (every synced source shows).
    var importedSourceIds: [String]?
    var visualTypes: [CalendarVisualType] = CalendarVisualType.allCases
    var timeline = TimelineSettings()
    /// Calendar-enabled date properties (§6 CL002: device-local, as desktop's
    /// `.memry/properties.md` is per vault file and not synced).
    var calendarProperties: [String] = []

    init() {}

    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        view = (try? values.decodeIfPresent(CalendarViewMode.self, forKey: .view)) ?? .day
        anchorDate = try? values.decodeIfPresent(String.self, forKey: .anchorDate)
        showMemryItems = (try? values.decodeIfPresent(Bool.self, forKey: .showMemryItems)) ?? true
        showImportedCalendars = (try? values.decodeIfPresent(Bool.self, forKey: .showImportedCalendars)) ?? true
        importedSourceIds = try? values.decodeIfPresent([String].self, forKey: .importedSourceIds)
        let types = (try? values.decodeIfPresent([String].self, forKey: .visualTypes)) ?? nil
        visualTypes = types.map { $0.compactMap(CalendarVisualType.init(rawValue:)) } ?? CalendarVisualType.allCases
        timeline = (try? values.decodeIfPresent(TimelineSettings.self, forKey: .timeline)) ?? TimelineSettings()
        calendarProperties = (try? values.decodeIfPresent([String].self, forKey: .calendarProperties)) ?? []
    }

    // MARK: Persistence

    static func key(vaultId: String) -> String { "calendar.viewState.\(vaultId)" }

    static func load(vaultId: String, defaults: UserDefaults = .standard) -> CalendarViewState {
        guard let data = defaults.data(forKey: key(vaultId: vaultId)),
              let state = try? JSONDecoder().decode(CalendarViewState.self, from: data)
        else { return CalendarViewState() }
        return state
    }

    func save(vaultId: String, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key(vaultId: vaultId))
    }
}

/// `resolveSelectedSourceIds` / `resolveSourceToggle` (`calendar-view-state.ts`).
enum CalendarSourceSelection {
    struct Source: Equatable {
        let id: String
        let isSelected: Bool
    }

    static func selected(stored: [String]?, sources: [Source]) -> [String] {
        let synced = sources.filter(\.isSelected).map(\.id)
        guard let stored else { return synced }
        return stored.filter { synced.contains($0) }
    }

    /// Unticking only hides; ticking a source nothing polls also subscribes it.
    static func toggle(_ id: String, selected: [String], sources: [Source]) -> (next: [String], subscribe: String?) {
        if selected.contains(id) { return (selected.filter { $0 != id }, nil) }
        let source = sources.first { $0.id == id }
        return (selected + [id], source.map { $0.isSelected ? nil : id } ?? nil)
    }
}
