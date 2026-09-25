import MemryCore
import SwiftUI

// T155's screen. Every vault on the account, and the one the phone opens.
//
// **Tokens only** (T160). No font, colour, spacing or radius literal appears
// below; `DESIGN.md` is reached through `Tokens` and the two action modifiers,
// so a theme or a contrast fix lands here without this file being edited.
//
// **Logical edges only.** SwiftUI's `.leading`/`.trailing` are already
// direction-relative, so RTL is the default rather than a pass; there is no
// `.left` or `.right` anywhere in the target. Dynamic Type comes from the type
// roles, and reduce-motion is branched inside `calmAnimation` on every
// evaluation rather than read once into a flag.
//
// **Empty and unreadable are two screens**, because they are two facts. An
// account with no vaults gets an empty state that says what is absent; a
// registry that would not load gets an error with a retry. Rendering the
// second as the first is the bug the core's reader already had once.

struct VaultListView: View {
    let model: VaultSelectionViewModel

    /// T156's hand-off, and the only edge out of this screen.
    ///
    /// An opened vault stops being a notice and becomes the browse surface.
    /// It replaces this view rather than nesting inside it: `NotesListView`
    /// owns a `NavigationStack`, and a stack inside this `ScrollView` would be
    /// a scroll view inside a scroll view with no bounded height. The switch
    /// is handed on so it stays reachable from there (FR-021).
    var body: some View {
        if case let .opened(summary) = model.phase, let vault = model.vault {
            opened(vault, summary)
        } else {
            selection
        }
    }

    /// T237, and the answer to spec-defect 136.
    ///
    /// **The browse screen is on the far side of the pull.** Before this, an
    /// opened vault went straight to `NotesListView`, which reads a local
    /// database that nothing on the FFI surface had ever put a row in — so a
    /// phone that had never synced showed "no notes" against an account
    /// holding ninety-four. `VaultFillView` is the gate; it asks
    /// `isFirstSyncComplete()` first, which makes no request, so a vault this
    /// phone already has is reached without waiting on a network.
    ///
    /// With no filler — a caller that supplied no `VaultFillerMinting` — the
    /// old path is what runs. That is deliberate: browsing what is already on
    /// the phone is still correct, it is simply not the whole story.
    @ViewBuilder
    private func opened(_ vault: Vault, _ summary: VaultSummary) -> some View {
        if let filler = model.filler {
            VaultFillView(filler: filler) { browse(vault, summary, filler) }
        } else {
            browse(vault, summary, nil)
        }
    }

    private func browse(
        _ vault: Vault,
        _ summary: VaultSummary,
        _ filler: (any VaultFilling)?
    ) -> some View {
        // The tab shell, not the notes screen directly: an opened vault is the
        // whole product surface, and Notes is one of its five tabs.
        VaultTasksScope(vault: vault, secureStore: model.secureStore, filler: filler) { tasksStore, tasksFailure in
            VaultSettingsScope(vault: vault, model: model, tasks: tasksStore) { settings, browse in
            VaultTabsView(notes: {
                NotesListView(
                    vault: vault,
                    title: VaultLabel(summary).text,
                    executor: .shared,
                    filler: filler,
                    // The writes need this device's identity, and the keychain is
                    // where its signing key lives. A screen built without one
                    // browses and offers no write it cannot make.
                    store: model.secureStore,
                    switchVault: model.isSwitchable ? { Task { await model.chooseAgain() } } : nil
                )
            }, tasks: {
                TasksTabContent(store: tasksStore, failure: tasksFailure)
            }, more: {
                // Spec 006: More › Settings, built next to the tasks store.
                MoreTabView(context: settings, browse: browse)
            })
            }
        }
    }

