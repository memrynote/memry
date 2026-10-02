//
//  EditorKeyboardToolbar.swift
//  The toolbar above the keyboard, and the panels that replace the keyboard.
//
//  `DESIGN.md` "Notes and editor": editor controls move into native
//  navigation or an input accessory instead of reproducing desktop's floating
//  chrome. Every control is a word to VoiceOver and keeps a 44pt hit area.
//

import SwiftUI
import VisionKit

/// The toolbar's items, in the order the main row draws them.
enum EditorToolbarItem: String, CaseIterable, Identifiable {
    case insert, format, mention, tag, attach, turnInto, undo, redo
    case indent, outdent, moveDown, moveUp, more

    var id: String { rawValue }

    /// Indent, outdent and the moves: what a list item is edited with most.
    static let blockMoves: [EditorToolbarItem] = [.indent, .outdent, .moveDown, .moveUp]

    /// List-like blocks, whose row leads with `blockMoves`.
    static let listKinds: Set<String> = ["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"]

    /// Every item once. In a list item the block moves come first, before
    /// `+`; everything else keeps its relative order.
    static func order(for kind: String?) -> [EditorToolbarItem] {
        guard let kind, listKinds.contains(kind) else { return allCases }
        return blockMoves + allCases.filter { !blockMoves.contains($0) }
    }
}

/// The accessory row, with the `[[` / `@` / `#` menu above it when one is
/// open. `Aa`, or a non-empty selection, slides the format row in over the
/// main row.
struct EditorKeyboardToolbar: View {
    let session: EditorSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var showsFormat: Bool { session.formatting && session.panel == .none }

    var body: some View {
        GlassEffectContainer(spacing: Tokens.Space.small) {
            VStack(spacing: Tokens.Space.small) {
                if !session.suggestions.isEmpty {
                    EditorSuggestionList(session: session)
                        .chromeGlass(in: .rect(cornerRadius: Tokens.Size.minimumHitArea / 2))
                } else if !session.tagSuggestions.isEmpty {
                    TagSuggestionList(session: session)
                        .chromeGlass(in: .rect(cornerRadius: Tokens.Size.minimumHitArea / 2))
                }
                HStack(spacing: Tokens.Space.small) {
                    ZStack {
                        if showsFormat {
                            EditorFormatRow(session: session)
                                .transition(slide(from: .trailing))
                        } else {
                            EditorMainRow(session: session)
                                .transition(slide(from: .leading))
                        }
                    }
                    .animation(reduceMotion ? nil : .snappy, value: showsFormat)
                    .padding(.vertical, Tokens.Space.tight)
                    .clipShape(.capsule)
                    .chromeGlass(in: .capsule)
                    trailingButton
                        .padding(Tokens.Space.tight)
                        .chromeGlass(in: .circle)
                }
            }
            .padding(.horizontal, Tokens.Space.small)
            .padding(.top, Tokens.Space.small)
            .padding(.bottom, Tokens.Space.tight)
        }
        .fixedSize(horizontal: false, vertical: true)
        .font(Tokens.Typography.body.font)
        .foregroundStyle(Tokens.Text.primary.color)
        .tint(Tokens.Text.primary.color)
    }

    /// A slide within the capsule, or a fade under Reduce Motion. `leading`
    /// and `trailing` mirror in right-to-left.
    private func slide(from edge: Edge) -> AnyTransition {
        reduceMotion ? .opacity : .move(edge: edge).combined(with: .opacity)
    }

    /// Its own glass circle, apart from the row: back to the keyboard while
    /// the insert grid is open, otherwise hide the keyboard.
    @ViewBuilder private var trailingButton: some View {
        if session.panel == .insert {
            ToolbarGlyph(symbol: "chevron.down", label: "Back to the keyboard", selected: false) {
                session.show(.none)
            }
        } else {
            ToolbarGlyph(symbol: "keyboard.chevron.compact.down", label: "Hide the keyboard", selected: false) {
                session.dismissKeyboard()
            }
        }
    }
}

/// One horizontally scrolling row of every item, in
/// `EditorToolbarItem.order(for:)`. Scrolls back to its leading edge when the
/// order changes, so a list item's moves are in view at once.
private struct EditorMainRow: View {
    let session: EditorSession

