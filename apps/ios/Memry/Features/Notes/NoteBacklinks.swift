import MemryCore
import Observation
import SwiftUI
import UIKit

// The notes and journal days linking here (N800, JP052), split from
// `NotePageShell.swift`.

/// One row of "Linked from": what it says and where a tap goes.
///
/// A journal source has no title of its own, so its date names it, and it
/// opens the day in the Journal tab rather than a note page
/// (`Search.linksTo`, spec 005-journal JP026).
struct BacklinkEntry: Equatable, Identifiable {
    enum Destination: Equatable {
        case note(NoteRoute)
        case journalDay(String)
    }

    let id: String
    let title: String
    let destination: Destination

    static func of(_ row: BacklinkRow) -> BacklinkEntry {
        if row.sourceKind == "journal",
           let date = row.sourceDate.flatMap(JournalLink.date(fromWikiTarget:))
               ?? JournalLink.date(fromWikiTarget: row.sourceTitle)
               ?? JournalLink.date(fromJournalId: row.sourceId) {
            return BacklinkEntry(id: row.sourceId, title: date, destination: .journalDay(date))
        }
        let title = row.viaProperty
            // Desktop's own label for a link that is not a sentence the user
            // wrote.
            ? "\(row.targetTitle) → \(row.sourceTitle)"
            : (row.sourceTitle.isEmpty ? "Untitled note" : row.sourceTitle)
        return BacklinkEntry(id: row.sourceId, title: title, destination: .note(NoteRoute(id: row.sourceId)))
    }
}

/// The notes and journal days linking to this one.
///
/// **Answerable only since the link projection landed.** `note_links` existed
/// in the index schema and nothing wrote a row into it, so this section would
/// have read "no note links here" forever — which is why it is a section with
/// a real empty state rather than one that hides when empty.
@MainActor
@Observable
final class BacklinksViewModel {
    enum Phase: Equatable {
        case loading
        case ready([BacklinkEntry])
        case failed(UserFacingError)
    }

    private let noteId: String
    private let search: (any VaultSearching)?

    private(set) var phase: Phase = .loading
    var order: BacklinkOrder = .recent {
        didSet {
            guard order != oldValue else { return }
            Task { await load() }
        }
    }

    init(noteId: String, search: (any VaultSearching)?) {
        self.noteId = noteId
        self.search = search
    }

    func loadIfNeeded() async {
        guard case .loading = phase else { return }
        await load()
    }

    /// Re-reads after the index moved under a screen that stays open (a
    /// journal day after a sync pass). Keeps the rows on screen meanwhile.
    func reload() async {
        await load()
    }

    private func load() async {
        guard let search else {
            phase = .ready([])
            return
        }
        do {
            let rows = try await search.linksTo(targetId: noteId, order: order)
            phase = .ready(rows.map(BacklinkEntry.of))
        } catch {
            Log.storage.error("the backlinks could not be read")
            phase = .failed(ErrorMapping.userFacing(error))
        }
    }
}

struct BacklinksSection: View {
    let model: BacklinksViewModel
    let open: (NoteRoute) -> Void

    private var heading: some View {
        Text("Linked from")
            .font(Tokens.Typography.heading.font)
            .foregroundStyle(Tokens.Text.primary.color)
    }

    private var orderPicker: some View {
        Picker("Order", selection: Binding(
            get: { model.order },
            set: { model.order = $0 }
        )) {
            Text("Recent").tag(BacklinkOrder.recent)
            Text("Title").tag(BacklinkOrder.title)
            Text("Oldest").tag(BacklinkOrder.oldest)
        }
        .pickerStyle(.menu)
        .accessibilityLabel("Order backlinks")
    }

    /// The section shows only once there is something to say: a link, or a
    /// failure to read them. Loading and empty draw nothing.
    private var hasContent: Bool {
        switch model.phase {
        case .loading: false
        case let .ready(backlinks): !backlinks.isEmpty
        case .failed: true
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if hasContent { content }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await model.loadIfNeeded() }
    }

    @ViewBuilder
    private var content: some View {
            // One row, stacked when the title and the order do not fit (AX
            // sizes) rather than hyphenating either.
            ViewThatFits(in: .horizontal) {
                HStack {
                    heading
                    Spacer()
                    orderPicker
                }
                VStack(alignment: .leading, spacing: 0) {
                    heading
                    orderPicker
                }
            }

            switch model.phase {
            case .loading:
                EmptyView()
            case let .ready(backlinks):
                ForEach(backlinks) { backlink in
                    BacklinkRowButton(backlink: backlink, open: open)
                }
            case let .failed(error):
                ErrorNotice(error: error, code: nil)
            }
    }
}

/// One backlink: a note pushes its page, a journal day opens in the Journal
/// tab.
struct BacklinkRowButton: View {
    let backlink: BacklinkEntry
    let open: (NoteRoute) -> Void
    /// Runs before a journal day opens, so a sheet listing this row closes.
    var leaving: (() -> Void)?

    @Environment(\.openJournalDay) private var openJournalDay

    var body: some View {
        Button(action: tap) {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(backlink.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                if case .journalDay = backlink.destination {
                    Text(JournalCopy.journalKind)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
            .contentShape(.rect)
        }
        .disabled(isJournal && openJournalDay == nil)
        .accessibilityElement(children: .combine)
        .accessibilityHint(isJournal ? JournalCopy.openInJournal : "")
        .accessibilityIdentifier("note.backlink.\(backlink.id)")
    }

    private var isJournal: Bool {
        if case .journalDay = backlink.destination { return true }
        return false
    }

    private func tap() {
        switch backlink.destination {
        case let .note(route): open(route)
        case let .journalDay(date):
            leaving?()
            openJournalDay?(date)
        }
    }
}

/// The page menu's Backlinks: every note and day linking here, with an empty
/// state the inline section does not draw.
struct NoteBacklinksSheet: View {
    let model: BacklinksViewModel
    let open: (NoteRoute) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                switch model.phase {
                case .loading:
                    ProgressView()
                case let .ready(backlinks) where backlinks.isEmpty:
                    ContentUnavailableView(
                        "No backlinks",
                        systemImage: "arrow.down.left",
                        description: Text("No note or journal day links here yet.")
                    )
                case let .ready(backlinks):
                    ForEach(backlinks) { backlink in
                        BacklinkRowButton(backlink: backlink, open: open) { dismiss() }
                    }
                case let .failed(error):
                    ErrorNotice(error: error, code: nil)
                }
            }
            .navigationTitle("Backlinks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await model.loadIfNeeded() }
    }
}
