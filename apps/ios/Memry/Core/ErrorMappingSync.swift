import Foundation
import MemryCore

// T237. `SyncError`, the sixth core enum the shell can catch.
//
// **It is a separate file for the reason `ErrorMapping.swift`'s own header
// gives**: the split is by enum, one small `switch` each, so that adding a
// variant in Rust stops exactly one function from compiling. `ErrorMapping.swift`
// already carries seven of them plus `LinkingError`, and it is the largest file
// in `Memry/Core`.
//
// **`SyncError` was not covered when T236 landed it**, which is precisely what
// happened to `LinkingError` one task earlier: a caught `LinkingError` fell
// through to `unrecognised` until somebody noticed. `mappedCoreError` now
// dispatches here, and `ErrorMappingSyncTests` asserts every one of the six
// variants lands on its own code rather than on `shell.unrecognised`.
//
// **Nothing here echoes a payload** (Constitution II). `SyncError.UnknownNote`
// carries the note id and no sentence below contains it: a note id identifies
// content, and a string that reaches an alert can reach a screenshot.

extension ErrorMapping {
    /// `SyncError`'s nine variants (`crates/memry-core/src/api/errors.rs`).
    ///
    /// Four are forwarded, and that is the whole reason they are nested rather
    /// than flattened: an `ApiError` reaching the shell inside a sync is the
    /// same fact as one reaching it inside a sign-in, and a second set of
    /// sentences for it would be a second set to keep true.
    ///
    /// The two that are **not** forwarded are the two the core's own doc
    /// comment says must not be collapsed, and each is a different recourse:
    ///
    ///   * `.Locked` is local. No request was made, so no sentence here may
    ///     describe a server or a connection.
    ///   * `.UnknownNote` is **permanent** — "a refusal, never a transient
    ///     fault". It is `.blocked`, and no copy calls it retryable, because
    ///     the record the body would hang on is gone (chapter 07 §7.15).
    static func userFacing(_ error: SyncError) -> UserFacingError {
        switch error {
        case let .Api(source): userFacing(source)
        case let .Storage(source): userFacing(source)
        case let .SecureStore(source): userFacing(source)
        case let .Crypto(source): userFacing(source)
        // Forwarded like the other four, and reachable for a reason worth
        // naming: a WRITE needs this device's signing key and id where a read
        // does not, because an attachment manifest is signed. Uploading asks
        // for an identity that a pull never had to.
        case let .Auth(source): userFacing(source)
        case .Locked: locked
        case .UnknownNote: unknownNote
        case .AttachmentUnverified: attachmentUnverified
        case .AttachmentCorrupt: attachmentCorrupt
        }
    }

    /// Chapter 14 §14.4.1. The manifest is the only thing naming an
    /// attachment — chunks are opaque ciphertext addressed by hash — so a
    /// signature that does not verify means the bytes on offer may not be this
    /// note's at all.
    ///
    /// **`.blocked`, and deliberately not retryable.** Asking again fetches
    /// the same unverifiable manifest. This is also the answer for a signer
    /// device this vault cannot place, which the chapter makes a hard failure
    /// rather than a fallback.
    ///
    /// The device id is not in the sentence: it identifies a user's hardware,
    /// and a string that reaches an alert can reach a screenshot.
    static let attachmentUnverified = UserFacingError(
        code: "sync.attachmentUnverified",
        title: "This attachment could not be verified.",
        guidance: "Memry will not open a file it cannot confirm came from one of your devices. Your note is unchanged.",
        recourse: .blocked,
        isUserVisible: true
    )

    /// The manifest was trustworthy and the transfer was not: a chunk failed
    /// its hash, the whole file failed its checksum, or a chunk would not
    /// decrypt.
    ///
    /// **`.retry`, unlike the one above, and that difference is the point.**
    /// Nothing here suggests the server is lying; the bytes simply arrived
    /// wrong, and fetching them again is a reasonable thing to do.
    static let attachmentCorrupt = UserFacingError(
        code: "sync.attachmentCorrupt",
        title: "This attachment did not download correctly.",
        guidance: "The file was incomplete or damaged in transit. Try again.",
        recourse: .retry,
        isUserVisible: true
    )

    /// The secure store answered **absent**, not locked: this phone holds no
    /// account key, so there is no vault key to open a record with.
    ///
    /// `.blocked` rather than `.retry`: running the same download again cannot
    /// produce a key. The remedy is the unlock step, which both of this build's
    /// two routes reach — the recovery phrase and a nearby computer — so
    /// naming it is true on every screen that can show this sentence
    /// (`DESIGN.md` §"Error copy, in detail", spec-defect 111).
    static let locked = UserFacingError(
        code: "sync.locked",
        title: "This phone holds no key for your account.",
        guidance: "Nothing has been lost. Unlock Memry on this phone before it can download your notes.",
        recourse: .blocked,
        isUserVisible: true
    )

    /// Chapter 07 §7.15. The server still answers with a deleted document's
    /// surviving log, so a body fetched for a note this vault has no live
    /// record of would have nothing to hang on — the core refuses it.
    ///
    /// **Permanent, and the copy says so.** The id is not in the sentence.
    static let unknownNote = UserFacingError(
        code: "sync.unknownNote",
        title: "This vault has no record of that note.",
        guidance: "It may have been deleted on another device. Nothing else was changed.",
        recourse: .blocked,
        isUserVisible: true
    )
}
