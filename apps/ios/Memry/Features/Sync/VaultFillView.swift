import MemryCore
import SwiftUI

// T237's screen. The vault's contents while its first sync runs (FR-028).
//
// **The contents are rendered in every phase.** This used to swap the whole
// vault for a "Setting up this vault" screen until the run ended, so a run
// that took a day, or was killed by every screen lock and restarted on every
// launch, left the user staring at a bar over notes that were already on the
// phone. The core's own promise is that app open is never blocked on a first
// sync (`first_sync.rs`), and this screen now keeps it: the run is silent and
// in the background, and a note whose body has not arrived yet fetches it
// when opened (`NoteReadViewModel.refreshFromRemote`).
//
// **There is no Cancel, and that is not an omission** (spec-defect 108).
// `rust_future_cancel` appears zero times in the bindings, so an in-flight core
// call cannot be stopped. A button offering to stop it would be a lie.
//
// **A failure is rendered above the contents, never instead of them.** That is
// the whole of requirement five: `SyncError.Api` can arrive after some notes
// have landed, and those notes are real.
//
// **Tokens only** (T160): no font, colour, spacing or radius literal below.
// Logical edges only, Dynamic Type from the type roles, and reduce-motion
// branched inside `calmAnimation` on every evaluation rather than read once.

struct VaultFillView<Content: View>: View {
    @State private var model: VaultFillViewModel
    @ViewBuilder private let content: () -> Content

    /// The production entry point. `VaultListView` calls exactly this with the
    /// filler `VaultSelectionViewModel` minted when the vault was opened.
    ///
    /// `State(initialValue:)` so the model outlives a re-render: a model minted
    /// in `body` would start a second first sync on every frame.
    init(filler: any VaultFilling, @ViewBuilder content: @escaping () -> Content) {
        _model = State(initialValue: VaultFillViewModel(filler: filler))
        self.content = content
    }

    init(model: VaultFillViewModel, @ViewBuilder content: @escaping () -> Content) {
        _model = State(initialValue: model)
        self.content = content
    }

    var body: some View {
        // The contents keep one place in this stack whatever the banner is,
        // so the run ending neither rebuilds the tabs nor drops a pushed note.
        VStack(spacing: 0) {
            banner
            content()
                .environment(\.firstSyncLanded, model.landed)
                .environment(\.firstSyncPending, model.isPending)
        }
        .background(Tokens.Canvas.background.color)
        // Structured, and therefore not leakable: SwiftUI cancels this when
        // the view goes away. Cancelling it abandons the **UI** only — the
        // core call it started runs to completion, which is what spec-defect
        // 108 leaves the shell with and why no button here claims otherwise.
        .task { await model.begin() }
    }

    @ViewBuilder
    private var banner: some View {
        switch model.banner {
        case .none:
            EmptyView()
        case let .failure(error):
            // The contents are underneath, and they are the point. A pull
            // that stopped after forty notes leaves forty real notes.
            SyncFailureNotice(error: error) { Task { await model.retry() } }
                .padding(.horizontal, Tokens.Space.screenInline)
                .padding(.vertical, Tokens.Space.inset)
        case let .incomplete(sentence):
            Text(sentence)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Tokens.Space.screenInline)
                .padding(.vertical, Tokens.Space.inset)
        }
    }
}

extension EnvironmentValues {
    /// ``VaultFillViewModel/landed``: changes each time a running first sync
    /// has landed rows a list shows, so the list re-reads mid-run.
    @Entry var firstSyncLanded: Int = 0
    /// ``VaultFillViewModel/isPending``: the vault's sync passes wait for it.
    @Entry var firstSyncPending: Bool = false
}

/// A first sync that stopped, rendered above whatever did arrive.
///
/// The retry is offered only where the error says repeating can help.
/// `SyncError.UnknownNote` is permanent and `SyncError.Locked` is fixed
/// somewhere else entirely, so neither gets a button that would do nothing.
struct SyncFailureNotice: View {
    let error: UserFacingError
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            ErrorNotice(error: error, code: nil)
            // True whatever stopped it: the passes are durable as they go, so
            // what is below this notice is real.
            Text("What has already arrived is below.")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
            if error.recourse == .retry {
                Button("Continue setting up", action: retry)
                    .memrySecondaryAction()
            }
            FeedbackSheetButton()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
