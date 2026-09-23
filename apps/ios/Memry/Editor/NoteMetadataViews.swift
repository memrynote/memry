//
//  NoteMetadataViews.swift
//  The metadata surfaces: cover, icon, title, tags and the property editors.
//
//  N208, N702, N703, N704, N705. Tokens only, logical edges only, and every
//  control carries a word rather than a glyph.
//

import MemryCore
import PhotosUI
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
                // No icon draws a quiet "add" glyph rather than a stray dot,
                // which read as a rendering fault next to the title.
                if let icon, !icon.isEmpty {
                    Text(icon)
                        .font(Tokens.Typography.sectionTitle.font)
                } else {
                    Image(systemName: "face.smiling")
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
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

/// Tags, with add and remove (N705), as desktop's coloured chips.
struct NoteTagEditor: View {
    let tags: [String]
    /// Every tag in the vault, for the suggestions desktop offers.
    var suggestions: [String] = []
    /// A tag's chosen colour, lowercased name to palette name or `#rrggbb`.
    var colors: [String: String] = [:]
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
            FlowLayout(spacing: Tokens.Space.small) {
                ForEach(tags, id: \.self) { tag in
                    // Spelled as the payload holds it: `Café` and `CAFÉ` are
                    // two rows one layer down, and only matching folds case.
                    Chip(text: tag, color: Tokens.Palette.color(colors[tag.lowercased()], tag: tag))
                        .contextMenu {
                            Button(role: .destructive) { remove(tag) } label: {
                                Label("Remove the tag \(tag)", systemImage: "xmark")
                            }
                        }
                        .accessibilityAction(named: "Remove the tag \(tag)") { remove(tag) }
                }
                TextField("Add a tag", text: $draft)
                    .font(Tokens.Typography.caption.font)
                    .fixedSize()
                    .onSubmit(commit)
                    .accessibilityLabel("Add a tag")
            }

            if !draft.isEmpty, !matching.isEmpty {
                FlowLayout(spacing: Tokens.Space.small) {
                    ForEach(matching, id: \.self) { tag in
                        Button {
                            add(tag)
                            draft = ""
                        } label: {
                            Chip(text: tag, color: Tokens.Palette.color(colors[tag.lowercased()], tag: tag))
                                .opacity(0.7)
                        }
                        .accessibilityLabel("Add the tag \(tag)")
                    }
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
}

/// A coloured chip: the hue as the label, the hue at the contract's alpha as
/// the fill (`TAG_CHIP_FILL_ALPHA`).
struct Chip: View {
    let text: String
    let color: Color
    var symbol: String?

    var body: some View {
        HStack(spacing: Tokens.Space.tight) {
            if let symbol {
                Text(symbol).accessibilityHidden(true)
            }
            Text(text)
        }
        .font(Tokens.Typography.caption.font.weight(.medium))
        .foregroundStyle(color)
        .padding(.horizontal, Tokens.Space.small)
        .padding(.vertical, 2)
        .background(color.opacity(Tokens.Palette.chipFillAlpha), in: .rect(cornerRadius: Tokens.Radius.control))
    }
}

/// Lines of chips that wrap, which `HStack` cannot do.
struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(
                    at: CGPoint(x: x, y: bounds.minY + row.y + (row.height - size.height) / 2),
                    proposal: ProposedViewSize(size)
                )
                x += size.width + spacing
            }
        }
    }

    private struct Row {
        var items: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
        var y: CGFloat = 0
    }

    private func arrange(_ maxWidth: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            var row = rows[rows.count - 1]
            let needed = row.items.isEmpty ? size.width : row.width + spacing + size.width
            if needed > maxWidth, !row.items.isEmpty {
                let next = Row(items: [index], width: size.width, height: size.height, y: row.y + row.height + spacing)
                rows.append(next)
                continue
            }
            row.items.append(index)
            row.width = needed
            row.height = max(row.height, size.height)
            rows[rows.count - 1] = row
        }
        return rows
    }
}

/// One property, edited against its declared type (N704), laid out as
/// desktop lays it out: a type glyph and the name in a label column, the
/// value beside it — coloured chips for choices, relations and projects.
///
/// **A property with no declared type still edits**, as text: one written
/// before its definition arrived is legal (§13.7.1) and is exactly the case
/// that would otherwise be unreachable. Clearing is in the row's context
/// menu, where desktop keeps it, rather than a button on every row.
struct NotePropertyEditor: View {
    let property: NoteProperty
    let commit: (String) -> Void
    let clear: () -> Void
    /// A note's title and icon by id, for a relation's value.
    var noteTitle: (String) -> String? = { _ in nil }
    var noteIcon: (String) -> String? = { _ in nil }

    @State private var draft: String = ""
    @State private var loaded = false

    private var kind: NotePropertyKind? { NotePropertyKind.of(property) }

