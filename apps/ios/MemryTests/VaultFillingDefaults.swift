import Foundation
import MemryCore

@testable import Memry

// The attachment fetch, defaulted **for fakes only**.
//
// `VaultFilling` gained `fetchAttachment` when the core did. The scripted
// fillers in this target are about first sync and note bodies, and none of
// them is testing the attachment channel — that is asserted in Rust, against
// the committed `attachment-manifest` class and a scripted transport, where
// the signature order and the metered policy can be reached without a vault.
//
// The default lives here and **not** in the production protocol, for the same
// reason `NotesReadingDefaults` gives: a default on `VaultFilling` itself
// would let `CoreVaultFiller` forget to implement it and silently never fetch
// a picture. It has no default to fall back on, so the compiler is what holds
// it to the surface.
extension VaultFilling {
    /// Deferred, which is the honest default: a fake that reported a download
    /// would let a test pass over bytes nothing ever wrote.
    func fetchAttachment(
        attachmentId: String,
        reachable: Reachable
    ) async throws -> AttachmentFetchSummary {
        AttachmentFetchSummary(
            downloaded: false,
            deferred: true,
            bytes: 0,
            localPath: nil
        )
    }

    /// Refuses, rather than returning a plausible id. A fake that reported a
    /// successful upload would let a test pass over bytes nothing ever put.
    func uploadAttachment(
        noteId: String,
        filename: String,
        mimeType: String,
        bytes: Data
    ) async throws -> String {
        throw SyncError.Locked
    }

    /// Does nothing, which is the honest default for a fake with no server to
    /// dereference against.
    func detachAttachment(noteId: String, attachmentId: String) async throws {}

    /// Nothing to pull and nothing pushed: a fake has no server.
    func syncNow() async throws -> SyncPassSummary {
        SyncPassSummary(pulled: 0, deleted: 0, bodies: 0, pushed: 0, rejected: 0, pending: 0)
    }
}
