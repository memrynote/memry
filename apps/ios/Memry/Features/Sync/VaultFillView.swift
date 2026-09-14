import MemryCore
import SwiftUI

// T237's screen. The minute or so between opening a vault and being able to
// read it (FR-028).
//
// **This screen is new ground and `DESIGN.md` does not name it.** There is no
// progress surface anywhere in that document: "loading" appears only in the
// component-state list and the review checklist, and nothing says what a
// long-running determinate operation looks like. Reported as a gap. What is
// chosen here is the smallest thing consistent with what `DESIGN.md` *does*
// say — words rather than a bare spinner, no duration the user cannot use, no
// promise of a mechanism this build does not have, and the platform's own
// `ProgressView` rather than a hand-built bar, so Dynamic Type, RTL mirroring
// and the VoiceOver value come from the system.
//
// **There is no Cancel, and that is not an omission** (spec-defect 108).
// `rust_future_cancel` appears zero times in the bindings, so an in-flight core
// call cannot be stopped. A button offering to stop it would be a lie. The
// copy says the true thing instead: what has arrived is kept, so an
// interruption is resumed rather than restarted.
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
        Group {
            switch model.phase {
            case .checking:
                FirstSyncScreen(progress: nil, checking: true)
            case let .filling(progress):
                FirstSyncScreen(progress: progress, checking: false)
            case .filled:
                filled
            case let .failed(error):
                // The contents are underneath, and they are the point. A pull
                // that stopped after forty notes leaves forty real notes.
                VStack(spacing: Tokens.Space.medium) {
                    SyncFailureNotice(error: error) { Task { await model.retry() } }
                        .padding(.horizontal, Tokens.Space.screenInline)
                        .padding(.top, Tokens.Space.inset)
                    content()
                }
                .background(Tokens.Canvas.background.color)
            }
        }
        // Structured, and therefore not leakable: SwiftUI cancels this when
        // the view goes away. Cancelling it abandons the **UI** only — the
        // core call it started runs to completion, which is what spec-defect
        // 108 leaves the shell with and why no button here claims otherwise.
        .task { await model.begin() }
    }

    @ViewBuilder
    private var filled: some View {
        if let incomplete = model.incomplete {
            VStack(spacing: Tokens.Space.medium) {
                Text(incomplete)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Tokens.Space.screenInline)
                    .padding(.top, Tokens.Space.inset)
                content()
            }
            .background(Tokens.Canvas.background.color)
        } else {
            content()
        }
    }
}

/// The waiting screen itself.
private struct FirstSyncScreen: View {
    let progress: SyncProgress?
    /// The gate, which makes no request. A separate flag rather than a fourth
    /// `SyncPhase`, because it is not one: nothing is being pulled yet.
    let checking: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.section) {
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                Text("Setting up this vault")
                    .font(Tokens.Typography.screenTitle.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .accessibilityAddTraits(.isHeader)
                Text(Self.explanation)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)

            bar
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.vertical, Tokens.Space.screenBlock)
        .background(Tokens.Canvas.background.color)
    }

    /// Words in every case, and a determinate bar only where there is a real
    /// denominator. `SyncProgress.completed` is never above `total`, so the
    /// fraction needs no guard against one above 1.
    ///
    /// **What VoiceOver says, and how often.** The bar is one accessibility
    /// element: the label is the pass, the value is a whole percentage.
    /// Nothing here posts an announcement — a run over ninety-four notes ticks
    /// dozens of times, and a screen that interrupted the user on each one
    /// would be unusable. A focused `ProgressView` is read when the user asks,
    /// which is the platform behaviour and the right one for a minute-long
    /// wait.
    @ViewBuilder
    private var bar: some View {
        if let progress, progress.total > 0 {
            let fraction = Double(progress.completed) / Double(progress.total)
            ProgressView(value: Double(progress.completed), total: Double(progress.total)) {
                Text(Self.sentence(for: progress.phase))
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .tint(Tokens.Text.primary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Self.sentence(for: progress.phase))
            .accessibilityValue("\(Int(fraction * 100)) per cent")
            // Reduce-motion branched at the modifier level: under the
            // preference this resolves to no animation at all, so the bar
            // keeps the final state and loses the movement.
            .calmAnimation(.normal, .moving, value: progress.completed)
        } else {
            ProgressView {
                Text(checking ? "Checking what this phone already has" : "Starting")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .progressViewStyle(.circular)
            .tint(Tokens.Text.secondary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
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

    /// True on this screen and on no other, which is why it lives here.
    ///
    /// It promises no mechanism this build does not have: there is no Cancel,
    /// so it does not offer one, and it names no duration, because the only
    /// honest one would be a figure the user cannot use (`DESIGN.md`
    /// §"Error copy, in detail", spec-defect 111).
    static let explanation = """
        Memry is bringing this vault onto your phone for the first time. \
        Everything it has already brought in is kept, so if this is \
        interrupted it carries on from there.
        """
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
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
