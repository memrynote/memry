import MemryCore
import SwiftUI

// A binary note (#5668): a PDF, image, audio or video note has no body, and
// its content is one attachment the note names by `attachmentId`. The core
// says which notes are files (`Notes.file`) and fetches the bytes; the page
// draws them with the viewers an attachment block already uses.

extension NoteReadViewModel {
    /// Reads this note's own file. A failed read leaves the last answer: the
    /// note stays readable as what it was.
    func loadFile() async {
        do {
            file = try await reader.file(id: route.id)
        } catch {
            if Task.isCancelled { return }
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this note's file could not be read", .code(mapped.code))
        }
    }

    /// Downloads the file when the note opens, then re-reads it.
    ///
    /// Opening the note is the explicit ask, so the bytes come on any usable
    /// path whatever the Download attachments setting, as for the note's
    /// other attachments (#5644). Offline waits for the next pass.
    func fetchFile() async {
        guard let filler, let file, file.attachment?.localPath == nil, fileFetch != .fetching,
              (reachability?.current() ?? PathReachability.unknownPath) != .offline
        else { return }
        fileFetch = .fetching
        // Not cancelled with the screen's task, as `fetchBody` is not: a
        // download that lands after the page went away is still kept.
        await Task {
            do {
                _ = try await filler.fetchAttachment(attachmentId: file.attachmentId, reachable: .wifi)
                fileFetch = .idle
            } catch {
                let mapped = ErrorMapping.userFacing(error)
                Log.sync.error("a note's file could not be fetched", .code(mapped.code))
                fileFetch = .failed(mapped)
            }
        }.value
        await loadFile()
    }
}

/// A binary note's file, in place of a body.
struct NoteFileView: View {
    let file: NoteFile
    let fetch: NoteReadViewModel.Fetch
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if file.fileType == "image" {
                NoteImageView(url: name, name: name, caption: nil, previewWidth: nil, resolve: resolve)
            } else {
                NoteAttachmentView(
                    kind: file.fileType == "audio" || file.fileType == "video" ? file.fileType : "file",
                    url: name,
                    name: name,
                    size: nil,
                    mimeType: file.mimeType ?? file.attachment?.mimeType,
                    caption: nil,
                    resolve: resolve
                )
            }
            switch fetch {
            case .fetching:
                ProgressView { Text("Downloading") }
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
            case let .failed(error):
                ErrorNotice(error: error, code: nil)
                Button("Try again", action: retry)
                    .memrySecondaryAction()
            case .idle, .incomplete:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The manifest's filename once known, which also tells a PDF apart.
    private var name: String { file.attachment?.filename ?? file.attachmentId }

    private var resolve: (String) -> BlockAttachment {
        let attachment = file.attachment
        return { _ in attachment.map { .bound(attachment: $0) } ?? .unknown }
    }
}
