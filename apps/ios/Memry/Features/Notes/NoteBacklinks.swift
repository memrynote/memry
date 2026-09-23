import MemryCore
import Observation
import SwiftUI
import UIKit

// The notes linking here (N800), split from `NotePageShell.swift`.

/// The notes linking to this one.
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
        case ready([Backlink])
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

    private func load() async {
        guard let search else {
            phase = .ready([])
            return
        }
        do {
            phase = .ready(try await search.backlinks(noteId: noteId, order: order))
        } catch {
            Log.storage.error("the backlinks could not be read")
            phase = .failed(ErrorMapping.userFacing(error))
        }
    }
}

struct BacklinksSection: View {
    let model: BacklinksViewModel
    let open: (NoteRoute) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack {
                Text("Linked from")
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer()
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

            switch model.phase {
            case .loading:
                ProgressView()
                    .progressViewStyle(.circular)
            case let .ready(backlinks):
                if backlinks.isEmpty {
                    Text("No note links here yet.")
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                } else {
                    ForEach(backlinks, id: \.sourceId) { backlink in
                        Button {
                            open(NoteRoute(id: backlink.sourceId))
                        } label: {
                            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                                Text(
                                    backlink.viaProperty
                                        // Desktop's own label for a link that
                                        // is not a sentence the user wrote.
                                        ? "\(backlink.targetTitle) → \(backlink.sourceTitle)"
                                        : backlink.sourceTitle
                                )
                                .font(Tokens.Typography.body.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            case let .failed(error):
                ErrorNotice(error: error, code: nil)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await model.loadIfNeeded() }
    }
}