    var body: some View {
        let items = session.toolbarItems
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(items) { item in
                        itemView(item).id(item)
                    }
                }
                .padding(.horizontal, Tokens.Space.tight)
            }
            .onChange(of: items) { _, next in
                if let first = next.first { proxy.scrollTo(first, anchor: .leading) }
            }
        }
    }

    @ViewBuilder private func itemView(_ item: EditorToolbarItem) -> some View {
        switch item {
        case .insert:
            ToolbarGlyph(symbol: "plus", label: "Insert a block", selected: session.panel == .insert) {
                session.show(.insert)
            }
        case .format:
            ToolbarText(text: "Aa", label: "Text formatting") { session.showFormatting(true) }
        case .mention:
            ToolbarText(text: "@", label: "Mention a date or note") { session.startTrigger("@") }
        case .tag:
            ToolbarText(text: "#", label: "Add a tag") { session.startTrigger("#") }
        case .attach:
            if let attach = session.attach {
                AttachmentMenu(attach: attach)
            }
        case .turnInto:
            TurnIntoButton(session: session)
        case .undo:
            ToolbarGlyph(symbol: "arrow.uturn.backward", label: "Undo", selected: false) { session.undo() }
                .disabled(!session.canUndo)
        case .redo:
            ToolbarGlyph(symbol: "arrow.uturn.forward", label: "Redo", selected: false) { session.redo() }
                .disabled(!session.canRedo)
        case .indent:
            ToolbarGlyph(symbol: "increase.indent", label: "Indent", selected: false) { session.nest(true) }
                .disabled(!session.canIndent)
        case .outdent:
            ToolbarGlyph(symbol: "decrease.indent", label: "Outdent", selected: false) { session.nest(false) }
                .disabled(!session.canOutdent)
        case .moveDown:
            ToolbarGlyph(symbol: "arrow.down", label: "Move block down", selected: false) {
                session.focusedRunner?.moveDown()
            }
            .disabled(session.focusedSiblings.next == nil)
        case .moveUp:
            ToolbarGlyph(symbol: "arrow.up", label: "Move block up", selected: false) {
                session.focusedRunner?.moveUp()
            }
            .disabled(session.focusedSiblings.previous == nil)
        case .more:
            BlockMoreMenu(session: session)
        }
    }
}

/// The format slide: back, the marks, a link and code over the selection.
/// With no selection there is nothing to format, so the marks are disabled
/// rather than doing nothing.
private struct EditorFormatRow: View {
    let session: EditorSession

    var body: some View {
        HStack(spacing: 0) {
            ToolbarGlyph(symbol: "chevron.backward", label: "Back to the toolbar", selected: false) {
                session.showFormatting(false)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(EditorMarks.all, id: \.id) { mark in
                        ToolbarGlyph(
                            symbol: mark.symbol, label: mark.name,
                            selected: session.selectionMarks.contains(mark.id)
                        ) { session.toggleMark(mark.id) }
                    }
                    LinkMarkButton(session: session)
                    ToolbarGlyph(
                        symbol: "chevron.left.forwardslash.chevron.right", label: "Code",
                        selected: session.selectionMarks.contains("code")
                    ) { session.toggleMark("code") }
                }
                .disabled(!session.hasSelection)
                .accessibilityHint(session.hasSelection ? "" : "Select text to format it")
            }
        }
        .padding(.horizontal, Tokens.Space.tight)
    }
}

/// The caret's block type: opens the block panel, turn into and colours.
private struct TurnIntoButton: View {
    let session: EditorSession

    var body: some View {
        let name = InsertableBlock.chip(kind: session.focusedKind, level: session.focusedLevel)
        ToolbarGlyph(symbol: "return", label: "Turn into", selected: session.panel == .block) {
            session.show(.block)
        }
        .accessibilityValue(name)
        .accessibilityHint("Turn this block into another type or colour it")
    }
}

/// The `...` menu: the focused block's own actions, as desktop's block menu
/// offers them.
private struct BlockMoreMenu: View {
    let session: EditorSession

