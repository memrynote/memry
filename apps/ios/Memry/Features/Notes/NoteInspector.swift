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

    /// The reading measure plus the rail, 1040pt, so the note keeps its
    /// measure (`DESIGN.md` › Tablet › Side rails): 13" landscape beside the
    /// page sidebar (about 1086pt) holds it, 13" portrait (1024-1032pt) does
    /// not.
    static let minimumWidth = Tokens.Size.reading + Tokens.Size.rail
}

/// A note page's side rail: the rail beside the page in its own
/// `Tokens.Size.rail` of width, as on Journal's day screen, so the note never
/// slides under it; the toolbar button; and the page's own sections left out
/// while the rail shows.
///
/// The page owns its rail, so a note pushed from a backlink brings its own
/// and Back returns to the one before. Not the system inspector: inside the
/// split view's detail column it closed itself on every push and kept the
/// main thread in layout at launch. Not a rail beside the column's stack
/// either: the split view hosts pushed pages over the whole column.
struct NoteInspector: ViewModifier {
    let rail: NoteInspectorRail

    @Environment(\.noteInspectorFits) private var fits
    @AppStorage(NoteInspectorLayout.openKey) private var isOpen = false

    func body(content: Content) -> some View {
        let shown = fits && isOpen
        HStack(spacing: 0) {
            content
                .environment(\.noteInspectorShown, shown)
            if shown { rail }
        }
        .toolbar {
            if fits {
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
        .frame(width: Tokens.Size.rail)
        .background(Tokens.Canvas.background.color)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Tokens.Line.border.color)
                .frame(width: Tokens.Size.hairline)
                .ignoresSafeArea()
        }
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
