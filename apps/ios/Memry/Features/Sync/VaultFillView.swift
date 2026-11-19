import MemryCore
import SwiftUI

// T237's screen. The vault's contents while its first sync runs (FR-028).
//
// **The contents are rendered in every phase.** This used to swap the whole
// vault for a "Setting up this vault" screen until the run ended, so a run
// that took a day, or was killed by every screen lock and restarted on every
// launch, left the user staring at a bar over notes that were already on the
// phone. The core's own promise is that app open is never blocked on a first
// sync (`first_sync.rs`), and this screen now keeps it: the run is a strip
// above the contents, and a note whose body has not arrived yet fetches it
// when opened (`NoteReadViewModel.refreshFromRemote`).
//
// **`DESIGN.md` names no progress surface.** "loading" appears only in the
// component-state list and the review checklist. What is chosen here is the
// smallest thing consistent with what it does say: words rather than a bare
// spinner, no duration the user cannot use, no promise of a mechanism this
// build does not have, and the platform's own `ProgressView` rather than a
// hand-built bar, so Dynamic Type, RTL mirroring and the VoiceOver value come
// from the system.
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
        case let .progress(progress):
            FirstSyncStrip(progress: progress)
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

/// The run, as a strip above the vault's contents.
private struct FirstSyncStrip: View {
    let progress: SyncProgress?

    /// The bar takes the leading space; a trailing action, such as a way to
    /// report a run that seems stuck, sits beside it on the same line.
    var body: some View {
        HStack(alignment: .center, spacing: Tokens.Space.medium) {
            bar.frame(maxWidth: .infinity, alignment: .leading)
            // A first sync that seems stuck is the report this exists for.
            FeedbackSheetButton()
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.vertical, Tokens.Space.small)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Canvas.surface.color)
        .overlay(alignment: .bottom) {
            Tokens.Line.border.color.frame(height: Tokens.Size.hairline)
        }
    }

    /// Words in every case, and a determinate bar only where there is a real
    /// denominator. `SyncProgress.completed` is never above `total`, so the
    /// fraction needs no guard against one above 1.
    ///
    /// **What VoiceOver says, and how often.** The bar is one accessibility
    /// element: the label is the pass, the value is a whole percentage.
    /// Nothing here posts an announcement — a run over thousands of notes
    /// ticks dozens of times, and a strip that interrupted the user on each
    /// one, while they read a note, would be unusable. A focused
    /// `ProgressView` is read when the user asks, which is the platform
    /// behaviour.
    @ViewBuilder
    private var bar: some View {
        if let progress, progress.total > 0 {
            let fraction = Double(progress.completed) / Double(progress.total)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                ProgressView(value: Double(progress.completed), total: Double(progress.total)) {
                    Text(Self.sentence(for: progress.phase))
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                // A tint fill, which is what `DESIGN.md` reserves the accent
                // for. Nothing here rests on the colour: the count under it
                // says the same thing in words.
                .tint(Tokens.Tint.base.color)
                // A count the user can act on — unlike a duration, which this
                // strip still refuses to invent.
                Text("\(progress.completed) of \(progress.total) notes")
                    .font(Tokens.Typography.technicalCaption.font.monospacedDigit())
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Self.sentence(for: progress.phase))
            .accessibilityValue("\(Int(fraction * 100)) per cent")
            // Reduce-motion branched at the modifier level: under the
            // preference this resolves to no animation at all, so the bar
            // keeps the final state and loses the movement.
            .calmAnimation(.normal, .moving, value: progress.completed)
        } else {
            HStack(spacing: Tokens.Space.small) {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(Tokens.Text.secondary.color)
                Text("Starting")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// One sentence per pass. `DESIGN.md` names no vocabulary for these, so
    /// they say what the pass does in the user's terms rather than the
    /// protocol's — "refs", "metadata" and "CRDT updates" are chapter 05 and
    /// chapter 07 words and mean nothing on a phone.
    static func sentence(for phase: SyncPhase) -> String {
        switch phase {
        case .refs: "Checking what this vault holds"
        case .metadata: "Bringing in your notes"
        case .bodies: "Downloading recent notes"
        case .done: "Finishing"
        }
    }
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
