import Foundation
import UniformTypeIdentifiers

// #4357. Files dropped on a note's block go through the pickers' one upload
// (`attach`), so the core and the server hold them to the same limits, and a
// refusal shows the same alert (`EditorAttachmentSources`).

extension NoteAttachmentComposer {
    /// Uploads under a prefixed name, as desktop saves every attachment, so a
    /// second `photo-<second>.jpg` or `report.pdf` in the same note does not
    /// overwrite the first, then inserts the block after `blockId` (`nil`:
    /// the caret's block). `false` when the upload failed and says so.
    @discardableResult
    func attach(_ payload: AttachmentPayload, in session: EditorSession, after blockId: String?) async -> Bool {
        let filename = AttachmentFilename.unique(payload.filename)
        guard await upload(filename: filename, mimeType: payload.mimeType, bytes: payload.bytes) != nil
        else { return false }
        session.insertAttachment(
            AttachmentBlock.make(noteId: noteId, filename: filename, mimeType: payload.mimeType, size: payload.bytes.count),
            after: blockId
        )
        return true
    }

    /// Each dropped file into a block after `blockId`, in drop order. The
    /// first refusal stops the rest, so its alert is the one shown.
    func attachDropped(_ providers: [NSItemProvider], in session: EditorSession, after blockId: String) async {
        // Last first: each lands right after the block, ahead of those before it.
        for provider in providers.reversed() {
            guard let type = EditorDrop.fileType(of: provider) else { continue }
            beginReading()
            guard let payload = await Self.payload(provider, type: type) else {
                Log.sync.error("a dropped file could not be read")
                endReading()
                continue
            }
            guard await attach(payload, in: session, after: blockId) else { return }
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