    private var selection: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                switch model.phase {
                case .loading:
                    working("Looking for your vaults")
                case let .choosing(summaries):
                    header(
                        "Choose a vault",
                        "This account holds more than one. Memry opens the one you pick on this phone."
                    )
                    VaultChoiceList(summaries: summaries) { summary in
                        Task { await model.open(summary) }
                    }
                    // Where a vault comes from, since this screen cannot make
                    // one: the core exports no vault creation, so the sentence
                    // stands in for a button that would not work.
                    Text("Vaults are created in Memry on your computer. New ones appear here on their own.")
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .empty:
                    EmptyVaultsNotice()
                case let .unreadable(error):
                    header("Your vaults could not be loaded", nil)
                    ErrorNotice(error: error, code: nil)
                    retry("Try again")
                case let .opening(summary):
                    working("Opening \(VaultLabel(summary).text)")
                case let .opened(summary):
                    OpenedVaultNotice(label: VaultLabel(summary))
                    if model.isSwitchable {
                        retry("Switch vault")
                    }
                case let .failedToOpen(summary, error):
                    header("\(VaultLabel(summary).text) could not be opened", nil)
                    ErrorNotice(error: error, code: nil)
                    retry(model.isSwitchable ? "Choose another vault" : "Try again")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.screenBlock)
        }
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.phase)
        .task { await model.load() }
    }

    private func header(_ title: String, _ detail: String?) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(title)
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
            if let detail {
                Text(detail)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Two sentences are one thought. VoiceOver should not stop between them
        // and lose the half that says what to do.
        .accessibilityElement(children: .combine)
    }

    /// Words, never a bare spinner, and never a duration: an open runs the
    /// database migrations and there is no honest number to show for that.
    private func working(_ what: String) -> some View {
        ProgressView { Text(what) }
            .progressViewStyle(.circular)
            .font(Tokens.Typography.supporting.font)
            .tint(Tokens.Text.secondary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func retry(_ title: String) -> some View {
        Button(title) { Task { await model.chooseAgain() } }
            .memrySecondaryAction()
    }
}

/// The rows. One button per vault, at the 44pt floor, with the id nowhere on
/// screen — it identifies content and reads as noise.
private struct VaultChoiceList: View {
    let summaries: [VaultSummary]
    let choose: (VaultSummary) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            ForEach(summaries, id: \.id) { summary in
                Button { choose(summary) } label: {
                    VaultRowLabel(label: VaultLabel(summary))
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                .blockSurface(radius: Tokens.Radius.control)
                .accessibilityLabel(VaultLabel(summary).text)
                .accessibilityHint("Opens this vault on this phone.")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One row's text.
///
/// A vault with no name, and a vault whose name is empty, are rendered as
/// placeholders rather than as blank rows — and they say different things,
/// because `VaultSummary.name` keeps them apart deliberately.
private struct VaultRowLabel: View {
    let label: VaultLabel

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            // The mark, not a padlock: every vault on this screen is locked,
            // so a padlock on all three rows distinguishes nothing.
            MemryMark()
                .fill(Tokens.Text.secondary.color)
                .frame(width: 20 * MemryMark.aspectRatio, height: 20)
                .frame(width: Tokens.Size.minimumHitArea - Tokens.Space.small,
                       height: Tokens.Size.minimumHitArea - Tokens.Space.small)
                .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.control))
            Text(label.text)
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(label.isPlaceholder
                    ? Tokens.Text.secondary.color
                    : Tokens.Text.primary.color)
            Spacer(minLength: Tokens.Space.tight)
            Image(systemName: "chevron.forward")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An account that really holds no vault.
///
/// It says what is absent and where a vault comes from, and it promises no
/// mechanism this screen has: there is no "create a vault" on iOS, so it does
/// not offer one (`DESIGN.md` §"Error copy, in detail", spec-defect 111).
private struct EmptyVaultsNotice: View {
    var body: some View {
        ContentUnavailableView {
            Label("No vaults yet", systemImage: "tray")
        } description: {
            Text("This account holds no vaults. Create one in Memry on your computer and it will appear here.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What the phone shows once a vault is open.
///
/// Deliberately thin: the folder tree is T156's and the note is T157's, and
/// this is the surface they replace. It exists so that a successful open is
/// visibly a success rather than a screen that does not change.
private struct OpenedVaultNotice: View {
    let label: VaultLabel

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(label.text)
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(label.isPlaceholder
                    ? Tokens.Text.secondary.color
                    : Tokens.Text.primary.color)
            Text("This vault is open on this phone.")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
