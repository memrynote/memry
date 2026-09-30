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

// MARK: - The value

/// One of desktop's twelve cover washes (`COVER_WASHES`): a matte pigment
/// pair painted as a diagonal gradient. Order and colours match desktop, and
/// the order matters: `forSeed` indexes into it.
enum NoteCoverWash: String, CaseIterable, Identifiable, Sendable {
    case sage, sand, lilac, clay, ash, fog, wheat, moss, slate, bark, mist, plum

    var id: String { rawValue }

    /// `from` and `to` of the gradient, as desktop's hex pairs.
    var stops: (from: UInt32, to: UInt32) {
        switch self {
        case .sage: (0xDF_E7_E3, 0xB9_CC_C4)
        case .sand: (0xEF_E9_DD, 0xD6_C9_B0)
        case .lilac: (0xE4_E2_EA, 0xC2_BD_D1)
        case .clay: (0xEC_E3_E1, 0xD2_B8_B2)
        case .ash: (0xE8_E6_DF, 0xBF_BC_B2)
        case .fog: (0xD9_E0_E6, 0x9F_B0_BD)
        case .wheat: (0xF0_EC_E2, 0xC9_B9_8F)
        case .moss: (0xDB_E3_DA, 0xA3_B5_9C)
        case .slate: (0x2F_34_36, 0x5B_64_67)
        case .bark: (0xE9_E4_DE, 0xA8_9B_8C)
        case .mist: (0xE6_E9_EA, 0xB4_C2_C4)
        case .plum: (0xDC_D3_E0, 0x84_76_9A)
        }
    }

    /// The name desktop's picker gives it (`cover.picker.wash.*`).
    var name: String { rawValue.capitalized }

    /// The frontmatter value: `wash:sage`.
    var ref: String { "wash:\(rawValue)" }

    var gradient: LinearGradient {
        LinearGradient(
            colors: [
                Color(uiColor: AdaptiveColor.RGB(hex: stops.from).uiColor),
                Color(uiColor: AdaptiveColor.RGB(hex: stops.to).uiColor),
            ],
            // 135deg: top-leading to bottom-trailing.
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    /// Desktop's `coverWashForSeed`: a wash picked from a note id, so a note
    /// whose picture is missing paints the same colour on every device. The
    /// hash runs over UTF-16 units, as `charCodeAt` does.
    static func forSeed(_ seed: String) -> NoteCoverWash {
        var hash: UInt32 = 0
        for unit in seed.utf16 {
            hash = hash &* 31 &+ UInt32(unit)
        }
        return allCases[Int(hash % UInt32(allCases.count))]
    }
}

/// A parsed cover. Parsed once, the way desktop's `parseCoverValue` is, so no
/// view re-decides what a raw ref means.
struct NoteCoverValue: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// A vault path or an http(s) URL.
        case image(String)
        case wash(NoteCoverWash)
    }

    /// The raw `cover` value, written back unchanged on a reposition.
    let ref: String
    let kind: Kind
    /// Vertical focus of an image, 0 (top) to 100 (bottom).
    let focus: Int
    let credit: String?
    let creditUrl: URL?

    /// The centre, desktop's `DEFAULT_COVER_FOCUS`.
    static let defaultFocus = 50

    /// Desktop's `COVER_IMAGE_EXTENSIONS`.
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]

    /// Reads `NoteMetadata.coverJson`. `nil` for no cover and for a ref
    /// desktop would not read as one, except a `legacy` cover (an older iOS
    /// build's `coverImage`), whose picture is taken whatever its extension.
    static func of(_ json: String?) -> NoteCoverValue? {
        guard
            let json,
            let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
            let fields = object as? [String: Any],
            let ref = fields["ref"] as? String,
            let kind = (fields["legacy"] as? Bool == true) ? legacyKind(of: ref) : kind(of: ref)
        else { return nil }
        let focus = (fields["focus"] as? NSNumber).map { clampFocus($0.doubleValue) }
        let credit = (fields["credit"] as? String).flatMap {
            $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0
        }
        let creditUrl = (fields["creditUrl"] as? String).flatMap { isHTTP($0) ? URL(string: $0) : nil }
        return NoteCoverValue(
            ref: ref,
            kind: kind,
            focus: focus ?? defaultFocus,
            // Desktop shows a credit only with its link.
            credit: creditUrl == nil ? nil : credit,
            creditUrl: credit == nil ? nil : creditUrl
        )
    }

    /// Desktop's `parseCoverValue`: a known wash, an http(s) URL, or a path
    /// ending in an image extension. Anything else is prose, not a cover.
    static func kind(of ref: String) -> Kind? {
        if ref.hasPrefix("wash:") {
            return NoteCoverWash(rawValue: String(ref.dropFirst("wash:".count))).map(Kind.wash)
        }
        guard !ref.isEmpty else { return nil }
        if isHTTP(ref) { return .image(ref) }
        let path = ref.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? ""
        let ext = (path as NSString).pathExtension.lowercased()
        return imageExtensions.contains(ext) ? .image(ref) : nil
    }

    /// An older iOS build's `coverImage` url: any picture it attached, HEIC
    /// included, so no extension gate. It never wrote a wash.
    static func legacyKind(of ref: String) -> Kind? {
        ref.isEmpty ? nil : .image(ref)
    }

    /// Desktop's `clampCoverFocus`.
    static func clampFocus(_ value: Double) -> Int {
        guard value.isFinite else { return defaultFocus }
        return Int(min(100, max(0, value.rounded())))
    }

    private static func isHTTP(_ value: String) -> Bool {
        let lowered = value.lowercased()
        return lowered.hasPrefix("http://") || lowered.hasPrefix("https://")
    }
}