    private var options: [String] { NotePropertyOptions.values(of: property.optionsJson) }
    private var optionColors: [String: String] { NotePropertyOptions.colors(of: property.optionsJson) }

    private var symbol: String {
        switch kind {
        case .text: "textformat"
        case .number: "number"
        case .date: "calendar"
        case .checkbox: "checkmark.square"
        case .url: "link"
        case .status, .select: "list.bullet"
        case .multiselect: "tag"
        case .relation: "arrow.up.right.square"
        case .project: "folder"
        case nil: "textformat"
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: Tokens.Space.medium) {
            HStack(spacing: Tokens.Space.small) {
                // One lane for every glyph, so the names share an edge.
                Image(systemName: symbol)
                    .frame(width: Tokens.Space.inset, alignment: .center)
                Text(property.name).lineLimit(1)
            }
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .frame(width: 118, alignment: .leading)
            .accessibilityHidden(true)

            editor
                .font(Tokens.Typography.supporting.font)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contextMenu {
            Button(role: .destructive, action: clear) {
                Label("Clear \(property.name)", systemImage: "xmark.circle")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Clear \(property.name)", clear)
        .onAppear {
            guard !loaded else { return }
            draft = NotePropertyJSON.decode(property)
            loaded = true
        }
    }

    private var listed: [String] {
        draft.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    @ViewBuilder
    private var editor: some View {
        switch kind {
        case .checkbox:
            Button {
                draft = draft == "true" ? "false" : "true"
                commit(draft)
            } label: {
                Image(systemName: draft == "true" ? "checkmark.square.fill" : "square")
                    .foregroundStyle(draft == "true" ? Tokens.Tint.base.color : Tokens.Text.tertiary.color)
            }
            .accessibilityLabel(property.name)
            .accessibilityValue(draft == "true" ? "On" : "Off")

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

        case .status where !options.isEmpty, .select where !options.isEmpty:
            Menu {
                ForEach(options, id: \.self) { option in
                    Button(option) {
                        draft = option
                        commit(option)
                    }
                }
            } label: {
                chip(draft.isEmpty ? "Empty" : draft)
            }
            .accessibilityLabel(property.name)
            .accessibilityValue(draft)

        case .multiselect where !options.isEmpty:
            Menu {
                ForEach(options, id: \.self) { option in
                    Button {
                        var chosen = listed
                        if let at = chosen.firstIndex(of: option) {
                            chosen.remove(at: at)
                        } else {
                            chosen.append(option)
                        }
                        draft = chosen.joined(separator: ", ")
                        commit(draft)
                    } label: {
                        Label(option, systemImage: listed.contains(option) ? "checkmark" : "")
                    }
                }
            } label: {
                FlowLayout(spacing: Tokens.Space.tight) {
                    ForEach(listed.isEmpty ? ["Empty"] : listed, id: \.self) { chip($0) }
                }
            }
            .accessibilityLabel(property.name)
            .accessibilityValue(draft)

        case .relation:
            // Note titles, not `memry://note/<id>`: the URI is the stored
            // form and reads as noise. Read only here, because a relation is
            // made by choosing a note, and a free-text field would let a typo
            // write a URI that points nowhere.
            FlowLayout(spacing: Tokens.Space.tight) {
                ForEach(relations, id: \.id) { related in
                    Chip(text: related.title, color: Tokens.Tint.base.color, symbol: related.icon)
                }
            }
            .accessibilityLabel(property.name)
            .accessibilityValue(relations.map(\.title).joined(separator: ", "))

        case .project:
            FlowLayout(spacing: Tokens.Space.tight) {
                ForEach(listed, id: \.self) { name in
                    Chip(text: name, color: Tokens.Text.primary.color)
                }
            }
            .accessibilityLabel(property.name)
            .accessibilityValue(draft)

        case .number:
            TextField("Empty", text: $draft)
                .keyboardType(.decimalPad)
                .onSubmit { commit(draft) }
                .accessibilityLabel(property.name)

        case .url:
            TextField("Empty", text: $draft)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .foregroundStyle(Tokens.Text.tint.color)
                .onSubmit { commit(draft) }
                .accessibilityLabel(property.name)

        default:
            // text, a choice with no options, and any type this build has
            // never heard of. A comma-separated list is how an array type is
            // typed, which the model turns back into a JSON array.
            TextField("Empty", text: $draft)
                .onSubmit { commit(draft) }
                .accessibilityLabel(property.name)
        }
    }

    private func chip(_ value: String) -> Chip {
        Chip(text: value, color: Tokens.Palette.color(optionColors[value], tag: value))
    }

    /// Each `memry://<kind>/<id>` in the value, as the title and icon of what
    /// it points at when this vault knows it, and as the id when it does not.
    private var relations: [(id: String, title: String, icon: String?)] {
        listed.map { uri in
            let id = uri.split(separator: "/").last.map(String.init) ?? uri
            return (id, noteTitle(id) ?? id, noteIcon(id))
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

/// The editable metadata block: tags, then a collapsible "Properties · N"
/// section, as desktop's note header has them.
///
/// A sibling of `NoteMetaView` rather than a mode inside it. That view is the
/// read surface and says so in its own header; giving it a second, editable
/// personality would make both harder to reason about.
struct NoteMetadataEditors: View {
    let metadata: NoteMetadata
    let model: NoteMetadataViewModel
    let reload: () async -> Void
    /// A note's title by id, so a relation reads as the notes it names.
    var noteTitle: (String) -> String? = { _ in nil }
    var noteIcon: (String) -> String? = { _ in nil }
    var tagColors: [String: String] = [:]

    @State private var showsProperties = true

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            NoteTagEditor(
                tags: metadata.tags,
                colors: tagColors,
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

            if !metadata.properties.isEmpty {
                Button {
                    showsProperties.toggle()
                } label: {
                    HStack(spacing: Tokens.Space.small) {
                        Image(systemName: "chevron.right")
                            .rotationEffect(.degrees(showsProperties ? 90 : 0))
                            .foregroundStyle(Tokens.Tint.base.color)
                        Text("Properties · \(metadata.properties.count)")
                            .foregroundStyle(Tokens.Text.secondary.color)
                        Spacer()
                    }
                    .font(Tokens.Typography.caption.font.weight(.medium))
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Properties, \(metadata.properties.count)")
                .accessibilityValue(showsProperties ? "Expanded" : "Collapsed")

                if showsProperties {
                    Divider()
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
                            },
                            noteTitle: noteTitle,
                            noteIcon: noteIcon
                        )
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Adding, changing, repositioning and removing a note's cover (N703).
///
/// The picture itself goes up through the attachment path (N214); this writes
/// only the reference and the offset. **No other client renders a cover
/// today**, which `research.md` records: the key survives a desktop edit by
/// §13.2.1, it simply is not drawn there.
struct NoteCoverMenu: View {
    let cover: NoteCover?
    /// Uploads a picture and returns the **url to store**, or `nil` on
    /// failure. That url is the attachment's filename, because Q4 binds a
    /// block's url to an attachment by its filename's basename — storing an
    /// attachment id here would give the reader something it cannot resolve.
    let upload: (Data, String, String) async -> String?
    let setCover: (String?, Double) -> Void

    @State private var repositioning = false
    @State private var picking = false
    @State private var photo: PhotosPickerItem?
    @State private var offset: Double = 0.5

    var body: some View {
        Menu {
            Button {
                picking = true
            } label: {
                Label(cover == nil ? "Add a cover" : "Change the cover", systemImage: "photo")
            }
            if let cover {
                Button {
                    offset = cover.offsetY
                    repositioning = true
                } label: {
                    Label("Reposition", systemImage: "arrow.up.and.down")
                }
                Divider()
                Button(role: .destructive) {
                    // `nil` clears, which the core writes as an explicit null
                    // rather than removing the key.
                    setCover(nil, cover.offsetY)
                } label: {
                    Label("Remove the cover", systemImage: "trash")
                }
            }
        } label: {
            Label("Cover", systemImage: "photo.on.rectangle")
                .labelStyle(.iconOnly)
        }
        .accessibilityLabel(cover == nil ? "Add a cover" : "Change this note's cover")
        .photosPicker(isPresented: $picking, selection: $photo, matching: .images)
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self) else {
                    photo = nil
                    return
                }
                let suffix = item.supportedContentTypes.first?
                    .preferredFilenameExtension ?? "jpg"
                let name = NoteAttachmentComposer.capturedName(extension: suffix)
                let mime = item.supportedContentTypes.first?.preferredMIMEType
                    ?? "application/octet-stream"
                if let url = await upload(data, name, mime) {
                    setCover(url, cover?.offsetY ?? 0.5)
                }
                photo = nil
            }
        }
        .sheet(isPresented: $repositioning) {
            NavigationStack {
                Form {
                    // The offset decides which part of a tall image is
                    // visible, so it is a position rather than a percentage.
                    Slider(value: $offset, in: 0...1) {
                        Text("Vertical position")
                    } minimumValueLabel: {
                        Text("Top").font(Tokens.Typography.caption.font)
                    } maximumValueLabel: {
                        Text("Bottom").font(Tokens.Typography.caption.font)
                    }
                    .accessibilityLabel("Vertical position of the cover")
                }
                .navigationTitle("Reposition")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel") { repositioning = false }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") {
                            repositioning = false
                            setCover(cover?.url, offset)
                        }
                    }
                }
            }
        }
    }
}
