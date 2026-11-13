import MemryCore
import SwiftUI

// #4347 (Q6, D9). The note inspector at regular width (`DESIGN.md` › Tablet ›
// Side rails): the outline, the properties, the review comments and the
// backlinks beside the note, each as its own section, drawn from the models
// the page already holds. While it shows, the page leaves those sections out;
// once hidden, they are back under the title and the body as on the phone.
//
// **Per device.** Open or closed lives in `@AppStorage` under
// `NoteInspectorLayout.openKey`, never in the vault and never synced. Hidden
// by default.
//
// **Shown only where it fits.** The split view says whether the window holds
// the reading measure plus the rail, as desktop's review
// rail hides once content and rail no longer fit (`use-review-rail-shift`).
// Below that, at compact width, and at accessibility text sizes (which break
// words in the rail's 320 points, as on Journal's rail), it is hidden and its
// button goes too.

extension EnvironmentValues {
    /// The window holds the note column and the rail. Set by the Notes split
    /// view; `false` everywhere else, the phone stack included.
    @Entry var noteInspectorFits = false

    /// The inspector is on screen, so the page leaves its sections to it.
    @Entry var noteInspectorShown = false
}

enum NoteInspectorLayout {
    /// The per-device open state.
    static let openKey = "notes.inspector.open"

    /// The reading measure plus the rail. The gutters may eat into the
    /// measure, which is a cap (`DESIGN.md` › Tablet › Side rails): 13"
    /// landscape beside the page sidebar (about 1056pt) holds it, 13" portrait
    /// (1032pt) does not.
    static let minimumWidth = Tokens.Size.reading + Tokens.Size.rail
}

/// The rails of the note pages on screen, by note id. The Notes detail
/// column owns it and presents the current note's rail: a system inspector
/// inside the column's stack, on a page, keeps the main thread in layout at
/// 13" landscape, while one on the stack itself does not.
@MainActor
@Observable
final class NoteInspectorRails {
    /// Each rail with the page that handed it in. Two pages can show one
    /// note for a moment (a page replaced by a fresh one), and the leaving
    /// page must not take the arriving page's rail with it.
    private var rails: [String: (page: UUID, rail: NoteInspectorRail)] = [:]

    func rail(for noteId: String) -> NoteInspectorRail? { rails[noteId]?.rail }

    func show(_ rail: NoteInspectorRail, for noteId: String, page: UUID) {
        rails[noteId] = (page, rail)
    }

    func hide(_ noteId: String, page: UUID) {
        if rails[noteId]?.page == page { rails[noteId] = nil }
    }
}

extension EnvironmentValues {
    /// Where a note page hands its rail. `nil` outside the Notes split view.
    @Entry var noteInspectorRails: NoteInspectorRails?
}

/// A note page's side of the inspector: its rail handed to the detail column,
/// the toolbar button, and its own sections left out while the rail shows.
struct NoteInspector: ViewModifier {
    let noteId: String
    let rail: NoteInspectorRail

    @Environment(\.noteInspectorRails) private var rails
    @Environment(\.noteInspectorFits) private var fits
    @AppStorage(NoteInspectorLayout.openKey) private var isOpen = false
    @State private var page = UUID()

    func body(content: Content) -> some View {
        content
            .environment(\.noteInspectorShown, fits && isOpen && rails != nil)
            .onAppear { rails?.show(rail, for: noteId, page: page) }
            .onDisappear { rails?.hide(noteId, page: page) }
            .toolbar {
                if fits, rails != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(isOpen ? "Hide inspector" : "Show inspector", systemImage: "sidebar.trailing") {
                            isOpen.toggle()
                        }
                        .accessibilityIdentifier("note.inspector.toggle")
                    }
                }
            }
    }
}

/// The detail column's side: the system inspector, showing the current
/// note's rail.
struct NoteInspectorColumn: ViewModifier {
    /// The note on screen in the column.
    let noteId: String?

    @State private var rails = NoteInspectorRails()
    @Environment(\.noteInspectorFits) private var fits
    @AppStorage(NoteInspectorLayout.openKey) private var isOpen = false

    private var shown: Binding<Bool> {
        Binding(
            get: { fits && isOpen && noteId != nil },
            // A window that stops fitting closes it for now, not for good.
            set: { if fits { isOpen = $0 } }
        )
    }

    func body(content: Content) -> some View {
        content
            .environment(\.noteInspectorRails, rails)
            .inspector(isPresented: shown) {
                if let noteId, let rail = rails.rail(for: noteId) {
                    rail.inspectorColumnWidth(Tokens.Size.rail)
                }
            }
    }
}

/// The rail's sections.
struct NoteInspectorRail: View {
    let model: NoteReadViewModel
    let metadataModel: NoteMetadataViewModel
    let backlinks: BacklinksViewModel
    /// Opens a backlink. `nil` with no stack to open it on.
    let open: ((NoteRoute) -> Void)?
    /// Scrolls the note to a heading, by block index.
    let jump: (Int) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                NoteOutlineSection(entries: NoteOutlineEntry.of(model.blocks), jump: jump)
                if let metadata = model.metadata {
                    VStack(alignment: .leading, spacing: Tokens.Space.small) {
                        NoteInspectorHeading(title: "Properties")
                        NotePropertiesBlock(model: model, metadata: metadata, metadataModel: metadataModel)
                    }
                }
                ReviewCommentsSection(comments: model.comments)
                if let open {
                    BacklinksSection(model: backlinks, open: open)
                }
            }
            .padding(Tokens.Space.medium)
        }
        .background(Tokens.Canvas.background.color)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Inspector")
        .accessibilityIdentifier("note.inspector")
    }
}

private struct NoteInspectorHeading: View {
    let title: String

    var body: some View {
        Text(title)
            .font(Tokens.Typography.heading.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .accessibilityAddTraits(.isHeader)
    }
}

/// One heading of the note, as the outline lists it.
struct NoteOutlineEntry: Equatable, Identifiable {
    /// The heading's block index, which is its body row's scroll id.
    let id: Int
    let level: Int
    let title: String

    /// The note's headings in order. A heading with no text has nothing to
    /// list.
    static func of(_ blocks: [Block]) -> [NoteOutlineEntry] {
        blocks.enumerated().compactMap { index, block in
            guard block.kind == "heading" else { return nil }
            let title = block.inline.map(\.text).joined().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            let level = block.props.first { $0.name == "level" }.flatMap { Int($0.value) } ?? 1
            return NoteOutlineEntry(id: index, level: min(max(level, 1), 6), title: title)
        }
    }
}

private struct NoteOutlineSection: View {
    let entries: [NoteOutlineEntry]
    let jump: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            NoteInspectorHeading(title: "Outline")
                .padding(.bottom, Tokens.Space.small)
            if entries.isEmpty {
                Text("No headings in this note.")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            ForEach(entries) { entry in
                Button { jump(entry.id) } label: {
                    Text(entry.title)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(entry.level == 1 ? Tokens.Text.primary.color : Tokens.Text.secondary.color)
                        .multilineTextAlignment(.leading)
                        .padding(.leading, CGFloat(entry.level - 1) * Tokens.Space.medium)
                        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Scrolls the note to this heading")
                .accessibilityIdentifier("note.outline.\(entry.id)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