/// Where a cover picture's bytes live on this device.
enum NoteCoverSource: Equatable, Sendable {
    /// A link, drawn straight from the web as desktop draws it.
    case remote(URL)
    /// A note attachment: the note whose references hold it, and the url the
    /// core's block resolver binds by basename.
    case attachment(ownerNoteId: String, url: String)

    /// Resolves an image ref against the note that carries it.
    ///
    /// `attachments/<owner>/<file>`, alone or behind `../` segments, names the
    /// owning note: a cover desktop picked from another note's images lives in
    /// that note's references. Any other relative path binds against this
    /// note, as a block's url does.
    static func of(_ ref: String, noteId: String) -> NoteCoverSource? {
        let lowered = ref.lowercased()
        if lowered.hasPrefix("http://") || lowered.hasPrefix("https://") {
            return URL(string: ref).map(Self.remote)
        }
        let decoded = ref.removingPercentEncoding ?? ref
        let segments = decoded.replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/").map(String.init)
        if let index = segments.lastIndex(of: "attachments"),
           segments.count - index >= 3,
           let file = segments.last
        {
            return .attachment(ownerNoteId: segments[index + 1], url: file)
        }
        return .attachment(ownerNoteId: noteId, url: ref)
    }
}

/// Turning a picked picture into a cover upload.
enum NoteCoverUpload {
    /// The formats desktop draws as a cover and every Memry client can show.
    /// Anything else (HEIC from the camera roll, TIFF, a RAW) is re-encoded as
    /// JPEG: desktop's value gate would read `cover: x.heic` as a text
    /// property, and its renderer cannot draw one.
    static let keptExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]

    struct Prepared: Equatable {
        let filename: String
        let mimeType: String
        let bytes: Data
    }

    /// - Parameters:
    ///   - fileExtension: the picked item's own extension, if it has one.
    ///   - stamp: the unique part of the filename. A fresh name per cover,
    ///     because desktop writes an attachment under its manifest filename
    ///     and a name already in the note's folder would be written beside it
    ///     under another one, leaving the ref pointing at the wrong picture.
    /// - Returns: `nil` when the bytes are not a picture this device can read.
    static func prepare(bytes: Data, fileExtension: String?, stamp: String) -> Prepared? {
        let ext = fileExtension?.lowercased() ?? ""
        if keptExtensions.contains(ext), UIImage(data: bytes) != nil {
            let normalized = ext == "jpeg" ? "jpg" : ext
            return Prepared(
                filename: "cover-\(stamp).\(normalized)",
                mimeType: UTType(filenameExtension: normalized)?.preferredMIMEType ?? "image/\(normalized)",
                bytes: bytes
            )
        }
        guard let image = UIImage(data: bytes), let jpeg = image.jpegData(compressionQuality: 0.85)
        else { return nil }
        return Prepared(filename: "cover-\(stamp).jpg", mimeType: "image/jpeg", bytes: jpeg)
    }

    /// The ref to store: the path desktop resolves for this note's attachment.
    static func ref(noteId: String, filename: String) -> String {
        "attachments/\(noteId)/\(filename)"
    }

    static func stamp(at date: Date = .now) -> String {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withYear, .withMonth, .withDay, .withTime]
        let suffix = UUID().uuidString.prefix(6).lowercased()
        return "\(format.string(from: date).replacingOccurrences(of: ":", with: "-"))-\(suffix)"
    }
}

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

// MARK: - Choosing a cover