    var body: some View {
        let runner = session.focusedRunner
        Menu {
            if let runner {
                Button("Duplicate", systemImage: "plus.square.on.square") { runner.duplicate() }
                if session.canMoveToNote {
                    Button("Move to\u{2026}", systemImage: "arrow.right.doc.on.clipboard") {
                        session.requestMoveToNote()
                    }
                }
                Button("Copy text", systemImage: "doc.on.doc") { session.copyFocusedText() }
                if runner.target.canColour {
                    BlockColourMenu(runner: runner, title: "Text colour", prop: "textColor", symbol: "character")
                    BlockColourMenu(
                        runner: runner, title: "Background colour", prop: "backgroundColor", symbol: "paintbrush"
                    )
                }
                Section {
                    Button("Delete", systemImage: "trash", role: .destructive) { runner.delete() }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .disabled(runner == nil)
        .accessibilityLabel("More block actions")
    }
}

/// The paperclip: where an attachment comes from.
private struct AttachmentMenu: View {
    let attach: (EditorAttachmentSource) -> Void

    var body: some View {
        Menu {
            Button("Photos", systemImage: "photo.on.rectangle") { attach(.photos) }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Camera", systemImage: "camera") { attach(.camera) }
            }
            Button("Files", systemImage: "folder") { attach(.files) }
            if VNDocumentCameraViewController.isSupported {
                Button("Scan document", systemImage: "doc.viewfinder") { attach(.scan) }
            }
        } label: {
            Image(systemName: "paperclip")
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .accessibilityLabel("Attach")
    }
}

/// The marks the format slide toggles, named as BlockNote names them.
enum EditorMarks {
    static let all: [(id: String, name: String, symbol: String)] = [
        ("bold", "Bold", "bold"),
        ("italic", "Italic", "italic"),
        ("underline", "Underline", "underline"),
        ("strike", "Strikethrough", "strikethrough"),
    ]
}

private struct ToolbarGlyph: View {
    let symbol: String
    let label: String
    let selected: Bool
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .background(selected ? Tokens.Canvas.surface.color : .clear, in: .capsule)
                .foregroundStyle(isEnabled ? Tokens.Text.primary.color : Tokens.Text.tertiary.color)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

private struct ToolbarText: View {
    let text: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(Tokens.Typography.recoveryMaterial.font)
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A link over the selection, asked for by address.
private struct LinkMarkButton: View {
    let session: EditorSession
    @State private var asking = false
    @State private var address = ""

    var body: some View {
        ToolbarGlyph(symbol: "link", label: "Add a link", selected: session.selectionMarks.contains("link")) {
            if session.selectionMarks.contains("link") {
                session.toggleMark("link")
            } else {
                address = ""
                asking = true
            }
        }
        .alert("Link", isPresented: $asking) {
            TextField("https://", text: $address)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
            Button("Cancel", role: .cancel) {}
            Button("Add") {
                let trimmed = address.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { session.toggleMark("link", value: trimmed) }
            }
        }
    }
}

/// The `#` menu rows: vault tags, then a create row.
private struct TagSuggestionList: View {
    let session: EditorSession

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(session.tagSuggestions) { item in
                    Button {
                        session.chooseTag(item)
                    } label: {
                        HStack(spacing: Tokens.Space.small) {
                            Image(systemName: item.isNew ? "plus" : "number")
                                .foregroundStyle(
                                    item.isNew
                                        ? Tokens.Text.secondary.color
                                        : Tokens.Palette.color(session.tagColors[item.tag.lowercased()], tag: item.tag)
                                )
                                .frame(width: Tokens.Space.inset)
                            Text(item.title).lineLimit(1)
                            Spacer()
                        }
                        .padding(.horizontal, Tokens.Space.medium)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.isNew ? "Create tag \(item.tag)" : "Tag \(item.tag)")
                }
            }
        }
        .frame(maxHeight: Tokens.Size.minimumHitArea * 4)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The `[[` / `@` menu rows.
private struct EditorSuggestionList: View {
    let session: EditorSession

    /// A note row shows the note's emoji, as the notes list does.
    private func emoji(for item: EditorSuggestion) -> String? {
        guard case let .note(title, _) = item.kind else { return nil }
        return session.icons[title.lowercased()]
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(session.suggestions) { item in
                    Button {
                        session.choose(item)
                    } label: {
                        HStack(spacing: Tokens.Space.small) {
                            Group {
                                if let emoji = emoji(for: item) {
                                    Text(emoji)
                                } else {
                                    Image(systemName: item.symbol)
                                        .foregroundStyle(Tokens.Text.secondary.color)
                                }
                            }
                            .frame(width: Tokens.Space.inset)
                            Text(item.title).lineLimit(1)
                            Spacer()
                            if let subtitle = item.subtitle {
                                Text(subtitle)
                                    .font(Tokens.Typography.caption.font)
                                    .foregroundStyle(Tokens.Text.secondary.color)
                                    .lineLimit(1)
                            }
                        }
                        .padding(.horizontal, Tokens.Space.medium)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxHeight: Tokens.Size.minimumHitArea * 4)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// What replaces the keyboard: the insert grid, or turn-into and colours.
struct EditorPanelView: View {
    let session: EditorSession
    /// Grows with Dynamic Type, so a tile's title wraps rather than truncates.
    @ScaledMetric(relativeTo: .caption) private var tileWidth: CGFloat = 96

    private var columns: [GridItem] { [GridItem(.adaptive(minimum: tileWidth), spacing: Tokens.Space.small)] }
    private let swatchColumns = [GridItem(.adaptive(minimum: Tokens.Size.minimumHitArea), spacing: Tokens.Space.small)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                switch session.panel {
                case .insert:
                    insertGrid
                case .block:
                    section("Turn into") {
                        grid(InsertableBlock.all.map { ($0.name, $0.symbol) }, checked: currentBlock) {
                            session.turnInto(InsertableBlock.all[$0])
                        }
                    }
                    colours(prop: "textColor", title: "Text colour", fill: false) { session.setBlockColor("textColor", $0) }
                    colours(prop: "backgroundColor", title: "Background", fill: true) { session.setBlockColor("backgroundColor", $0) }
                case .none:
                    EmptyView()
                }
            }
            .padding(Tokens.Space.medium)
        }
        .foregroundStyle(Tokens.Text.primary.color)
    }

    /// `BlockCatalog` by section, the slash menu's rows in its order, under a
    /// filter that hands over to the slash menu: the grid replaces the
    /// keyboard, so the query is typed after a `/` at the caret.
    @ViewBuilder private var insertGrid: some View {
        if session.focusedKind != "codeBlock" {
            Button {
                session.startTrigger("/")
            } label: {
                HStack(spacing: Tokens.Space.small) {
                    Image(systemName: "magnifyingglass")
                    Text("Filter blocks")
                    Spacer()
                }
                .foregroundStyle(Tokens.Text.secondary.color)
                .padding(.horizontal, Tokens.Space.medium)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .background(Tokens.Canvas.surface.color, in: .capsule)
                .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Filter blocks")
            .accessibilityHint("Opens the keyboard with the slash menu")
        }
        ForEach(BlockCatalog.sections(attach: session.attach != nil), id: \.section) { group in
            section(group.section.title) {
                grid(group.rows.map { ($0.title, $0.symbol) }, checked: nil) {
                    session.chooseFromGrid(group.rows[$0])
                }
            }
        }
    }

    private var currentBlock: String? {
        InsertableBlock.all.first { $0.id == session.focusedKind && ($0.level == nil || $0.level == session.focusedLevel) }?.name
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(title)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func grid(
        _ tiles: [(title: String, symbol: String)], checked: String?, pick: @escaping (Int) -> Void
    ) -> some View {
        LazyVGrid(columns: columns, spacing: Tokens.Space.small) {
            ForEach(tiles.indices, id: \.self) { index in
                let tile = tiles[index]
                Button {
                    pick(index)
                } label: {
                    VStack(spacing: Tokens.Space.tight) {
                        Image(systemName: tile.symbol)
                        Text(tile.title)
                            .font(Tokens.Typography.caption.font)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(Tokens.Space.tight)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea * 1.5)
                    .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.control))
                    .overlay(alignment: .topTrailing) {
                        if tile.title == checked {
                            Image(systemName: "checkmark")
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(Tokens.Text.tint.color)
                                .padding(Tokens.Space.tight)
                        }
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tile.title)
                .accessibilityAddTraits(tile.title == checked ? [.isSelected] : [])
            }
        }
    }

    /// BlockNote's nine colours and `default`, the palette desktop offers.
    private func colours(prop: String?, title: String, fill: Bool, pick: @escaping (String) -> Void) -> some View {
        let current = prop.flatMap { session.focusedProps[$0] } ?? "default"
        return section(title) {
            // Wraps onto rows so every swatch is visible without sideways scrolling.
            LazyVGrid(columns: swatchColumns, alignment: .leading, spacing: Tokens.Space.small) {
                ForEach(["default"] + Tokens.Content.names, id: \.self) { name in
                        Button {
                            pick(name)
                        } label: {
                            Text("A")
                                .font(Tokens.Typography.body.font.weight(.semibold))
                                .foregroundStyle(fill ? Tokens.Text.primary.color : (Tokens.Content.ink(named: name)?.color ?? Tokens.Text.primary.color))
                                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                                .background(
                                    fill ? (Tokens.Content.fill(named: name)?.color ?? Tokens.Canvas.surface.color) : Tokens.Canvas.surface.color,
                                    in: .rect(cornerRadius: Tokens.Radius.control)
                                )
                                .overlay {
                                    if prop != nil, current == name {
                                        RoundedRectangle(cornerRadius: Tokens.Radius.control)
                                            .stroke(Tokens.Text.tint.color, lineWidth: 2)
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(title): \(name == "default" ? "Default" : name.capitalized)")
                        .accessibilityAddTraits(prop != nil && current == name ? [.isSelected] : [])
                }
            }
        }
    }
}
