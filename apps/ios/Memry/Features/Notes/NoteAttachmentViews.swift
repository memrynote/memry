import AVKit
import MemryCore
import QuickLook
import SwiftUI

// Attachments in a note body: pictures with their real bytes, and files,
// audio and video that open.
//
// **A block does not name an attachment id.** It carries a `url` that desktop
// resolves as a vault-relative path, and the phone has no vault file tree, so
// the core binds the two by the basename of the signed manifest's filename
// (`research.md` §Q4). This screen only renders the four answers that bind can
// return, and the two that are not a file are drawn differently on purpose:
//
// - `remote` is ordinary content, not a failed download. Desktop refuses to
//   resolve `https:` against the vault and calls it exactly that, so a remote
//   image loads as a web resource rather than showing "missing".
// - `ambiguous` means one note holds two attachments with the same basename.
//   Desktop cannot tell them apart either — both materialise to one path and
//   one overwrites the other — so picking one risks showing the WRONG picture,
//   which is worse than showing none.
//
// **A placeholder is a statement, not a gap.** FR-045 requires a picture whose
// bytes have not arrived to show a placeholder and to become visible on
// arrival *without the note being recreated*. The views read their answer
// through a closure rather than caching it, so a re-resolve after a download
// re-renders in place.

/// A picture block.
struct NoteImageView: View {
    let url: String?
    let name: String?
    let caption: String?
    /// The width desktop last gave it, used as a ceiling rather than a size:
    /// a phone is narrower than the window that chose it.
    let previewWidth: Double?
    var resolve: ((String) -> BlockAttachment)?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            picture
            if let caption, !caption.isEmpty {
                Text(caption)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var picture: some View {
        switch NoteAttachmentBinding.of(url, resolve) {
        case let .file(path, label):
            LocalImage(path: path, label: label, maxWidth: previewWidth)
        case let .remote(address):
            RemoteImage(address: address, label: label)
        case .waiting:
            AttachmentPlaceholder(
                symbol: "photo",
                label: label,
                detail: "Not downloaded yet"
            )
        case .ambiguous:
            // Named rather than guessed. The user can see which picture is
            // meant; this build cannot, and drawing the wrong one silently
            // would be worse than saying so.
            AttachmentPlaceholder(
                symbol: "questionmark.square.dashed",
                label: label,
                detail: "Two attachments share this name"
            )
        }
    }

    private var label: String {
        if let name, !name.isEmpty { return name }
        if let url, !url.isEmpty { return NoteAttachmentBinding.basename(url) }
        return "A picture"
    }
}

/// A file, audio or video block.
struct NoteAttachmentView: View {
    let kind: String
    let url: String?
    let name: String?
    let size: String?
    let caption: String?
    var resolve: ((String) -> BlockAttachment)?

    @State private var previewing: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            content
            if let caption, !caption.isEmpty {
                Text(caption)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch NoteAttachmentBinding.of(url, resolve) {
        case let .file(path, _):
            if kind == "audio" || kind == "video" {
                // A real player, because a recording in a note is meant to be
                // listened to in place. Video keeps its aspect ratio rather
                // than a fixed box, so a portrait clip is not letterboxed.
                VideoPlayer(player: AVPlayer(url: path))
                    .frame(height: kind == "audio" ? 80 : 220)
                    .clipShape(.rect(cornerRadius: Tokens.Radius.card))
                    .accessibilityLabel("\(label), \(kind)")
            } else {
                Button { previewing = path } label: {
                    AttachmentCard(symbol: symbol, label: label, detail: measured ?? "Open")
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isButton)
                .quickLookPreview($previewing)
            }
        case let .remote(address):
            LinkCardRowPublic(url: address, title: label, subtitle: measured, symbol: symbol)
        case .waiting:
            AttachmentPlaceholder(
                symbol: symbol,
                label: label,
                detail: measured.map { "\($0) · not downloaded yet" } ?? "Not downloaded yet"
            )
        case .ambiguous:
            AttachmentPlaceholder(
                symbol: "questionmark.square.dashed",
                label: label,
                detail: "Two attachments share this name"
            )
        }
    }

    private var symbol: String {
        switch kind {
        case "audio": "waveform"
        case "video": "film"
        default: "doc"
        }
    }