/// Desktop's cover picker, adapted: washes, a photo from the library, and a
/// picture from Files. Desktop's Unsplash and link tabs download through its
/// main process and have no counterpart here.
struct NoteCoverPickerSheet: View {
    let noteId: String
    let current: NoteCoverValue?
    let composer: NoteAttachmentComposer
    let apply: (String) -> Void
    let remove: (() -> Void)?
    let cancel: () -> Void

    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    @State private var unreadable = false

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: Tokens.Space.small),
        count: 4
    )

    var body: some View {
        NavigationStack {
            List {
                if composer.canUpload {
                    Section {
                        PhotosPicker(selection: $photo, matching: .images) {
                            Label("Choose from Photos", systemImage: "photo.on.rectangle")
                        }
                        Button {
                            importing = true
                        } label: {
                            Label("Choose from Files", systemImage: "folder")
                        }
                        status
                    }
                    .disabled(composer.isBusy)
                }

                Section("Washes") {
                    LazyVGrid(columns: columns, spacing: Tokens.Space.small) {
                        ForEach(NoteCoverWash.allCases) { wash in
                            Button {
                                apply(wash.ref)
                            } label: {
                                RoundedRectangle(cornerRadius: Tokens.Radius.control)
                                    .fill(wash.gradient)
                                    .frame(minHeight: Tokens.Size.minimumHitArea)
                                    .aspectRatio(1.4, contentMode: .fit)
                                    .overlay {
                                        if current?.kind == .wash(wash) {
                                            RoundedRectangle(cornerRadius: Tokens.Radius.control)
                                                .strokeBorder(Tokens.Line.focus.color, lineWidth: 2)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(wash.name) wash")
                            .accessibilityAddTraits(current?.kind == .wash(wash) ? .isSelected : [])
                        }
                    }
                    .padding(.vertical, Tokens.Space.tight)
                }

                if let remove {
                    Section {
                        Button("Remove cover", role: .destructive, action: remove)
                    }
                }
            }
            .navigationTitle("Note cover")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task { await upload(photo: item) }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
            guard case let .success(url) = result else { return }
            Task { await upload(file: url) }
        }
    }

    @ViewBuilder
    private var status: some View {
        switch composer.state {
        case .reading, .uploading:
            ProgressView { Text("Uploading the cover") }
                .font(Tokens.Typography.supporting.font)
        case let .failed(error):
            Text(error.title)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Interaction.destructive.color)
        case .idle:
            if unreadable {
                Text("That file is not a picture Memry can use as a cover.")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Interaction.destructive.color)
            }
        }
    }

    private func upload(photo item: PhotosPickerItem) async {
        defer { photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            unreadable = true
            return
        }
        await upload(bytes: data, fileExtension: item.supportedContentTypes.first?.preferredFilenameExtension)
    }

    /// The security-scoped dance a `fileImporter` url needs, stopped even when
    /// the read throws.
    private func upload(file url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            unreadable = true
            return
        }
        await upload(bytes: data, fileExtension: url.pathExtension)
    }

    private func upload(bytes: Data, fileExtension: String?) async {
        unreadable = false
        guard let prepared = NoteCoverUpload.prepare(
            bytes: bytes,
            fileExtension: fileExtension,
            stamp: NoteCoverUpload.stamp()
        ) else {
            unreadable = true
            return
        }
        // The attachment first, then the ref: a ref to a file no device can
        // fetch paints a wash everywhere.
        guard await composer.upload(
            filename: prepared.filename,
            mimeType: prepared.mimeType,
            bytes: prepared.bytes
        ) != nil else { return }
        apply(NoteCoverUpload.ref(noteId: noteId, filename: prepared.filename))
    }
}

/// Choosing which part of a tall picture the band keeps. A slider rather than
/// desktop's drag, so it works with VoiceOver and a switch.
struct NoteCoverRepositionSheet: View {
    let cover: NoteCoverValue
    let noteId: String
    let reader: any NotesReading
    let filler: (any VaultFilling)?
    let reachability: (any Reachability)?
    let save: (Int) -> Void
    let cancel: () -> Void

    @State private var focus: Double

    init(
        cover: NoteCoverValue,
        noteId: String,
        reader: any NotesReading,
        filler: (any VaultFilling)?,
        reachability: (any Reachability)?,
        save: @escaping (Int) -> Void,
        cancel: @escaping () -> Void
    ) {
        self.cover = cover
        self.noteId = noteId
        self.reader = reader
        self.filler = filler
        self.reachability = reachability
        self.save = save
        self.cancel = cancel
        _focus = State(initialValue: Double(cover.focus))
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                NoteCoverBand(
                    cover: cover,
                    noteId: noteId,
                    reader: reader,
                    filler: filler,
                    reachability: reachability,
                    focus: NoteCoverValue.clampFocus(focus)
                )
                .clipShape(.rect(cornerRadius: Tokens.Radius.control))

                Slider(value: $focus, in: 0...100, step: 1) {
                    Text("Vertical position")
                } minimumValueLabel: {
                    Text("Top").font(Tokens.Typography.caption.font)
                } maximumValueLabel: {
                    Text("Bottom").font(Tokens.Typography.caption.font)
                }
                .accessibilityLabel("Vertical position of the cover")
                .accessibilityValue("\(Int(focus)) percent from the top")

                Spacer()
            }
            .padding(Tokens.Space.screenInline)
            .navigationTitle("Reposition")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(NoteCoverValue.clampFocus(focus)) }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
