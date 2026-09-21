import Foundation
import MemryCore
import SwiftUI

// T157. One note, read-only — **the pre-editor surface, and explicitly the
// placeholder T176 replaces.**
//
// **This is a text preview, not a render** (spec-defect 125, Kaan's decision).
// The body is `NoteBody.text`, which is `extract_text` output: chapter 12
// §12.1's only text operation and what T164 exports. Headings arrive as `# `,
// bullets as `- `, and bold, links and code blocks arrive as plain text with
// no formatting at all. Nothing in this file parses markdown, builds an
// `AttributedString` from markdown, or hosts a web view — §12.1.2 says a
// non-editor client "owns `extract_text` and nothing else", and a faithful
// render would need `Document::encode_state()` exported and the editor bundle
// hosted through `EditorHost`, neither of which exists (spec-defect 107). That
// is T176's work.
//
// **The screen says so, in the one place where it is true.** The caption below
// the body only appears where there *is* body text to be flattened; a note
// with no text on this device is told what is actually true of it instead
// (`DESIGN.md` §"Error copy, in detail", spec-defect 111).
//
// **Read-only, with nothing pretending otherwise.** `Notes` exports
// `folders`, `list` and `read`; T156a is cut, so there is no edit, no share,
// no create and no delete anywhere here — not as a policy, but because no such
// call exists to make.
//
// **Tokens only** (T160): no font, colour, spacing or radius literal appears
// in this file. Logical edges only, Dynamic Type from the type roles, and both
// accessibility preferences branched inside `calmAnimation` and `blockSurface`
// on every evaluation rather than read once into a flag.
//
// **Typography.** The body is the working sans (`Tokens.Typography.body`), not
// the editorial serif. `DESIGN.md` maps sans to "body text and the BlockNote
// editor" and reserves the serif for "journal, reflective copy, and selected
// content titles"; an arbitrary note's flattened text is the first and not the
// second, and the anti-pattern list rejects "large serif text on dense
// operational screens". Mono was also rejected: `DESIGN.md` scopes it to
// "code, recovery material, keyboard-like tokens, paths, and aligned technical
// values", and setting an entire note in it would dress a preview of prose as
// a technical readout.

struct NoteReadView: View {
    @State private var model: NoteReadViewModel

    /// The production entry point. `NotesListView.body`'s one
    /// `navigationDestination(for: NoteRoute.self)` calls exactly this, with
    /// the browse model's own reader — which on the production graph is
    /// `CoreNotesReader` over the shell's serial core queue.
    ///
    /// `State(initialValue:)` so the model outlives a re-render: a model minted
    /// in `body` would re-read the note, and its CRDT apply, every frame.
    /// Pushes another note onto the enclosing stack.
    ///
    /// Handed down rather than declared here: the destination stays registered
    /// once, on `NotesListView.body`, because a `navigationDestination`
    /// declared beside a lazily-realised row is registered only once that row
    /// has been drawn, and a restored path would then resolve against a stack
    /// that never heard of the route (research R15).
    ///
    /// `nil` for a caller with no stack — a preview, or a test rendering this
    /// screen alone. Wiki links then draw as links and go nowhere, which is
    /// the truth about that context.
    private let open: ((NoteRoute) -> Void)?

    init(
        route: NoteRoute,
        reader: any NotesReading,
        filler: (any VaultFilling)? = nil,
        open: ((NoteRoute) -> Void)? = nil
    ) {
        self.open = open
        _model = State(initialValue: NoteReadViewModel(route: route, reader: reader, filler: filler))
        _composer = State(
            initialValue: NoteAttachmentComposer(noteId: route.id, filler: filler)
        )
    }

    init(model: NoteReadViewModel, open: ((NoteRoute) -> Void)? = nil) {
        self.open = open
        _model = State(initialValue: model)
        _composer = State(
            initialValue: NoteAttachmentComposer(noteId: model.route.id, filler: model.filler)
        )
    }

    /// Adds and removes this note's attachments.
    @State private var composer: NoteAttachmentComposer

