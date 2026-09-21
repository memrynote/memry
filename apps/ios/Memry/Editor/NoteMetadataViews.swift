//
//  NoteMetadataViews.swift
//  The metadata surfaces: cover, icon, title, tags and the property editors.
//
//  N208, N702, N703, N704, N705. Tokens only, logical edges only, and every
//  control carries a word rather than a glyph.
//

import MemryCore
import SwiftUI
import UIKit

/// A note's cover image (N208).
///
/// **Render-only, and that is a protocol fact rather than a scope cut.**
/// `coverImage` is not a field of the note schema — the vectors use it as
/// their canonical unknown key — so this draws what another client wrote and
/// offers no way to author one. N703's write half waits on there being a
/// writer to agree with; `research.md` records why.
struct NoteCoverView: View {
    let cover: NoteCover?
    /// Resolves the cover's url to bytes on this device, by the same rule a
    /// block's url is resolved (Q4). `nil` draws nothing.
    var resolve: ((String) -> BlockAttachment)?

    var body: some View {
        if let cover, let resolve {
            switch resolve(cover.url) {
            case let .bound(attachment):
                if let path = attachment.localPath,
                    let image = UIImage(
                        contentsOfFile: AttachmentPaths.url(for: path)
                            .path(percentEncoded: false)
                    )
                {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(height: Tokens.Size.coverHeight)
                        // The stored offset decides what is visible when the
                        // image is taller than its frame, which is the whole
                        // point of carrying it.
                        .alignmentGuide(.top) { dimension in
                            dimension.height * cover.offsetY
                        }
                        .clipped()
                        .accessibilityLabel("Cover image")
                } else {
                    // Bound but no bytes yet: the same FR-045 wait a picture
                    // block shows, not an error.
                    NoteCoverPlaceholder(waiting: true)
                }
            case .remote, .unknown, .ambiguous:
                NoteCoverPlaceholder(waiting: false)
            }
        }
    }
}

private struct NoteCoverPlaceholder: View {
    let waiting: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: Tokens.Radius.control)
            .fill(Tokens.Canvas.surface.color)
            .frame(height: Tokens.Size.coverHeight)
            .overlay(
                Text(waiting ? "Cover is still downloading" : "Cover is not on this device")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            )
            .accessibilityLabel(
                waiting ? "Cover image, still downloading" : "Cover image, not on this device"
            )
    }
}

/// The note's icon and title, both editable (N702).
struct NoteTitleEditor: View {
    let title: String
    let icon: String?
    let canEdit: Bool
    let rename: (String) -> Void
    let setIcon: (String?) -> Void

    @State private var draft: String = ""
    @State private var editing = false
    @State private var pickingIcon = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Button {
                pickingIcon = true
            } label: {
                Text(icon ?? "◦")
                    .font(Tokens.Typography.sectionTitle.font)
            }
            .disabled(!canEdit)
            .accessibilityLabel(icon.map { "Icon, \($0)" } ?? "Add an icon")

            if canEdit {
                TextField(
                    "Untitled",
                    text: Binding(
                        get: { editing ? draft : title },
                        set: { draft = $0 }
                    )
                )
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .onSubmit {
                    editing = false
                    // Unchanged titles are filtered by the model, so tapping
                    // in and out does not enqueue a push.
                    rename(draft)
                }
                .onTapGesture {
                    draft = title
                    editing = true
                }
                .accessibilityLabel("Title")
            } else {
                Text(title)
                    .font(Tokens.Typography.screenTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
            }
        }
        .sheet(isPresented: $pickingIcon) {
            NoteIconPicker(current: icon) { chosen in
                setIcon(chosen)
                pickingIcon = false
            }
        }
    }
}

/// Emoji and SF Symbol names, which is what the field can hold.
///
/// The payload spells the field `emoji` and nothing restricts it to one, so a
/// symbol name is offered too — a note about a file is better served by a
/// document glyph than by an approximation in emoji.
struct NoteIconPicker: View {
    let current: String?
    let choose: (String?) -> Void

    private static let emoji = [
        "📝", "🌱", "📌", "⭐️", "🔖", "💡", "📦", "🗂", "🧭", "🔬",
        "🎯", "🛠", "📚", "✈️", "🍎", "🎵", "💬", "⏳", "🔒", "🏷",
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(
                    columns: Array(
                        repeating: GridItem(.flexible()),
                        count: 5
                    ),
                    spacing: Tokens.Space.medium
                ) {
                    ForEach(Self.emoji, id: \.self) { symbol in
                        Button {
                            choose(symbol)
                        } label: {
                            Text(symbol).font(Tokens.Typography.sectionTitle.font)
                        }
                        .accessibilityLabel(symbol)
                    }
                }
                .padding(Tokens.Space.screenInline)
            }
            .navigationTitle("Icon")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    // Clearing is the action a grid usually hides, and it is
                    // the one a user most often wants back.
                    Button("Remove") { choose(nil) }
                        .disabled(current == nil)
                }
            }
        }
    }
}

/// Tags, with add and remove (N705).
struct NoteTagEditor: View {
    let tags: [String]
    /// Every tag in the vault, for the suggestions desktop offers.
    var suggestions: [String] = []
    let add: (String) -> Void
    let remove: (String) -> Void

    @State private var draft = ""

    /// Suggestions this note does not already carry, matching what is typed.
    private var matching: [String] {
        let typed = draft.trimmingCharacters(in: .whitespaces).lowercased()
        return suggestions
            .filter { !tags.contains($0) }
            .filter { typed.isEmpty || $0.lowercased().contains(typed) }
            .prefix(6)
            .map { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Tokens.Space.small) { chips }
                VStack(alignment: .leading, spacing: Tokens.Space.small) { chips }
            }

