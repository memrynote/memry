import MemryCore

// #5644. The background Inbox pass takes the observed path whatever the
// Download attachments setting (`AttachmentRedriver`), and on a metered one
// the core defers every file (FR-045). An attachment the user opens always
// downloads (`SettingsCopy.downloadFooter`), so an opened capture does not
// wait for Wi-Fi.

extension InboxStore {
    /// Downloads an opened capture's file when this device does not hold it.
    ///
    /// Two core calls, because placing the file is the Inbox pass's: the fetch
    /// lands the bytes in the attachment cache on any usable path, and the
    /// pass copies cached bytes into `attachments/inbox/{id}/` without a
    /// download. Other captures' files in that pass stay on the observed path.
    /// Only an unfiled capture: the pass places no other.
    func downloadFile(of item: InboxItemRecord) async {
        guard let filler, let attachmentId = item.attachmentId, item.filedAtMs == nil,
              item.attachmentPath != nil, localFile(item.attachmentPath) == nil,
              fileDownloads[item.id] != .downloading
        else { return }
        let observed = reachability()
        let opened = AttachmentDownload.openedPath(on: observed)
        guard opened != .offline else { return }
        fileDownloads[item.id] = .downloading
        do {
            let fetched = try await filler.fetchAttachment(attachmentId: attachmentId, reachable: opened)
            if fetched.downloaded {
                let pass = try await filler.syncInboxAttachments(reachable: observed)
                // An upload in the pass reaches other devices only with a sync.
                if pass.uploaded > 0 { requestSync?() }
                inboxFilesDownloaded()
            }
            fileDownloads[item.id] = nil
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("an inbox file could not be downloaded", .code(mapped.code))
            fileDownloads[item.id] = Task.isCancelled ? nil : .failed(mapped)
        }
    }
}