    /// The title of a wiki link that resolved to nothing, for the notice.
    @State private var brokenLink: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                switch model.phase {
                case .loading:
                    // Words, never a bare spinner, and never a duration.
                    ProgressView { Text("Reading this note") }
                        .progressViewStyle(.circular)
                        .font(Tokens.Typography.supporting.font)
                        .tint(Tokens.Text.secondary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .missing:
                    NoteMissingNotice()
                case let .unreadable(error):
                    ErrorNotice(error: error, code: nil)
                    Button("Try again") { Task { await model.reload() } }
                        .memrySecondaryAction()
                case let .ready(detail):
                    NoteHeader(title: model.displayTitle, summary: detail.summary)
                    // Under the title and above the body, which is where
                    // desktop puts them and where a reader looks for what a
                    // note *is* before reading what it says. Absent until the
                    // read answers, and absent again when there is nothing.
                    if let metadata = model.metadata {
                        NoteMetaView(metadata: metadata)
                    }
                    if model.blocks.isEmpty {
                        // No blocks to draw. Which of the three reasons it is
                        // — never pulled, genuinely empty, or a walk that
                        // failed — is `NoteBodyPreview`'s to say, and it says
                        // a different sentence for each.
                        NoteBodyView(
                            preview: NoteBodyPreview.of(detail.body),
                            fetch: model.fetch,
                            download: model.canFetchBody ? { Task { await model.fetchBody() } } : nil
                        )
                    } else if let open {
                        NoteBlocksView(
                            blocks: model.blocks,
                            openTarget: { title in
                                // Resolved on the tap, then pushed onto the
                                // same stack the browse list pushes onto — a
                                // wiki link leads to a note, not to a second
                                // kind of screen.
                                Task {
                                    if let route = await model.wikiTarget(for: title) {
                                        open(route)
                                    } else {
                                        // A link naming no note. Desktop
                                        // offers to create it; this build
                                        // cannot, so it says what is true
                                        // rather than doing nothing.
                                        brokenLink = title
                                    }
                                }
                            },
                            tableContent: { model.tables[$0] },
                            attachment: { model.attachments[$0] ?? .unknown },
                            removeAttachment: { id in
                                if await composer.detach(attachmentId: id) {
                                    await model.refreshAttachments()
                                }
                            }
                        )
                    } else {
                        // No stack to push onto: the links are still drawn and
                        // still readable, they simply lead nowhere here.
                        NoteBlocksView(
                            blocks: model.blocks,
                            tableContent: { model.tables[$0] },
                            attachment: { model.attachments[$0] ?? .unknown },
                            removeAttachment: { id in
                                if await composer.detach(attachmentId: id) {
                                    await model.refreshAttachments()
                                }
                            }
                        )
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.screenBlock)
        }
        .background(Tokens.Canvas.background.color)
        .calmAnimation(.normal, value: model.phase)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NoteAttachmentPicker(composer: composer) { _ in
                    // The reference list changed, so the bindings have to be
                    // read again: that is what makes the new picture appear
                    // in place rather than on the next note open.
                    Task { await model.refreshAttachments() }
                }
            }
        }
        .task {
            await model.loadIfNeeded()
            // After the body and its bindings are on screen, not before: the
            // placeholders are what FR-045 asks to be visible first, and a
            // fetch that finished early would still only re-render them.
            await model.fetchWaitingAttachments()
        }
        .alert(
            "There is no note called \u{201c}\(brokenLink ?? "")\u{201d}",
            isPresented: Binding(
                get: { brokenLink != nil },
                set: { if !$0 { brokenLink = nil } }
            )
        ) {
            Button("OK", role: .cancel) { brokenLink = nil }
        } message: {
            Text("The link points at a note this vault does not hold. You can create it on your computer.")
        }
    }
}

/// The note's own identity: emoji, title, and the two instants.
///
/// The title is the dominant read of the screen rather than a bar title. It is
/// only known after the read returns, and a navigation bar that showed
/// "Untitled note" while the read was still in flight would be asserting
/// something about a note nobody had looked at yet.
private struct NoteHeader: View {
    let title: String
    let summary: NoteSummary