            HStack {
                TextField("Add a tag", text: $draft)
                    .font(Tokens.Typography.caption.font)
                    .onSubmit(commit)
                    .accessibilityLabel("Add a tag")
                if !draft.isEmpty {
                    Button("Add", action: commit)
                        .font(Tokens.Typography.caption.font)
                }
            }

            if !matching.isEmpty {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Tokens.Space.small) { suggestionChips }
                    VStack(alignment: .leading, spacing: Tokens.Space.small) { suggestionChips }
                }
            }
        }
    }

    private func commit() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        add(trimmed)
        draft = ""
    }

    private var chips: some View {
        ForEach(tags, id: \.self) { tag in
            HStack(spacing: Tokens.Space.tight) {
                // Spelled as the payload holds it: `Café` and `CAFÉ` are two
                // rows one layer down, and only matching folds case.
                Text(tag)
                Button {
                    remove(tag)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .accessibilityLabel("Remove the tag \(tag)")
            }
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .padding(.horizontal, Tokens.Space.small)
            .padding(.vertical, Tokens.Space.tight)
            .background(
                RoundedRectangle(cornerRadius: Tokens.Radius.control)
                    .fill(Tokens.Canvas.surface.color)
            )
        }
    }

    private var suggestionChips: some View {
        ForEach(matching, id: \.self) { tag in
            Button {
                add(tag)
                draft = ""
            } label: {
                Text(tag)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tint.color)
            }
            .accessibilityLabel("Add the tag \(tag)")
        }
    }
}

/// One property, edited against its declared type (N704).
///
/// **A property with no declared type still edits**, as text: one written
/// before its definition arrived is legal (§13.7.1) and is exactly the case
/// that would otherwise be unreachable.
struct NotePropertyEditor: View {
    let property: NoteProperty
    let commit: (String) -> Void
    let clear: () -> Void

    @State private var draft: String = ""
    @State private var loaded = false

    private var kind: NotePropertyKind? { NotePropertyKind.of(property) }

    /// The choices a `status`, `select` or `multiselect` declares.
    private var options: [String] {
        guard
            let json = property.optionsJson,
            let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8))
        else {
            return []
        }
        if let list = parsed as? [String] { return list }
        if let objects = parsed as? [[String: Any]] {
            return objects.compactMap { $0["name"] as? String ?? $0["value"] as? String }
        }
        return []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            HStack {
                Text(property.name)
                    .font(Tokens.Typography.label.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                Spacer()
                Button {
                    clear()
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .accessibilityLabel("Clear \(property.name)")
            }
            editor
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            guard !loaded else { return }
            draft = NotePropertyJSON.decode(property)
            loaded = true
        }
    }

    @ViewBuilder
    private var editor: some View {
        switch kind {
        case .checkbox:
            Toggle(
                property.name,
                isOn: Binding(
                    get: { draft == "true" },
                    set: { on in
                        draft = on ? "true" : "false"
                        commit(draft)
                    }
                )
            )
            .labelsHidden()
            .accessibilityLabel(property.name)

        case .date:
            DatePicker(
                property.name,
                selection: Binding(
                    get: { Self.date(from: draft) ?? Date() },
                    set: { picked in
                        draft = Self.iso.string(from: picked)
                        commit(draft)
                    }
                ),
                displayedComponents: .date
            )
            .labelsHidden()
            .accessibilityLabel(property.name)

        case .status, .select where !options.isEmpty:
            Picker(property.name, selection: Binding(
                get: { draft },
                set: { chosen in
                    draft = chosen
                    commit(chosen)
                }
            )) {
                ForEach(options, id: \.self) { option in
                    Text(option).tag(option)
                }
            }
            .labelsHidden()
            .accessibilityLabel(property.name)

        case .number:
            TextField("", text: $draft)
                .keyboardType(.decimalPad)
                .onSubmit { commit(draft) }
                .accessibilityLabel(property.name)

        case .url:
            TextField("", text: $draft)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .onSubmit { commit(draft) }
                .accessibilityLabel(property.name)

        default:
            // text, select without options, multiselect, relation, project,
            // and any type this build has never heard of. A comma-separated
            // list is how the two array types are typed, which the model
            // turns back into a JSON array.
            TextField("", text: $draft)
                .onSubmit { commit(draft) }
                .accessibilityLabel(property.name)
        }
    }

    private static let iso: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    private static func date(from text: String) -> Date? {
        iso.date(from: text)
    }
}

/// The editable metadata block: tags and the property editors.
///
/// A sibling of `NoteMetaView` rather than a mode inside it. That view is the
/// read surface and says so in its own header; giving it a second, editable
/// personality would make both harder to reason about.
struct NoteMetadataEditors: View {
    let metadata: NoteMetadata
    let model: NoteMetadataViewModel
    let reload: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            NoteTagEditor(
                tags: metadata.tags,
                add: { tag in
                    Task {
                        _ = await model.addTag(tag, to: metadata.tags)
                        await reload()
                    }
                },
                remove: { tag in
                    Task {
                        _ = await model.removeTag(tag, from: metadata.tags)
                        await reload()
                    }
                }
            )

            ForEach(metadata.properties, id: \.name) { property in
                NotePropertyEditor(
                    property: property,
                    commit: { input in
                        Task {
                            await model.setProperty(
                                property.name,
                                input: input,
                                kind: NotePropertyKind.of(property)
                            )
                            await reload()
                        }
                    },
                    clear: {
                        Task {
                            await model.clearProperty(property.name)
                            await reload()
                        }
                    }
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
