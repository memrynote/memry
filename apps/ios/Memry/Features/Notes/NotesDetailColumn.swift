import MemryCore
import SwiftUI

// #4346, #4377. The Notes split view's detail column: the note, with the notes
// opened from inside it stacked behind it, and a second note beside it while
// the split shows (`DESIGN.md` › Tablet › Lists and details).
//
// **Panes.** Each pane is its own `NavigationStack` over the router's pane, so
// Back in one never moves the other. Both draw `NoteReadView` over the same
// browse model: one vault session, one editor, and one document per note in
// the core, so two panes on the same note write to the same document.
//
// **Focus.** A touch anywhere in a pane focuses it (`TouchDown`), as a click
// in a desktop pane activates its group. The focused pane carries an accent
// line along its top while both show, and takes what the list, search and the
// menu bar open.
//
// **Width.** Both panes show where the Notes page holds a note and a rail
// (`SideRailRoom.one`, 1040pt), and the rails yield to them. Below that, the
// column shows the focused pane alone and the router keeps the other. The
// divider starts at 50/50 and keeps each pane at least a rail (`320pt`) wide.

struct NotesDetailColumn: View {
    let model: VaultBrowseViewModel
    let router: NotesSplitRouter
    @Environment(\.requestVaultSync) private var requestVaultSync
    /// Built once: a new closure on every render would change the
    /// environment of the open note and redraw its page while it is typed in.
    @State private var afterWrite: (@MainActor () -> Void)?
    /// Handed to each page: a page pushed onto the stack does not see an
    /// environment set outside it.
    @Environment(\.noteInspectorFits) private var inspectorFits
    @State private var width: CGFloat = 0
    /// The main pane's width while the divider is dragged.
    @State private var dragged: CGFloat?

    var body: some View {
        HStack(spacing: 0) {
            if router.shows(.main) {
                pane(.main).frame(width: router.splitShown ? mainWidth : nil)
            }
            if router.shows(.side) {
                if router.splitShown { divider }
                pane(.side)
            }
        }
        .coordinateSpace(.named(Self.space))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        // Every write in the note asks for a sync pass. The list stays on
        // screen beside it, so it re-reads too: a new title or a move shows
        // in its row at once, where the phone stack re-reads on Back.
        .environment(\.requestVaultSync, afterWrite)
        .onChange(of: requestVaultSync == nil, initial: true) {
            let upstream = requestVaultSync
            afterWrite = { [model] in
                upstream?()
                Task { await model.refresh() }
            }
        }
    }

    private var available: CGFloat { max(0, width - Tokens.Size.hairline) }

    private var mainWidth: CGFloat {
        clamped(dragged ?? available * router.ratio)
    }

    private func clamped(_ value: CGFloat) -> CGFloat {
        let least = Tokens.Size.rail
        guard available >= least * 2 else { return available / 2 }
        return min(max(value, least), available - least)
    }

    private func pane(_ slot: NotesPaneSlot) -> some View {
        let focused = router.splitShown && router.focus == slot
        // Every `NavigationStack` in the column pushes onto the column's own
        // stack, over both panes (VERIFY-4700). While both show, a pane's
        // stack holds no path: its root draws the pane's current note, and
        // the Back in the pane's header pops it (`NotesPaneHeader`). A path
        // the stack reports then (its pop as the split opens) is not the
        // pane's trail.
        let stacked = !router.splitShown
        return NavigationStack(path: Binding(
            get: { stacked ? router.pane(slot)?.trail ?? [] : [] },
            set: { if !router.splitShown { router.setTrail($0, in: slot) } }
        )) {
            Group {
                if let note = stacked ? router.pane(slot)?.note : router.pane(slot)?.current {
                    reader(note, in: slot).id(note)
                } else if slot == .side {
                    NotesPanePicker(model: model) { router.open($0, in: .side) }
                } else {
                    NotesEmptyDetail(model: model, router: router)
                }
            }
            .navigationDestination(for: NoteRoute.self) { reader($0, in: slot) }
        }
        .overlay(alignment: .top) {
            if focused {
                Rectangle()
                    .fill(Tokens.Tint.base.color)
                    .frame(height: 2)
                    .accessibilityHidden(true)
            }
        }
        .gesture(TouchDown { _ in router.activate(slot) })
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(focused ? .isSelected : [])
        // Names each pane's header controls apart for VoiceOver (#4699).
        .accessibilityLabel(router.splitShown ? NotesPaneCopy.pane(slot) : "")
        .accessibilityIdentifier("notes.pane.\(slot.rawValue)")
    }

