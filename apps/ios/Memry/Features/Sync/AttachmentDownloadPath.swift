import MemryCore

// #5644. The Download attachments setting (Settings › Account,
// `LocalSettings.attachmentDownload`) picks the path the core's metered policy
// judges a download against.
//
// The core decides per attachment (FR-045, `may_download` in
// `crates/memry-core/src/domain/attachments.rs`): `.wifi` downloads,
// `.cellular` defers every row the user did not mark for metered data, and
// `.offline` never downloads. A row is unmetered-only unless marked, and no
// API marks one yet. The setting is said in that vocabulary rather than
// re-argued here:
//
// | Setting  | Note redrive (background)     | Opened by the user |
// | -------- | ----------------------------- | ------------------ |
// | Always   | any usable path, as unmetered | any usable path    |
// | On Wi-Fi | the observed path             | any usable path    |
// | Never    | none                          | any usable path    |
//
// The Inbox pass takes the observed path whatever the setting, as desktop
// downloads Inbox files whatever its toggle
// (`apps/desktop/src/main/inbox/attachment-sync.ts`). The observed path is
// already metered on cellular, a hotspot and Low Data Mode
// (`PathReachability.classify`). Nothing here deletes bytes this device holds.

extension AttachmentDownload {
    /// The path a note attachment nobody opened is judged against. `.offline`
    /// downloads nothing, so the redriver skips the call.
    func backgroundPath(on observed: Reachable) -> Reachable {
        guard observed != .offline else { return .offline }
        switch self {
        case .always: return .wifi
        case .wifi: return observed
        // Not `.cellular`: a row marked for metered data would download.
        case .never: return .offline
        }
    }

    /// The path an attachment the user opened is judged against: any usable
    /// one, whatever the setting (`SettingsCopy.downloadFooter`).
    static func openedPath(on observed: Reachable) -> Reachable {
        observed == .offline ? .offline : .wifi
    }
}

/// An on-open download the user can see. Absent reads as not downloaded yet.
enum AttachmentFetchState: Equatable {
    case downloading
    /// The download threw. The mapped error says whether trying again helps.
    case failed(UserFacingError)
}