    private var label: String {
        if let name, !name.isEmpty { return name }
        if let url, !url.isEmpty { return NoteAttachmentBinding.basename(url) }
        return "A file"
    }

    /// Bytes, in the units a person uses. Absent rather than guessed when the
    /// prop carries nothing — "0 KB" would be a claim about the file.
    private var measured: String? {
        guard let size, let bytes = Int64(size), bytes > 0 else { return nil }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

/// The four answers, flattened for a view to switch over.
enum NoteAttachmentBinding: Equatable {
    case file(URL, String)
    case remote(String)
    case waiting
    case ambiguous

    /// Resolves a block url, or reports `waiting` when nothing can.
    static func of(_ url: String?, _ resolve: ((String) -> BlockAttachment)?) -> Self {
        guard let url, !url.isEmpty, let resolve else { return .waiting }
        switch resolve(url) {
        case let .remote(address):
            return .remote(address)
        case let .bound(attachment):
            // A bound attachment whose bytes are not on disk is still waiting:
            // the reference is known, the file is not here yet.
            guard let path = attachment.localPath, !path.isEmpty else { return .waiting }
            return .file(AttachmentPaths.url(for: path), attachment.filename ?? path)
        case .unknown:
            return .waiting
        case .ambiguous:
            return .ambiguous
        }
    }

    static func basename(_ path: String) -> String {
        path.replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/")
            .last
            .map(String.init) ?? path
    }
}

/// Where the core writes attachment bytes.
///
/// The row stores a path **relative** to the vault's `images/` directory,
/// because an iOS sandbox container moves between launches and an absolute
/// path stored today is a dangling path tomorrow. The absolute form is
/// rebuilt here, every time, from the container as it is now.
enum AttachmentPaths {
    /// Set once by the composition root, when a vault is opened.
    nonisolated(unsafe) static var imagesDirectory: URL?

    static func url(for relativePath: String) -> URL {
        let base = imagesDirectory ?? URL.temporaryDirectory
        return base.appending(path: relativePath)
    }
}

// MARK: - the pieces

private struct LocalImage: View {
    let path: URL
    let label: String
    let maxWidth: Double?

    var body: some View {
        if let image = UIImage(contentsOfFile: path.path(percentEncoded: false)) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: maxWidth.map { CGFloat($0) } ?? .infinity)
                .clipShape(.rect(cornerRadius: Tokens.Radius.card))
                .accessibilityLabel(label)
        } else {
            // The row says the bytes are here and they would not decode: a
            // truncated write, or a format this platform does not read. Said
            // plainly rather than drawn as an empty box.
            AttachmentPlaceholder(
                symbol: "exclamationmark.triangle",
                label: label,
                detail: "This picture could not be opened"
            )
        }
    }
}

private struct RemoteImage: View {
    let address: String
    let label: String

    var body: some View {
        AsyncImage(url: URL(string: address)) { phase in
            switch phase {
            case let .success(image):
                image
                    .resizable()
                    .scaledToFit()
                    .clipShape(.rect(cornerRadius: Tokens.Radius.card))
                    .accessibilityLabel(label)
            case .failure:
                AttachmentPlaceholder(
                    symbol: "photo",
                    label: label,
                    detail: "This picture is on the web and did not load"
                )
            default:
                AttachmentPlaceholder(symbol: "photo", label: label, detail: "Loading")
            }
        }
    }
}

/// The block is here and the bytes are not, said in words.
struct AttachmentPlaceholder: View {
    let symbol: String
    let label: String
    let detail: String

    var body: some View {
        AttachmentCard(symbol: symbol, label: label, detail: detail)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(label), \(detail)")
    }
}

struct AttachmentCard: View {
    let symbol: String
    let label: String
    let detail: String

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(label)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .lineLimit(2)
                Text(detail)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            Spacer(minLength: 0)
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.card)
                .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
        )
    }
}

/// A card that opens an address, for a remote attachment.
struct LinkCardRowPublic: View {
    let url: String
    let title: String
    let subtitle: String?
    let symbol: String

    var body: some View {
        if let destination = URL(string: url) {
            Link(destination: destination) {
                AttachmentCard(symbol: symbol, label: title, detail: subtitle ?? url)
            }
            .accessibilityAddTraits(.isLink)
        } else {
            AttachmentCard(symbol: symbol, label: title, detail: subtitle ?? url)
        }
    }
}