    /// `nil` means the payload carried no such instant, never "zero"
    /// (data-model §A.6). An absent date is rendered as nothing rather than as
    /// an epoch nobody wrote.
    private static func date(_ milliseconds: Int64?) -> String? {
        guard let milliseconds else { return nil }
        return Date(timeIntervalSince1970: Double(milliseconds) / 1000)
            .formatted(date: .abbreviated, time: .shortened)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if let emoji = summary.emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(Tokens.Typography.screenTitle.font)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(Tokens.Typography.screenTitle.font)
                .foregroundStyle(summary.title.isEmpty
                    ? Tokens.Text.secondary.color
                    : Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            if let line = metadata {
                Text(line)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Only the instants the payload actually carried. A note with neither
    /// shows no line at all rather than a label with nothing after it.
    private var metadata: String? {
        var parts: [String] = []
        if let created = Self.date(summary.createdAt) { parts.append("Created \(created)") }
        if let modified = Self.date(summary.modifiedAt) { parts.append("Edited \(modified)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The body, in its three shapes. No arm is shared, by construction.
private struct NoteBodyView: View {
    let preview: NoteBodyPreview
    let fetch: NoteReadViewModel.Fetch
    /// `nil` when this screen has no filler, in which case the not-pulled
    /// state offers nothing rather than a button that cannot work.
    let download: (() -> Void)?

    var body: some View {
        switch preview {
        case let .text(text):
            // An incomplete fetch leaves real text behind it, so the text is
            // shown and the gap is said beside it rather than instead of it.
            NoteTextPreview(text: text)
            NoteFetchState(fetch: fetch, download: download)
        case .notPulled:
            // The note is here. Its body is not, and that is neither an empty
            // note nor a failure — nothing went wrong, it is simply outside
            // the thirty-day window the first sync pulls bodies for (chapter
            // 10 §10.6.1). **This is the state that must never render as an
            // empty note**, and before T237 it was also a dead end.
            ContentUnavailableView {
                Label("This note's text is not on this phone", systemImage: "icloud.and.arrow.down")
            } description: {
                Text("Memry downloaded this note's title but not its text yet.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            NoteFetchState(fetch: fetch, download: download)
        case .empty:
            // The body arrived and holds nothing. It promises no mechanism
            // this build has: there is no note editing on iOS, so it offers
            // none (`DESIGN.md` §"Error copy, in detail").
            ContentUnavailableView {
                Label("This note has no text", systemImage: "text.append")
            } description: {
                Text("The note is on this phone and its text is empty.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The preview itself, and the sentence that keeps it honest.
///
/// `.textSelection(.enabled)` because this is the only way to get a note's
/// words off this build — there is no share, no export and no editor — and a
/// reading surface a user cannot copy from is a worse placeholder than it
/// needs to be.
private struct NoteTextPreview: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            Text(text)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(Self.caption)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Tokens.Space.inset)
        .blockSurface()
    }

    /// True of every note this view can show text for, and of no other screen
    /// in this feature — which is why it lives here and not one level up.
    static let caption = """
        A plain-text preview. Headings, lists and quotes keep a marker; \
        bold, links, images and code blocks appear as plain text. \
        This build cannot edit a note.
        """
}

/// A route that resolves to no note.
///
/// Distinct from a failed read, and distinct from a note with no text. A
/// restored navigation path and a note deleted on another device both land
/// here, and neither is an error the user can do anything about.
private struct NoteMissingNotice: View {
    var body: some View {
        ContentUnavailableView {
            Label("This note is not in this vault", systemImage: "doc.questionmark")
        } description: {
            Text("It may have been deleted, or this device has no record of it.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The on-demand body fetch, in the four shapes it can be in.
///
/// The button is offered only where it would do something: no filler, no
/// button. `SyncError.UnknownNote` and `SyncError.Locked` both map to
/// `.blocked`, so neither offers a repeat — `UnknownNote` is a **permanent**
/// refusal and calling it retryable would be a sentence that is not true.
private struct NoteFetchState: View {
    let fetch: NoteReadViewModel.Fetch
    let download: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            switch fetch {
            case .idle:
                if let download {
                    Button("Download this note's text", action: download)
                        .memrySecondaryAction()
                }
            case .fetching:
                // Words, never a bare spinner, and never a duration.
                ProgressView { Text("Downloading this note's text") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
                    .tint(Tokens.Text.secondary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .incomplete:
                Text(Self.incomplete)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let download {
                    Button("Try the rest", action: download)
                        .memrySecondaryAction()
                }
            case let .failed(error):
                ErrorNotice(error: error, code: nil)
                if error.recourse == .retry, let download {
                    Button("Try again", action: download)
                        .memrySecondaryAction()
                }
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Chapter 07 §7.9: the pull stopped at an update this device could not
    /// open and the cursor did not advance, so the rest is retried rather than
    /// lost. Neither "complete" nor "failed" would be true of it.
    static let incomplete = """
        Part of this note's text could not be opened on this phone. \
        Nothing was lost, and Memry carries on from where it stopped.
        """
}

