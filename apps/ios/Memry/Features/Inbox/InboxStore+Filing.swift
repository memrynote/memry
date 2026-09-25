import Foundation
import MemryCore

// IB13 / IB14 / IB15 / IB16. Filing and converting, with desktop's toasts.
//
// Text captures are filed by the core in one call (note, body, tags, filed
// mark). File captures (image, voice, PDF, video) need their bytes, which only
// the capturing device holds (§5 F3): the core makes the note, this uploads
// the file into it as an attachment, inserts the block that shows it
// (`attachments/<noteId>/<name>`, the path desktop resolves), then marks the
// capture filed (§6 IB025).

/// How an image lands in the notes it is filed to (desktop's
/// `imageFilingMode`, device-local on both platforms, §5 F11).
enum InboxImageMode: String, CaseIterable, Identifiable, Sendable {
    case embed, link
    var id: String { rawValue }
}

/// A note to link a capture into: an existing one, or a new one by title.
struct InboxLinkChoice: Hashable, Sendable {
    let noteId: String?
    let title: String
}

extension InboxStore {
    /// Files to a folder (`""` = the vault root): the swipe, the quick-file
    /// row, the File sheet without note links.
    func file(_ item: InboxItemRecord, to folder: String, tags: [String]) async {
        let id = item.id
        let now = localNow()
        let target: String? = folder.isEmpty ? nil : folder
        if item.isBinary {
            guard await fileBinary(item, folder: target, tags: tags, action: "folder") else { return }
        } else {
            guard await writeRemoving([id], { try $0.fileToFolder(id: id, folder: target, tags: tags, localNow: now) }) != nil
            else { return }
        }
        showToast(InboxCopy.filedTo(InboxFolderName.leaf(folder))) { [weak self] in
            await self?.write { try $0.undoFile(id: id) }
            self?.showToast(InboxCopy.changesUndone)
        }
    }

    /// Files and links in one go (the File sheet with notes chosen).
    func link(
        _ item: InboxItemRecord,
        to notes: [InboxLinkChoice],
        folder: String,
        tags: [String],
        imageMode: InboxImageMode
    ) async {
        let id = item.id
        let now = localNow()
        let target: String? = folder.isEmpty ? nil : folder
        if item.isBinary {
            guard let owner = notes.first else { return }
            let ownerId: String? = if let existing = owner.noteId {
                existing
            } else {
                await newNote(owner.title, folder: target)
            }
            guard let ownerId else { return }
            // An image lands inside the first note; desktop's link mode puts a
            // file in the sidebar, which this phone cannot write (§6 IB025).
            guard await attach(item, toNote: ownerId, notePath: nil) else { return }
            if imageMode == .link, item.itemType == "image" { showToast(InboxCopy.embedFellBackToLink) }
            let path = "attachments/\(ownerId)/\(uploadName(item))"
            _ = await writeRemoving([id]) { try $0.markFiled(id: id, filedTo: path, action: "linked") }
            if imageMode != .link || item.itemType != "image" { showToast(InboxCopy.linkedToNotes(notes.count)) }
            return
        }
        let targets = notes.map { InboxLinkTarget(noteId: $0.noteId, newTitle: $0.noteId == nil ? $0.title : nil) }
        guard await writeRemoving([id], {
            try $0.linkToNotes(id: id, targets: targets, tags: tags, folder: target, localNow: now)
        }) != nil else { return }
        showToast(InboxCopy.linkedToNotes(notes.count))
    }

    /// Bulk File (desktop: folder only, no note links).
    func file(_ ids: [String], to folder: String, tags: [String]) async {
        let now = localNow()
        let target: String? = folder.isEmpty ? nil : folder
        let binaries = items.filter { ids.contains($0.id) && $0.isBinary }
        let texts = ids.filter { id in !binaries.contains { $0.id == id } }
        var processed = 0
        if !texts.isEmpty, let result = await writeRemoving(texts, {
            try $0.bulkFile(ids: texts, folder: target, tags: tags, localNow: now)
        }) {
            processed += Int(result.processed)
        }
        for item in binaries where await fileBinary(item, folder: target, tags: tags, action: "folder") {
            processed += 1
        }
        let name = InboxFolderName.leaf(folder)
        showToast(processed == ids.count
            ? InboxCopy.filedItemsTo(processed, name)
            : InboxCopy.filedPartial(processed, of: ids.count))
    }

    // MARK: Convert (IB14, IB15)

    func convertToNote(_ item: InboxItemRecord) async {
        if item.isBinary {
            await file(item, to: "", tags: [])
            return
        }
        let id = item.id
        let now = localNow()
        guard await writeRemoving([id], { try $0.convertToNote(id: id, localNow: now) }) != nil else { return }
        showToast(InboxCopy.convertedTo(InboxCopy.convertNote))
    }