    /// Desktop's resize handle: quiet at rest, a wider hit area than it draws.
    private var divider: some View {
        Rectangle()
            .fill(Tokens.Line.border.color)
            .frame(width: Tokens.Size.hairline)
            .ignoresSafeArea()
            .overlay {
                Color.clear
                    .frame(width: Tokens.Space.medium * 2)
                    .contentShape(.rect)
                    .gesture(
                        DragGesture(minimumDistance: 1, coordinateSpace: .named(Self.space))
                            .onChanged { dragged = clamped($0.location.x) }
                            .onEnded { _ in
                                if let dragged, available > 0 { router.ratio = dragged / available }
                                dragged = nil
                            }
                    )
                    .accessibilityElement()
                    .accessibilityLabel(NotesPaneCopy.resize)
                    .accessibilityValue(Text(router.ratio, format: .percent.precision(.fractionLength(0))))
                    .accessibilityAdjustableAction { direction in
                        let step = direction == .increment ? 0.05 : -0.05
                        if available > 0 { router.ratio = clamped(available * (router.ratio + step)) / available }
                    }
                    .accessibilityIdentifier("notes.pane.divider")
            }
            .zIndex(1)
    }

    private static let space = "notes.detail"

    private func reader(_ route: NoteRoute, in slot: NotesPaneSlot) -> some View {
        NoteReadView(
            route: route,
            reader: model.reader,
            filler: model.filler,
            editor: model.editor,
            metadataWriter: model.metadataWriter,
            writer: model.writer,
            search: model.searcher,
            open: { router.follow($0, in: slot) },
            openTag: { router.show(.tag($0)) },
            noteTasks: model.noteTasks
        )
        .environment(\.noteInspectorFits, inspectorFits)
        .environment(\.notesPane, NotesPaneContext(router: router, slot: slot))
    }
}

/// An empty side pane: the vault's notes, most recently edited first.
private struct NotesPanePicker: View {
    let model: VaultBrowseViewModel
    let open: (NoteRoute) -> Void
    @State private var query = ""

    private var notes: [NoteSummary] {
        let all = (model.outline?.allNotes ?? []).sorted { ($0.modifiedAt ?? 0) > ($1.modifiedAt ?? 0) }
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return all }
        return all.filter { $0.title.localizedStandardContains(needle) }
    }

    var body: some View {
        List(notes, id: \.id) { note in
            Button { open(NoteRoute(id: note.id)) } label: {
                Text(note.title.isEmpty ? "Untitled note" : note.title)
                    .foregroundStyle(note.title.isEmpty ? Tokens.Text.secondary.color : Tokens.Text.primary.color)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("notes.pane.pick.\(note.id)")
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Tokens.Canvas.background.color)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: NotesPaneCopy.pickerPrompt)
        .navigationTitle(NotesPaneCopy.pickerTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// No note open: what is absent and the next useful action.
private struct NotesEmptyDetail: View {
    let model: VaultBrowseViewModel
    let router: NotesSplitRouter

    private var folder: String? {
        if case let .folder(path) = router.scope { return path }
        return nil
    }

    var body: some View {
        ContentUnavailableView {
            Label("No note open", systemImage: "doc.text")
        } description: {
            Text("Choose a note from the list.")
        } actions: {
            if model.writer != nil {
                Button(NotesCreateCopy.newNote, systemImage: "square.and.pencil") {
                    Task {
                        if let id = await model.createNote(in: folder) {
                            router.created(id)
                            router.select(NoteRoute(id: id))
                        }
                    }
                }
                .memryPrimaryAction()
                .accessibilityIdentifier("notes.empty.newNote")
            }
        }
        .background(Tokens.Canvas.background.color)
        .toolbar { DayPanelToolbarItem() }
    }
}
