import MemryCore
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

// Adding a picture or a file to a note (N214), and taking one away (N215).
//
// **Three sources, one path.** Photo library, camera and files all end as
// bytes plus a filename plus a mime type, and all go through the core's single
// upload call. A shell that split them would end up with three half-correct
// copies of the chunking rules, which is exactly what chapter 14 keeps in one
// place.
//
// **Progress is a state, not a percentage.** The core's upload is one call
// that either finishes or does not; it reports no per-chunk progress, and
// inventing a bar that moves on a timer would be a lie about where the bytes
// are. `DESIGN.md` prefers an honest indeterminate indicator to a fabricated
// determinate one.
//
// **Failures come back through `ErrorMapping`**, so an upload that fails
// because the keychain is locked says so rather than showing a raw Rust
// string.

/// What the sheet is doing.
enum AttachmentUploadState: Equatable {
    case idle
    case reading
    case uploading(String)
    case failed(UserFacingError)
}

/// Adds an attachment to a note.
@MainActor
@Observable
final class NoteAttachmentComposer {
    private let noteId: String
    private let filler: (any VaultFilling)?

    private(set) var state: AttachmentUploadState = .idle

    init(noteId: String, filler: (any VaultFilling)?) {
        self.noteId = noteId
        self.filler = filler
    }

    /// Whether this screen can offer to add anything at all.
    ///
    /// An affordance that leads nowhere is worse than its absence, so the
    /// button is hidden rather than disabled when there is no session.
    var canUpload: Bool { filler != nil }

    var isBusy: Bool {
        switch state {
        case .reading, .uploading: true
        default: false
        }
    }

    /// Uploads bytes already in memory.
    ///
    /// - Returns: the new attachment id, or `nil` when it failed. The caller
    ///   uses it to re-resolve the note's bindings so the picture appears
    ///   without the note being recreated.
    @discardableResult
    func upload(filename: String, mimeType: String, bytes: Data) async -> String? {
        guard let filler else { return nil }
        state = .uploading(filename)
        do {
            let id = try await filler.uploadAttachment(
                noteId: noteId,
                filename: filename,
                mimeType: mimeType,
                bytes: bytes
            )
            state = .idle
            return id
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("an attachment could not be uploaded", .code(mapped.code))
            state = .failed(mapped)
            return nil
        }
    }

    /// Reads a picked file and uploads it.
    ///
    /// The security-scoped dance is not optional for a `fileImporter` result:
    /// a url from outside the sandbox is unreadable without it, and the stop
    /// must happen even when the read throws.
    @discardableResult
    func upload(contentsOf url: URL) async -> String? {
        state = .reading
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("a picked file could not be read", .code(mapped.code))
            state = .failed(mapped)
            return nil
        }

        return await upload(
            filename: url.lastPathComponent,
            mimeType: Self.mimeType(for: url),
            bytes: data
        )
    }

    /// Detaches an attachment and releases its bytes.
    func detach(attachmentId: String) async -> Bool {
        guard let filler else { return false }
        do {
            try await filler.detachAttachment(noteId: noteId, attachmentId: attachmentId)
            return true
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("an attachment could not be removed", .code(mapped.code))
            state = .failed(mapped)
            return false
        }
    }

    func dismissFailure() { state = .idle }

    /// The platform's own answer, falling back to the one type that promises
    /// nothing rather than guessing from the extension.
    static func mimeType(for url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
    }

    /// A name for bytes that arrive without one, as a camera capture does.
    ///
    /// Timestamped rather than random: two pictures taken a minute apart sort
    /// the way the user took them, and the manifest's filename is what binds a
    /// block to an attachment (§Q4), so a readable name is worth keeping.
    static func capturedName(at date: Date = .now, extension ext: String = "jpg") -> String {
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withYear, .withMonth, .withDay, .withTime]
        return "photo-\(stamp.string(from: date).replacingOccurrences(of: ":", with: "-")).\(ext)"
    }
}

/// The add-attachment affordance for the note screen.
struct NoteAttachmentPicker: View {
    @Bindable var composer: NoteAttachmentComposer
    /// Called with the new attachment id so the note re-resolves in place.
    var onUploaded: (String) -> Void

    @State private var photo: PhotosPickerItem?
    @State private var showingFiles = false

    var body: some View {
        if composer.canUpload {
            Menu {
                PhotosPicker(selection: $photo, matching: .any(of: [.images, .videos])) {
                    Label("Photo library", systemImage: "photo.on.rectangle")
                }
                Button {
                    showingFiles = true
                } label: {
                    Label("Files", systemImage: "folder")
                }
            } label: {
                Label("Add attachment", systemImage: "paperclip")
            }
            .disabled(composer.isBusy)
            .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.item]) { result in
                guard case let .success(url) = result else { return }
                Task {
                    if let id = await composer.upload(contentsOf: url) { onUploaded(id) }
                }
            }
            .onChange(of: photo) { _, picked in
                guard let picked else { return }
                Task { await load(picked) }
            }
            .overlay(alignment: .trailing) { busy }
            .alert(
                failureTitle,
                isPresented: Binding(
                    get: { if case .failed = composer.state { true } else { false } },
                    set: { if !$0 { composer.dismissFailure() } }
                )
            ) {
                Button("OK", role: .cancel) { composer.dismissFailure() }
            } message: {
                if case let .failed(error) = composer.state { Text(error.guidance ?? "") }
            }
        }
    }

    /// Indeterminate on purpose: the core's upload reports no per-chunk
    /// progress, and a bar that moved on a timer would be a claim about where
    /// the bytes are.
    @ViewBuilder
    private var busy: some View {
        if composer.isBusy {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Uploading")
        }
    }

    private var failureTitle: String {
        if case let .failed(error) = composer.state { return error.title ?? "" }
        return ""
    }

    private func load(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let name = item.supportedContentTypes.first?.preferredFilenameExtension
            .map { NoteAttachmentComposer.capturedName(extension: $0) }
            ?? NoteAttachmentComposer.capturedName()
        let mime = item.supportedContentTypes.first?.preferredMIMEType
            ?? "application/octet-stream"
        if let id = await composer.upload(filename: name, mimeType: mime, bytes: data) {
            onUploaded(id)
        }
        photo = nil
    }
}
