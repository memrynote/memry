import MemryCore
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// A note's cover band (N703), ported from desktop's `note-cover.tsx`,
// `cover-picker-dialog.tsx` and `packages/shared/src/cover-image.ts`.
//
// **Stored where desktop stores it.** The core reads and writes the payload's
// `cover` field (chapter 13 §13.7.1.1), which desktop writes to the note's
// frontmatter keys `cover`, `coverFocus`, `coverCredit` and `coverCreditUrl`.
// `NoteMetadata.coverJson` carries it here as `{ref, focus?, credit?,
// creditUrl?}`.
//
// **A picture is a note attachment.** It goes up through the same upload as
// a picture block, which lists it in the note's `attachmentReferences`, and
// the ref is `attachments/<noteId>/<file>`: the path desktop materialises an
// attachment at and resolves as root-relative for the owning note.

// MARK: - The band

/// The cover above a note's title, and the affordance to add one.
///
/// Shown as desktop shows it: an image cropped to the band at its stored
/// focus, a wash as its gradient, and a picture that is missing or still
/// downloading as the wash keyed off the note id, never a broken frame.
struct NoteCoverSection: View {
    let noteId: String
    let coverJson: String?
    let reader: any NotesReading
    let filler: (any VaultFilling)?
    let reachability: (any Reachability)?
    let metadataModel: NoteMetadataViewModel
    let composer: NoteAttachmentComposer
    /// Re-reads the note after a write.
    let reload: () async -> Void
    /// The host's inline padding, which the band reaches past so it spans the
    /// screen as desktop's spans the window.
    var bleed: CGFloat = 0

    @Environment(\.requestVaultSync) private var requestVaultSync

    @State private var picking = false
    @State private var repositioning = false

    private var cover: NoteCoverValue? { NoteCoverValue.of(coverJson) }

