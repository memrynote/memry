import LinkPresentation
import MemryCore
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

// IB04 / IB05 / IB06. The "+" composer above the keyboard (Paper 04): the
// field, a Paste chip when the clipboard holds a link, the attach menu (Photo
// Library, Take Photo, Choose File), the mic, send (disabled while empty).
// A typed or pasted link shows its preview and, when a live capture already
// holds it, "Already captured" with Open it / Capture anyway (Paper 05). The
// mic swaps the field for the recorder (Paper 06).

struct InboxComposer: View {
    let store: InboxStore
    let close: () -> Void

    @Environment(InboxRouter.self) private var router
    @State private var text = ""
    @State private var duplicate: InboxItemRecord?
    @State private var preview: InboxLinkPreview?
    @State private var clipboardHasLink = false
    @State private var photo: PhotosPickerItem?
    @State private var showsPhotos = false
    @State private var showsCamera = false
    @State private var showsFiles = false
    @State private var recorder = InboxVoiceRecorder()
    @State private var sending = false
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            if let duplicate { duplicateNotice(duplicate) }
            if recorder.phase == .recording {
                InboxRecorderPanel(recorder: recorder, cancel: { recorder.cancel() }, stop: stopRecording)
            } else {
                TextField(InboxCopy.composerPlaceholder, text: $text, axis: .vertical)
                    .font(Tokens.Typography.body.font)
                    .lineLimit(1 ... 6)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit { Task { await send(force: false) } }
                    .accessibilityIdentifier("inbox.composer.field")
                if let preview { InboxInboxLinkPreviewCard(preview: preview) }
                controls
            }
        }
        .padding(Tokens.Space.inset)
        .chromeGlass(in: .rect(cornerRadius: Tokens.Radius.container))
        .padding(.horizontal, Tokens.Space.small)
        .padding(.bottom, Tokens.Space.small)
        .onAppear {
            focused = true
            clipboardHasLink = UIPasteboard.general.hasURLs
        }
        .task(id: trimmed) { await inspect() }
        .photosPicker(isPresented: $showsPhotos, selection: $photo, matching: .images)
        .onChange(of: photo) { _, item in if let item { Task { await capturePhoto(item) } } }
        .fileImporter(
            isPresented: $showsFiles,
            allowedContentTypes: [.image, .audio, .movie, .pdf],
            allowsMultipleSelection: false
        ) { result in
            if case let .success(urls) = result, let url = urls.first { Task { await captureFile(url) } }
        }
        .fullScreenCover(isPresented: $showsCamera) {
            InboxCameraPicker { data in Task { await captureData(data, name: InboxComposer.photoName(), mime: "image/jpeg") } }
                .ignoresSafeArea()
        }
        .alert(InboxCopy.microphoneTitle, isPresented: Binding(
            get: { recorder.phase == .denied || recorder.phase == .failed },
            set: { if !$0 { recorder.cancel() } }
        )) {
            Button(InboxCopy.done, role: .cancel) {}
        } message: {
            Text(recorder.phase == .denied ? InboxErrors.microphoneDenied.text : InboxErrors.noMicrophone.text)
        }
        .accessibilityIdentifier("inbox.composer")
    }

    private var controls: some View {
        HStack(spacing: Tokens.Space.small) {
            if clipboardHasLink, trimmed.isEmpty {
                Button {
                    if let url = UIPasteboard.general.url ?? UIPasteboard.general.string.flatMap(URL.init(string:)) {
                        text = url.absoluteString
                    }
                } label: {
                    Label(InboxCopy.pasteLink, systemImage: "link")
                        .font(Tokens.Typography.supporting.font)
                        .padding(.horizontal, Tokens.Space.medium)
                        .frame(minHeight: Tokens.Size.pill)
                        .background(Tokens.Canvas.surfaceActive.color, in: .capsule)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityIdentifier("inbox.composer.paste")
            }
            Spacer(minLength: 0)
            Menu {
                Button(InboxCopy.photoLibrary, systemImage: "photo") { showsPhotos = true }
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button(InboxCopy.takePhoto, systemImage: "camera") { showsCamera = true }
                }
                Button(InboxCopy.chooseFile, systemImage: "folder") { showsFiles = true }
            } label: {
                circle("paperclip")
            }
            .accessibilityLabel(InboxCopy.attachFile)
            .accessibilityIdentifier("inbox.composer.attach")
            Button {
                Task { await recorder.start() }
            } label: {
                circle("mic")
            }
            .accessibilityLabel(InboxCopy.recordVoiceMemo)
            .accessibilityIdentifier("inbox.composer.mic")
            Button {
                Task { await send(force: false) }
            } label: {
                Image(systemName: "arrow.up")
                    .font(Tokens.Typography.body.font.weight(.semibold))
                    .foregroundStyle(trimmed.isEmpty ? Tokens.Text.tertiary.color : Tokens.Tint.foreground.color)
                    .frame(width: Tokens.Size.pill, height: Tokens.Size.pill)
                    .background(trimmed.isEmpty ? Tokens.Canvas.surfaceActive.color : Tokens.Tint.base.color, in: .circle)
                    .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
            }
            .buttonStyle(.plain)
            .disabled(trimmed.isEmpty || sending)
            .accessibilityLabel(InboxCopy.send)
            .accessibilityIdentifier("inbox.composer.send")
        }
    }

    private func circle(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .frame(width: Tokens.Size.pill, height: Tokens.Size.pill)
            .background(Tokens.Canvas.surfaceActive.color, in: .circle)
            .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
    }

    private func duplicateNotice(_ item: InboxItemRecord) -> some View {
        let created = Date(timeIntervalSince1970: TimeInterval(item.createdAtMs) / 1000)
        return VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(InboxCopy.alreadyCaptured(InboxMeta.displayTitle(item), InboxMeta.age(created, now: store.clock())))
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.primary.color)
            HStack(spacing: Tokens.Space.section) {
                Button(InboxCopy.openIt) {
                    close()
                    router.path.append(.item(item.id))
                }
                .accessibilityIdentifier("inbox.composer.openDuplicate")
                Button(InboxCopy.captureAnyway) { Task { await send(force: true) } }
                    .accessibilityIdentifier("inbox.composer.captureAnyway")
            }
            .font(Tokens.Typography.supporting.font.weight(.semibold))
            .foregroundStyle(Tokens.Text.tint.color)
        }
        .padding(Tokens.Space.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Tint.base.color.opacity(Tokens.Palette.chipFillAlpha), in: .rect(cornerRadius: Tokens.Radius.card))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox.composer.duplicate")
    }

    /// The live preview and duplicate check for a typed or pasted link.
    private func inspect() async {
        let value = trimmed
        guard InboxLinks.isWebAddress(value), let url = URL(string: value) else {
            preview = nil
            duplicate = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        duplicate = await store.read { try $0.duplicateByUrl(url: value) } ?? nil
        let provider = LPMetadataProvider()
        provider.shouldFetchSubresources = false
        let metadata = try? await provider.startFetchingMetadata(for: url)
        guard !Task.isCancelled else { return }
        preview = InboxLinkPreview(url: url, title: metadata?.title, icon: metadata?.iconProvider)
    }

    private func send(force: Bool) async {
        guard !trimmed.isEmpty, !sending else { return }
        sending = true
        defer { sending = false }
        switch await store.capture(trimmed, force: force) {
        case .captured:
            text = ""
            duplicate = nil
            preview = nil
        case let .duplicate(item):
            duplicate = item
        case .failed:
            break
        }
    }

    private func stopRecording() {
        guard let recorded = recorder.stop() else { return }
        Task {
            _ = await store.captureVoice(
                file: recorded.url, duration: recorded.duration, waveform: recorded.waveform, transcribe: true
            )
        }
    }

    private func capturePhoto(_ item: PhotosPickerItem) async {
        defer { photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let type = item.supportedContentTypes.first
        let mime = type?.preferredMIMEType ?? "image/jpeg"
        let ext = type?.preferredFilenameExtension ?? "jpg"
        _ = await store.captureFile(data: data, filename: "\(Self.photoName(ext: ext))", mimeType: mime)
    }

    private func captureFile(_ url: URL) async {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        _ = await store.captureFile(data: data, filename: url.lastPathComponent, mimeType: mime)
    }

    private func captureData(_ data: Data, name: String, mime: String) async {
        _ = await store.captureFile(data: data, filename: name, mimeType: mime)
    }

    static func photoName(ext: String = "jpg") -> String {
        "Photo \(Date().formatted(.iso8601.year().month().day().dateSeparator(.dash))).\(ext)"
    }
}

/// A link's on-device preview (LinkPresentation).
struct InboxLinkPreview: Equatable {
    let url: URL
    let title: String?
    let icon: NSItemProvider?

    static func == (lhs: InboxLinkPreview, rhs: InboxLinkPreview) -> Bool { lhs.url == rhs.url && lhs.title == rhs.title }
}

struct InboxInboxLinkPreviewCard: View {
    let preview: InboxLinkPreview

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Image(systemName: "link")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Inbox.link.color)
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .background(Tokens.Canvas.surfaceActive.color, in: .rect(cornerRadius: Tokens.Radius.control))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(preview.title ?? preview.url.absoluteString)
                    .font(Tokens.Typography.supporting.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.primary.color)
                    .lineLimit(2)
                Text(InboxMeta.domain(preview.url.absoluteString) ?? "")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            Spacer(minLength: 0)
        }
        .padding(Tokens.Space.small)
        .overlay {
            RoundedRectangle(cornerRadius: Tokens.Radius.card).strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("inbox.composer.preview")
    }
}

/// The camera, through `UIImagePickerController` (no SwiftUI camera picker).
struct InboxCameraPicker: UIViewControllerRepresentable {
    let captured: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_: UIImagePickerController, context _: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: InboxCameraPicker
        init(_ parent: InboxCameraPicker) { self.parent = parent }

        func imagePickerController(
            _: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
                parent.captured(data)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_: UIImagePickerController) { parent.dismiss() }
    }
}
