import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The paperclip's and the catalog's sources: photos, videos, camera, files,
/// audio and the document scanner. Each ends in the composer's one upload
/// call (N214), then the attachment's block goes into the body after the
/// caret's block, in the shape desktop writes (`AttachmentBlock`).
struct EditorAttachmentSources: ViewModifier {
    @Binding var source: EditorAttachmentSource?
    let composer: NoteAttachmentComposer
    let session: EditorSession

    @State private var photo: PhotosPickerItem?

    func body(content: Content) -> some View {
        content
            // One picker of each kind, narrowed by the source: a second
            // `photosPicker` or `fileImporter` on the same view never presents.
            .photosPicker(
                isPresented: showing(.photos, .videos),
                selection: $photo,
                matching: source == .videos ? .videos : .images,
                // H.264 rather than HEVC, which desktop's player may not decode.
                preferredItemEncoding: source == .videos ? .compatible : .automatic
            )
            .onChange(of: photo) { _, picked in
                guard let picked else { return }
                photo = nil
                Task {
                    guard let data = try? await picked.loadTransferable(type: Data.self) else { return }
                    let type = picked.supportedContentTypes.first
                    await upload(type?.conforms(to: .movie) == true
                        ? AttachmentPayload.video(data, type: type)
                        : AttachmentPayload.picture(data, type: type))
                }
            }
            .fileImporter(
                isPresented: showing(.files, .audio),
                allowedContentTypes: source == .audio ? [.audio] : [.item]
            ) { result in
                guard case let .success(url) = result else { return }
                Task { await upload(contentsOf: url) }
            }
            .fullScreenCover(isPresented: showing(.camera)) {
                InboxCameraPicker { data in
                    Task { await upload(AttachmentPayload.picture(data, type: .jpeg)) }
                }
                .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: showing(.scan)) {
                NoteDocumentScanner { pages in
                    Task {
                        // Drawing every page into a PDF is too slow for the main thread.
                        guard let payload = await Task.detached(operation: { AttachmentPayload.scan(pages) }).value
                        else { return }
                        await upload(payload)
                    }
                }
                .ignoresSafeArea()
            }
    }

    private func showing(_ which: EditorAttachmentSource...) -> Binding<Bool> {
        Binding(
            get: { source.map(which.contains) ?? false },
            set: { if !$0, let source, which.contains(source) { self.source = nil } }
        )
    }

    /// Uploads under a prefixed name, as desktop saves every attachment, so a
    /// second `photo-<second>.jpg` or `report.pdf` in the same note does not
    /// overwrite the first.
    private func upload(_ payload: AttachmentPayload) async {
        let filename = AttachmentFilename.unique(payload.filename)
        guard await composer.upload(filename: filename, mimeType: payload.mimeType, bytes: payload.bytes) != nil
        else { return }
        session.insertAttachment(AttachmentBlock.make(
            noteId: composer.noteId, filename: filename, mimeType: payload.mimeType, size: payload.bytes.count
        ))
    }

    private func upload(contentsOf url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = await Task.detached(operation: { try? Data(contentsOf: url) }).value else {
            Log.sync.error("a picked file could not be read")
            return
        }
        await upload(AttachmentPayload(
            filename: url.lastPathComponent, mimeType: NoteAttachmentComposer.mimeType(for: url), bytes: data
        ))
    }
}

/// Desktop's `generateUniqueFilename` (`apps/desktop/src/main/vault/attachments.ts`):
/// `{6-char-prefix}-{sanitized-name}{ext}`.
enum AttachmentFilename {
    private static let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")

    static func unique(_ original: String, prefix: String = randomPrefix()) -> String {
        let name = original as NSString
        // `path.extname`: from the last dot, unless the dot starts the name.
        let dot = name.range(of: ".", options: .backwards)
        let hasExtension = dot.location != NSNotFound && dot.location > 0
        let ext = hasExtension ? name.substring(from: dot.location) : ""
        let baseName = hasExtension ? name.substring(to: dot.location) : original
        // Spaces and parens break markdown image links, and braces would end
        // a `<!-- file:{...} -->` marker early; desktop keeps them out.
        var sanitized = sanitize(baseName)
            .replacingOccurrences(of: "[\\s(){}]+", with: "-", options: .regularExpression)
            .replacingOccurrences(of: "-{2,}", with: "-", options: .regularExpression)
            .replacingOccurrences(of: "^-|-$", with: "", options: .regularExpression)
        if sanitized.isEmpty { sanitized = "file" }
        return "\(prefix)-\(sanitized)\(ext)"
    }

    /// Desktop's `customAlphabet('0-9a-z', 6)`.
    static func randomPrefix() -> String {
        String((0..<6).map { _ in alphabet.randomElement() ?? "0" })
    }

    /// Desktop's vault `sanitizeFilename` (`file-ops.ts`).
    static func sanitize(_ filename: String) -> String {
        var out = filename
            .replacingOccurrences(of: "[<>:\"/\\\\|?*\\[\\]#^]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        while out.hasPrefix(".") { out = String(out.dropFirst()).trimmingCharacters(in: .whitespaces) }
        if out.isEmpty { out = "untitled" }
        return String(out.prefix(200))
    }
}