    var body: some View {
        if let cover {
            NoteCoverBand(
                cover: cover,
                noteId: noteId,
                reader: reader,
                filler: filler,
                reachability: reachability
            )
            .overlay(alignment: .bottomTrailing) {
                if metadataModel.canEdit { menu(for: cover) }
            }
            .overlay(alignment: .bottomLeading) { credit(for: cover) }
            .padding(.horizontal, -bleed)
            .sheet(isPresented: $picking) { picker(current: cover) }
            .sheet(isPresented: $repositioning) {
                NoteCoverRepositionSheet(
                    cover: cover,
                    noteId: noteId,
                    reader: reader,
                    filler: filler,
                    reachability: reachability,
                    save: { focus in
                        repositioning = false
                        // Only a changed focus writes: a write dirties the
                        // note, and a dirty note syncs.
                        guard focus != cover.focus else { return }
                        write(ref: cover.ref, focus: focus)
                    },
                    cancel: { repositioning = false }
                )
            }
        } else if metadataModel.canEdit {
            Button {
                picking = true
            } label: {
                Label("Add cover", systemImage: "photo")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .sheet(isPresented: $picking) { picker(current: nil) }
        }
    }

    private func menu(for cover: NoteCoverValue) -> some View {
        Menu {
            Button {
                picking = true
            } label: {
                Label("Change cover", systemImage: "photo")
            }
            if case .image = cover.kind {
                Button {
                    repositioning = true
                } label: {
                    Label("Reposition", systemImage: "arrow.up.and.down")
                }
            }
            Divider()
            Button(role: .destructive) {
                write(ref: nil, focus: cover.focus)
            } label: {
                Label("Remove cover", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(Tokens.Typography.body.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .background(.regularMaterial, in: .circle)
                .contentShape(.circle)
        }
        .padding(Tokens.Space.small)
        .accessibilityLabel("Cover options")
    }

    @ViewBuilder
    private func credit(for cover: NoteCoverValue) -> some View {
        if let name = cover.credit, let url = cover.creditUrl {
            Link(destination: url) {
                Text("Photo by \(name) on Unsplash")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .padding(.horizontal, Tokens.Space.small)
                    .padding(.vertical, Tokens.Space.tight)
                    .background(.regularMaterial, in: .rect(cornerRadius: Tokens.Radius.small))
            }
            .padding(Tokens.Space.small)
        }
    }

    private func picker(current: NoteCoverValue?) -> some View {
        let remove: (() -> Void)? = current == nil ? nil : {
            picking = false
            write(ref: nil, focus: NoteCoverValue.defaultFocus)
        }
        return NoteCoverPickerSheet(
            noteId: noteId,
            current: current,
            composer: composer,
            apply: { ref in
                picking = false
                write(ref: ref, focus: NoteCoverValue.defaultFocus)
            },
            remove: remove,
            cancel: { picking = false }
        )
    }

    private func write(ref: String?, focus: Int) {
        Task {
            await metadataModel.setCover(url: ref, offsetY: Double(focus) / 100)
            requestVaultSync?()
            await reload()
        }
    }
}

/// The band itself: a fixed-height strip, full width.
struct NoteCoverBand: View {
    let cover: NoteCoverValue
    let noteId: String
    let reader: any NotesReading
    let filler: (any VaultFilling)?
    let reachability: (any Reachability)?
    /// Overrides the stored focus while repositioning.
    var focus: Int?

    @State private var picture: NoteCoverPicture = .pending

    var body: some View {
        ZStack {
            switch (cover.kind, picture) {
            case (.image, .image(let image)):
                NoteCoverImage(image: image, focus: focus ?? cover.focus)
            case (.image, .remote(let url)):
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().aspectRatio(contentMode: .fill)
                    } else {
                        seedWash
                    }
                }
            case (.wash(let wash), _):
                Rectangle().fill(wash.gradient)
            default:
                seedWash
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: Tokens.Size.coverHeight)
        .clipped()
        .accessibilityElement()
        .accessibilityLabel(accessibilityLabel)
        .task(id: cover.ref) { await load() }
    }

    private var seedWash: some View {
        Rectangle().fill(NoteCoverWash.forSeed(noteId).gradient)
    }

    private var accessibilityLabel: String {
        switch (cover.kind, picture) {
        case let (.wash(wash), _): "Cover, \(wash.name) wash"
        case (.image, .waiting): "Cover image, still downloading"
        case (.image, .missing): "Cover image, not on this device"
        default: "Cover image"
        }
    }

    /// Resolves the picture, fetching its bytes once when they have not
    /// arrived, then re-resolving so it appears in place (FR-045).
    private func load() async {
        guard case let .image(ref) = cover.kind,
              let source = NoteCoverSource.of(ref, noteId: noteId)
        else { return }
        switch source {
        case let .remote(url):
            picture = .remote(url)
        case let .attachment(owner, url):
            picture = await resolve(owner: owner, url: url, fetching: true)
        }
    }

    private func resolve(owner: String, url: String, fetching: Bool) async -> NoteCoverPicture {
        let binding: BlockAttachment
        do {
            binding = try await reader.attachmentForBlock(id: owner, url: url)
        } catch {
            Log.storage.error("a cover could not be resolved", .code(ErrorMapping.userFacing(error).code))
            return .missing
        }
        guard case let .bound(attachment) = binding else { return .missing }
        if let path = attachment.localPath {
            let file = AttachmentPaths.url(for: path).path(percentEncoded: false)
            return UIImage(contentsOfFile: file).map(NoteCoverPicture.image) ?? .missing
        }
        guard fetching, let filler else { return .waiting }
        do {
            let summary = try await filler.fetchAttachment(
                attachmentId: attachment.attachmentId,
                reachable: reachability?.current() ?? PathReachability.unknownPath
            )
            // Deferred on a metered path is the policy working: the wash stays.
            guard summary.downloaded else { return .waiting }
        } catch {
            Log.sync.error("a cover could not be fetched", .code(ErrorMapping.userFacing(error).code))
            return .waiting
        }
        return await resolve(owner: owner, url: url, fetching: false)
    }
}

/// What the band has for an image cover.
enum NoteCoverPicture: Equatable {
    case pending
    case image(UIImage)
    case remote(URL)
    /// Bound, but the bytes are not on this device yet.
    case waiting
    /// Nothing in the vault answers to the ref.
    case missing
}

/// An image filling the band, cropped at a vertical focus the way CSS
/// `object-position: 50% <focus>%` crops it.
private struct NoteCoverImage: View {
    let image: UIImage
    let focus: Int

    var body: some View {
        GeometryReader { frame in
            let size = image.size
            let scale = max(
                frame.size.width / max(size.width, 1),
                frame.size.height / max(size.height, 1)
            )
            let width = size.width * scale
            let height = size.height * scale
            Image(uiImage: image)
                .resizable()
                .frame(width: width, height: height)
                .offset(
                    x: (frame.size.width - width) / 2,
                    y: (frame.size.height - height) * CGFloat(focus) / 100
                )
        }
    }
}
