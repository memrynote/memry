import Foundation
import UniformTypeIdentifiers

// #4357. Files dropped on a note's block go through the pickers' one upload
// (`attach`), so the core and the server hold them to the same limits, and a
// refusal shows the same alert (`EditorAttachmentSources`).

extension NoteAttachmentComposer {
    /// Uploads under a prefixed name, as desktop saves every attachment, so a
    /// second `photo-<second>.jpg` or `report.pdf` in the same note does not
    /// overwrite the first, then inserts the block after `blockId` (`nil`:
    /// the caret's block). A refusal shows the pickers' alert.
    func attach(_ payload: AttachmentPayload, in session: EditorSession, after blockId: String?) async {
        if case let .failure(refusal) = await add(payload, in: session, after: blockId) {
            fail(refusal)
        }
    }

    /// Each dropped file into a block after the one before it, the first
    /// after `blockId`, so the blocks keep the drag's order. A refusal or an
    /// unreadable file does not stop the rest; one alert at the end says how
    /// many were not added, in the first refusal's words.
    func attachDropped(_ providers: [NSItemProvider], in session: EditorSession, after blockId: String) async {
        let files = providers.compactMap { provider in EditorDrop.fileType(of: provider).map { (provider, $0) } }
        var after = blockId
        var refusals: [UserFacingError] = []
        for (provider, type) in files {
            beginReading()
            guard let payload = await Self.payload(provider, type: type) else {
                Log.storage.error("a dropped file could not be read", .code(ErrorMapping.droppedFileUnreadable.code))
                endReading()
                refusals.append(ErrorMapping.droppedFileUnreadable)
                continue
            }
            switch await add(payload, in: session, after: after) {
            case let .success(newId): after = newId ?? after
            case let .failure(refusal): refusals.append(refusal)
            }
        }
        if let first = refusals.first {
            fail(files.count == 1 ? first : ErrorMapping.notAdded(refusals.count, of: files.count, first))
        }
    }

    /// The upload, then its block: the new block's id (`nil` when only the
    /// insert failed, which the editor's status shows), or the refusal.
    private func add(
        _ payload: AttachmentPayload, in session: EditorSession, after blockId: String?
    ) async -> Result<String?, UserFacingError> {
        let filename = AttachmentFilename.unique(payload.filename)
        switch await send(filename: filename, mimeType: payload.mimeType, bytes: payload.bytes) {
        case let .failure(refusal): return .failure(refusal)
        case .success:
            return await .success(session.insertAttachment(
                AttachmentBlock.make(noteId: noteId, filename: filename, mimeType: payload.mimeType, size: payload.bytes.count),
                after: blockId
            ))
        }
    }

    /// The file's bytes, named as Choose File names a file. A picture desktop
    /// cannot draw (HEIC from Photos) becomes JPEG, as the photo picker's does.
    private static func payload(_ provider: NSItemProvider, type: UTType) async -> AttachmentPayload? {
        let suggested = provider.suggestedName
        let read: (Data, String, String)? = await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                // The file is gone once this returns, so it is read here.
                guard let url, let data = try? Data(contentsOf: url) else {
                    continuation.resume(returning: nil)
                    return
                }
                let named = suggested.map { $0.contains(".") ? $0 : "\($0).\(url.pathExtension)" }
                continuation.resume(returning: (data, named ?? url.lastPathComponent, mimeType(for: url)))
            }
        }
        guard let (data, filename, mimeType) = read else { return nil }
        let ext = (filename as NSString).pathExtension.lowercased()
        if type.conforms(to: .image), !AttachmentBlock.imageExtensions.contains(ext) {
            return AttachmentPayload.picture(data, type: type)
        }
        return AttachmentPayload(filename: filename, mimeType: mimeType, bytes: data)
    }
}

extension ErrorMapping {
    static let droppedFileUnreadable = UserFacingError(
        code: "attachment.dropUnreadable",
        title: "Memry could not read a dropped file.",
        guidance: "Drop it again, or add it with Choose File.",
        recourse: .retry,
        isUserVisible: true
    )

    /// A batch's refusals in one alert: the first one's words, after how
    /// many of the files were not added.
    static func notAdded(_ refused: Int, of total: Int, _ first: UserFacingError) -> UserFacingError {
        let count = refused == 1 ? "1 of \(total) files wasn't added." : "\(refused) of \(total) files weren't added."
        return UserFacingError(
            code: first.code,
            title: first.title,
            guidance: [count, first.guidance].compactMap(\.self).joined(separator: " "),
            recourse: first.recourse,
            isUserVisible: true
        )
    }

    /// Notes a drag carried that this vault does not list, so no link went in.
    static func notesNotLinked(_ count: Int) -> UserFacingError {
        UserFacingError(
            code: "editor.dropNoteMissing",
            title: count == 1 ? "A dropped note isn't in this vault." : "\(count) dropped notes aren't in this vault.",
            guidance: "Only notes from this vault can be linked.",
            recourse: .blocked,
            isUserVisible: true
        )
    }
}
