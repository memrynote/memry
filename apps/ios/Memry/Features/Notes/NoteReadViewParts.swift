import Foundation
import MemryCore
import SwiftUI

// The read screen's smaller views, split from `NoteReadView.swift`.

/// The note's own identity: emoji, title, and the two instants.
///
/// The title is the dominant read of the screen rather than a bar title. It is
/// only known after the read returns, and a navigation bar that showed
/// "Untitled note" while the read was still in flight would be asserting
/// something about a note nobody had looked at yet.
struct NoteHeader: View {
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
struct NoteBodyView: View {
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
struct NoteTextPreview: View {
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
struct NoteMissingNotice: View {
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
struct NoteFetchState: View {
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
