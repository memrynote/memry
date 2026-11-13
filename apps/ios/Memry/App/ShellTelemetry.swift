import Foundation

// Desktop's `page_viewed` (App.tsx, one per active-tab switch, surface per
// page) and `deep_link_opened` (main/index.ts, the link's kind only).

extension VaultTab {
    func trackPageView() {
        let track = { (surface: TelemetrySurface, objectType: StaticString) in
            Telemetry.shared.track(.pageViewed, surface: surface, action: "viewed", objectType: objectType)
        }
        switch self {
        case .home: track(.home, "home")
        case .notes: track(.notes, "notes")
        case .inbox: track(.inbox, "inbox")
        case .tasks: track(.tasks, "tasks")
        case .journal: track(.journal, "journal")
        case .calendar: track(.calendar, "calendar")
        case .more: track(.settings, "settings")
        }
    }
}

enum DeepLinkTelemetry {
    /// Never the URL, which can carry ids: only which kind of link it was.
    static func opened(_ url: URL) {
        guard url.scheme?.lowercased() == "memry" else { return }
        Telemetry.shared.track(.deepLinkOpened, surface: .app, action: "opened", dimension: (.target, target(url)))
    }

    static func target(_ url: URL) -> String {
        switch url.host()?.lowercased() {
        case "calendar": "calendar"
        case "open": "open"
        case "pair": "pair"
        case "oauth": "oauth"
        case "billing":
            switch url.path() {
            case "/start": "billing_start"
            case "/complete": "billing_complete"
            default: "billing"
            }
        default: url.path().hasPrefix("/oauth") ? "oauth" : "unknown"
        }
    }
}
