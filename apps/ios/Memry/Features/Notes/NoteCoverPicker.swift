import MemryCore
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// The cover's picker and reposition sheets, split from `NoteCover.swift`; see its header.

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