    @discardableResult
    func convertToTask(
        _ item: InboxItemRecord,
        projectId: String?,
        dueDate: String?,
        dueTime: String?,
        priority: Int64
    ) async -> String? {
        let id = item.id
        let now = localNow()
        let filed = await writeRemoving([id]) {
            try $0.convertToTask(
                id: id, projectId: projectId, dueDate: dueDate, dueTime: dueTime, priority: priority, localNow: now
            )
        }
        guard let filed else { return nil }
        showToast(InboxCopy.convertedTo(InboxCopy.convertTask))
        return filed.targetId
    }

    func convertToReminder(_ item: InboxItemRecord, at date: Date) async {
        let id = item.id
        let now = localNow()
        let when = Int64(date.timeIntervalSince1970 * 1000)
        guard await writeRemoving([id], { try $0.convertToReminder(id: id, remindAtMs: when, localNow: now) }) != nil
        else { return }
        showToast(InboxCopy.convertedTo(InboxCopy.convertReminder))
    }

    // MARK: File captures

    /// The note, the upload, the block, the filed mark. `false` when any step
    /// failed (the capture stays in the inbox).
    private func fileBinary(_ item: InboxItemRecord, folder: String?, tags: [String], action: String) async -> Bool {
        guard localFile(item.attachmentPath) != nil else {
            fail(InboxErrors.fileElsewhere)
            return false
        }
        let id = item.id
        let now = localNow()
        guard let made = await read({ try $0.createNoteForFile(id: id, folder: folder, tags: tags, localNow: now) }),
              let noteId = made.targetId
        else { return false }
        guard await attach(item, toNote: noteId, notePath: made.filedTo) else { return false }
        return await writeRemoving([id]) { try $0.markFiled(id: id, filedTo: made.filedTo, action: action) } != nil
    }

    /// Uploads the capture's file into a note and shows it there.
    private func attach(_ item: InboxItemRecord, toNote noteId: String, notePath _: String?) async -> Bool {
        guard let filler, let writer, let file = localFile(item.attachmentPath),
              let bytes = try? Data(contentsOf: file)
        else {
            fail(filler == nil ? InboxErrors.offline : InboxErrors.fileElsewhere)
            return false
        }
        let name = uploadName(item)
        let mime = InboxMeta.metadata(item)["mimeType"] as? String ?? InboxFileTypes.mime(forExtension: file.pathExtension)
        do {
            _ = try await filler.uploadAttachment(noteId: noteId, filename: name, mimeType: mime, bytes: bytes)
        } catch {
            report(error)
            return false
        }
        let blockId = UUID().uuidString.lowercased()
        let kind = InboxFileTypes.blockKind(item.itemType)
        let edits: [BlockEdit] = [
            .insertBlock(kind: kind, afterBlockId: nil, text: "", newBlockId: blockId),
            .setProp(blockId: blockId, name: "url", value: "attachments/\(noteId)/\(name)"),
            .setProp(blockId: blockId, name: "name", value: name)
        ]
        do {
            try await executorRun { for edit in edits { _ = try writer.editBlock(noteId: noteId, edit: edit) } }
        } catch {
            report(error)
            return false
        }
        return true
    }

    /// The name the file travels under: the capture's title plus the stored
    /// extension (`getFiledBinaryFilename`).
    func uploadName(_ item: InboxItemRecord) -> String {
        let ext = (item.attachmentPath as NSString?)?.pathExtension ?? ""
        let base = item.title
            .components(separatedBy: CharacterSet(charactersIn: "<>:\"/\\|?*"))
            .joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let safe = base.isEmpty ? "capture" : String(base.prefix(200))
        return ext.isEmpty ? safe : "\(safe).\(ext)"
    }

    private func newNote(_ title: String, folder: String?) async -> String? {
        guard let writer else { return nil }
        do {
            return try await executorRun { try writer.create(title: title, folderPath: folder) }
        } catch {
            report(error)
            return nil
        }
    }
}

/// MIME and block kinds for file captures.
enum InboxFileTypes {
    static func blockKind(_ type: String) -> String {
        switch type {
        case "image": "image"
        case "voice": "audio"
        case "video": "video"
        default: "file"
        }
    }

    static func mime(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "jpg", "jpeg": "image/jpeg"
        case "png": "image/png"
        case "gif": "image/gif"
        case "webp": "image/webp"
        case "m4a": "audio/mp4"
        case "mp3": "audio/mpeg"
        case "wav": "audio/wav"
        case "mp4": "video/mp4"
        case "mov": "video/quicktime"
        case "pdf": "application/pdf"
        default: "application/octet-stream"
        }
    }
}
