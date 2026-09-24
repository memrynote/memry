import Foundation
import MemryCore
import Testing

@testable import Memry

// T142. Assertions here are written against the *neighbour* whose collapse
// `core-api.md` and `shell-seams.md` say produces a specific wrong behaviour,
// because the obvious assertions do not earn their keep: `!text.isEmpty` and
// `text != String(reflecting: error)` both pass under almost every bug a
// mapping can have, including the one where two variants render identically.

/// Stuffed into every associated value that is a `String`, so a mapping that
/// echoed a payload would be caught by its presence rather than by inspection.
private let payload = "correct-horse-battery-staple-A1B2C3"

private func says(_ error: UserFacingError, _ fragment: String) -> Bool {
    error.text.range(of: fragment, options: .caseInsensitive) != nil
}

/// Every variant that mints its own copy. The six delegating variants
/// (`RecoveryError.Crypto`, `CrdtError.Storage`, `ApiError.Transport`,
/// `AuthError.Api`/`.SecureStore`/`.Crypto`) are excluded here and asserted
/// separately, because they are supposed to equal what they delegate to.
/// `ApiError.Status` appears twice: it is one variant with two readings.
private let ownCopy: [any Error] = [
    CryptoError.InvalidLength(what: payload, expected: 32, actual: 31),
    CryptoError.InvalidParameter(what: payload),
    CryptoError.DecryptionFailed,
    CryptoError.EncryptionFailed,
    CryptoError.OutOfMemory(requestedBytes: 67_108_864),
    CryptoError.InvalidBase64,
    CryptoError.InvalidHex,
    RecoveryError.UnknownWord(word: payload),
    RecoveryError.BadChecksum,
    RecoveryError.WrongWordCount(actual: 23),
    RecoveryError.NonAscii,
    RecoveryError.VerifierMismatch,
    CborError.FieldNotInOrdering(fields: payload),
    CborError.Unencodable(what: payload),
    CborError.Malformed(what: payload),
    CompressError.IncompleteDeflateStream,
    CompressError.Corrupt(what: payload),
    CrdtError.DocumentBusy(docId: payload, what: payload),
    CrdtError.Undecodable(docId: payload, what: payload),
    CrdtError.NotApplicable(docId: payload, what: payload),
    ApiError.Storage(what: payload),
    ApiError.Unauthorized(code: payload, message: payload),
    ApiError.DeviceRevoked(message: payload),
    ApiError.RateLimited(retryAfterS: 30, message: payload),
    ApiError.WritesDisabled(message: payload),
    ApiError.UpgradeRequired(minVersion: payload, message: payload),
    ApiError.BootstrapUnavailable,
    ApiError.Status(status: 400, code: payload, message: payload),
    ApiError.Status(status: 503, code: payload, message: payload),
    ApiError.MalformedResponse(path: payload, what: payload),
    ApiError.InvalidClientIdentity(what: payload),
    AuthError.InvalidState(action: payload, state: payload),
    AuthError.MalformedToken(what: payload),
    AuthError.RefreshBlocked(retryInMs: 5_000),
    AuthError.SessionExpired,
    AuthError.NoSetupToken,
    SecureStoreError.Locked,
    SecureStoreError.Denied(what: payload),
    SecureStoreError.Failed(what: payload),
    StorageError.NotOpen,
    StorageError.Migration(version: 21, what: payload),
    StorageError.MissingFts5,
    StorageError.IndexRebuildRequired(what: payload),
    StorageError.OutOfSpace(neededBytes: 1, availableBytes: 0),
    StorageError.Failed(what: payload),
    StorageError.NotFound(what: payload),
    StorageError.Invalid(what: payload),
    TransportError.Offline,
    TransportError.Timeout(elapsedMs: 30_000),
    TransportError.Tls(what: payload),
    TransportError.Cancelled,
    TransportError.Failed(what: payload),
    TransportError.SocketClosed(code: 1006, reason: payload),
    CaptureError.NotPermitted,
    CaptureError.Restricted,
    CaptureError.Cancelled,
    CaptureError.Failed(what: payload),
    NotificationError.NotPermitted,
    NotificationError.LimitReached,
    NotificationError.Failed(what: payload),
    BackgroundError.Unavailable,
    BackgroundError.Failed(what: payload),
    EditorError.NotAttached,
    EditorError.Timeout(elapsedMs: 4_000),
    EditorError.ProtocolMismatch(expected: 2, found: 1),
    EditorError.Failed(what: payload)
]

@Suite("ErrorMapping")
struct ErrorMappingTests {
    // MARK: - Totality

    @Test("every variant the core can raise reaches copy of its own")
    func everyVariantIsRecognised() {
        for error in ownCopy {
            let mapped = ErrorMapping.userFacing(error)
            #expect(mapped.code != ErrorMapping.unrecognised.code, "fell through: \(type(of: error))")
            #expect(!mapped.title.trimmingCharacters(in: .whitespaces).isEmpty)
            #expect(mapped.guidance?.isEmpty != true)
        }
    }

    /// The assertion this suite exists for. A mapping that renders two variants
    /// identically has thrown away a distinction the core paid to keep, and no
    /// per-variant assertion catches it — this one does, for all 64 at once.
    @Test("no two variants render the same thing")
    func noTwoVariantsCollapse() {
        var seen: [UserFacingError: String] = [:]
        for error in ownCopy {
            let mapped = ErrorMapping.userFacing(error)
            let name = "\(type(of: error)).\(mapped.code.description)"
            #expect(seen[mapped] == nil, "\(name) renders identically to \(seen[mapped] ?? "")")
            seen[mapped] = name
        }
        #expect(seen.count == ownCopy.count)
    }

    @Test("no payload from an error ever reaches the sentence")
    func payloadsNeverLeak() {
        for error in ownCopy {
            let mapped = ErrorMapping.userFacing(error)
            #expect(!mapped.text.contains(payload), "echoed its payload: \(mapped.code.description)")
            #expect(!mapped.text.contains("MemryCore"), "leaked a raw case: \(mapped.code.description)")
            #expect(mapped.text != String(reflecting: error))
            #expect(mapped.text != (error as? any LocalizedError)?.errorDescription)
        }
    }

    @Test("every code is a literal with no room for a payload")
    func codesArePayloadFree() {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.")
        for error in ownCopy {
            let code = ErrorMapping.userFacing(error).code.description
            #expect(!code.isEmpty)
            #expect(code.allSatisfy(allowed.contains), "not a bare identifier: \(code)")
        }
    }

    // MARK: - The distinctions core-api.md names

    /// Collapsing this one tells the user to re-type a phrase that was correct.
    @Test("an Argon2id out-of-memory does not read as a wrong phrase")
    func outOfMemoryDoesNotBlameThePhrase() {
        let oom = ErrorMapping.userFacing(CryptoError.OutOfMemory(requestedBytes: 67_108_864))
        let wrongKey = ErrorMapping.userFacing(CryptoError.DecryptionFailed)
        #expect(oom != wrongKey)
        #expect(says(oom, "memory"))
        #expect(says(oom, "correct"), "must say the phrase was fine")
        #expect(!says(wrongKey, "correct"))
        #expect(oom.recourse == .retry)
    }

    /// `RecoveryError.Crypto` carries the crypto variant for exactly this
    /// reason. Rendering it as the enclosing recovery failure is the bug.
    @Test("an out-of-memory inside a recovery failure still reads as memory")
    func recoveryDelegatesToCrypto() {
        let nested = ErrorMapping.userFacing(RecoveryError.Crypto(source: .OutOfMemory(requestedBytes: 67_108_864)))
        #expect(nested == ErrorMapping.userFacing(CryptoError.OutOfMemory(requestedBytes: 67_108_864)))
        #expect(nested != ErrorMapping.userFacing(RecoveryError.BadChecksum))
        // Equality alone passes if both sides are broken the same way, which is
        // how this assertion survived a run that collapsed the crypto arm. The
        // claim is about what the user reads, so assert that.
        #expect(says(nested, "memory"))
        #expect(says(nested, "correct"))
    }

    @Test("an unknown word and a bad checksum give different instructions")
    func unknownWordIsNotBadChecksum() {
        let unknown = ErrorMapping.userFacing(RecoveryError.UnknownWord(word: payload))
        let checksum = ErrorMapping.userFacing(RecoveryError.BadChecksum)
        #expect(unknown.guidance != checksum.guidance)
        #expect(says(unknown, "word list"))
        #expect(says(checksum, "order"))
        // A recovery word is key material and never appears in a sentence.
        #expect(!says(unknown, payload))
    }

    /// "This device cannot read its own database" must not read as "the server
    /// is unreachable" — the two want different things said.
    @Test("a local storage failure is never reported as a network failure")
    func apiStorageIsNotTheNetwork() {
        let disk = ErrorMapping.userFacing(ApiError.Storage(what: payload))
        let offline = ErrorMapping.userFacing(ApiError.Transport(source: .Offline))
        for word in ["server", "network", "connection", "offline", "unreachable"] {
            #expect(!says(disk, word), "reads as a network failure: \(word)")
        }
        #expect(says(disk, "this phone"))
        #expect(says(offline, "offline"))
        #expect(disk != offline)
    }

    /// Three distinct client policies (chapter 11): read-only,
    /// blocked-pending-upgrade, unentitled.
    @Test("the three write refusals stay three")
    func writeRefusalsStayDistinct() {
        let readOnly = ErrorMapping.userFacing(ApiError.WritesDisabled(message: payload))
        let upgrade = ErrorMapping.userFacing(ApiError.UpgradeRequired(minVersion: "9.9.9", message: payload))
        let unentitled = ErrorMapping.userFacing(ApiError.Unauthorized(code: payload, message: payload))
        #expect(Set([readOnly, upgrade, unentitled]).count == 3)
        #expect(says(readOnly, "read-only"))
        #expect(readOnly.recourse == .retryLater, "the outbox parks; the user retries nothing")
        #expect(says(upgrade, "update"))
        #expect(upgrade.recourse == .blocked)
        #expect(says(unentitled, "sign in"))
        #expect(!says(readOnly, "sign in"))
    }

    /// "The latch is holding, try later" versus "this session is gone".
    /// Collapsing them signs the user out on a transient refusal, or spins
    /// forever on a dead session.
    @Test("a blocked refresh does not sign the user out")
    func refreshBlockedIsNotSessionExpired() {
        let blocked = ErrorMapping.userFacing(AuthError.RefreshBlocked(retryInMs: 5_000))
        let expired = ErrorMapping.userFacing(AuthError.SessionExpired)
        #expect(blocked != expired)
        #expect(!says(blocked, "sign in"), "told the user to sign in on a transient refusal")
        #expect(blocked.recourse == .retryLater)
        #expect(says(expired, "sign in"))
        #expect(expired.recourse == .blocked)
    }

    // MARK: - The distinctions shell-seams.md names

    /// Reading "no master key" from a locked device and re-registering throws
    /// the master key away.
    @Test("a locked keychain is not a missing key")
    func lockedIsNotAbsent() {
        let locked = ErrorMapping.userFacing(SecureStoreError.Locked)
        #expect(says(locked, "unlock"))
        #expect(!says(locked, "sign in"))
        #expect(locked.recourse == .retryLater)
        #expect(locked != ErrorMapping.userFacing(SecureStoreError.Failed(what: payload)))
        // And through `AuthError`, which is how it actually reaches a view.
        #expect(ErrorMapping.userFacing(AuthError.SecureStore(source: .Locked)) == locked)
    }

    /// The most serious open item in the tree: a permanently rejected record
    /// wedges the outbox and retries forever. What the user sees must not read
    /// as transient.
    @Test("a refused request does not offer a retry that cannot work")
    func refusalIsNotTransient() {
        let refused = ErrorMapping.userFacing(ApiError.Status(status: 400, code: payload, message: payload))
        let serverFault = ErrorMapping.userFacing(ApiError.Status(status: 503, code: payload, message: payload))
        #expect(refused != serverFault)
        #expect(refused.recourse == .blocked)
        #expect(!says(refused, "try again"))
        #expect(serverFault.recourse == .retryLater)
        #expect(says(serverFault, "try again"))
    }

    @Test("a certificate failure is never offered as retryable")
    func tlsIsNotRetryable() {
        let tls = ErrorMapping.userFacing(TransportError.Tls(what: payload))
        #expect(tls.recourse == .blocked)
        #expect(tls != ErrorMapping.userFacing(TransportError.Failed(what: payload)))
        #expect(ErrorMapping.userFacing(TransportError.Failed(what: payload)).recourse == .retry)
    }

    /// Sending a user to Settings to grant a permission an MDM profile will not
    /// let them grant is the wrong instruction.
    @Test("a restricted camera does not send the user to Settings")
    func restrictedIsNotMerelyUnpermitted() {
        let restricted = ErrorMapping.userFacing(CaptureError.Restricted)
        let notPermitted = ErrorMapping.userFacing(CaptureError.NotPermitted)
        #expect(restricted != notPermitted)
        #expect(!says(restricted, "Settings"))
        #expect(says(notPermitted, "Settings"))
        #expect(says(restricted, "linking code"))
    }

    /// An empty result reaches the applier as a content wipe, which is why this
    /// is an error at all. The sentence must not describe a blank note either.
    @Test("a truncated body never reads as an empty one")
    func truncationIsNotEmptiness() {
        let truncated = ErrorMapping.userFacing(CompressError.IncompleteDeflateStream)
        #expect(says(truncated, "incomplete"))
        #expect(!says(truncated, "empty"))
        #expect(truncated.recourse == .retryLater)
        #expect(truncated != ErrorMapping.userFacing(CompressError.Corrupt(what: payload)))
    }

    @Test("a rebuildable search index is not data loss")
    func indexRebuildIsNotLoss() {
        let rebuild = ErrorMapping.userFacing(StorageError.IndexRebuildRequired(what: payload))
        #expect(says(rebuild, "safe"))
        #expect(!says(rebuild, "lost"))
        #expect(rebuild != ErrorMapping.userFacing(StorageError.Failed(what: payload)))
        // And through `CrdtError.Storage`, which is why that variant nests.
        let noSpace = StorageError.OutOfSpace(neededBytes: 1, availableBytes: 0)
        let outOfSpace = ErrorMapping.userFacing(CrdtError.Storage(source: noSpace))
        #expect(outOfSpace == ErrorMapping.userFacing(noSpace))
        #expect(outOfSpace != ErrorMapping.userFacing(CrdtError.Undecodable(docId: payload, what: payload)))
    }

    @Test("reminders past the 64 cap are kept, not dropped")
    func limitReachedKeepsReminders() {
        let capped = ErrorMapping.userFacing(NotificationError.LimitReached)
        #expect(says(capped, "kept"))
        #expect(capped != ErrorMapping.userFacing(NotificationError.Failed(what: payload)))
    }

    @Test("an absent background capability says it is absent")
    func backgroundUnavailableSaysSo() {
        let off = ErrorMapping.userFacing(BackgroundError.Unavailable)
        #expect(says(off, "Background App Refresh"))
        #expect(off.recourse == .blocked)
        #expect(off != ErrorMapping.userFacing(BackgroundError.Failed(what: payload)))
    }

    // MARK: - The fallback

    /// "Could not tell" must never look like "nothing wrong".
    @Test("an unrecognised error is loud, not blank")
    func fallbackIsVisible() {
        struct Mystery: Error {}
        let mapped = ErrorMapping.userFacing(Mystery())
        #expect(mapped == ErrorMapping.unrecognised)
        #expect(!mapped.title.isEmpty)
        #expect(mapped.guidance?.isEmpty == false)
        #expect(mapped.isUserVisible)
        #expect(mapped.recourse == .retry)
    }

    @Test("the four errors the spec says to swallow are the only invisible ones")
    func onlyTheSpecifiedErrorsAreSilent() {
        let silent = ownCopy.map { ErrorMapping.userFacing($0) }.filter { !$0.isUserVisible }.map(\.code.description)
        #expect(Set(silent) == ["api.bootstrapUnavailable", "transport.cancelled", "capture.cancelled"])
        #expect(!ErrorMapping.userFacing(CancellationError()).isUserVisible)
        #expect(ErrorMapping.userFacing(CancellationError()) == ErrorMapping.cancelled)
        // Swallowed means "not alerted", never "not known".
        #expect(!ErrorMapping.cancelled.title.isEmpty)
    }

    @Test("text joins the two halves for one VoiceOver label")
    func textIsOneLabel() {
        let withGuidance = ErrorMapping.userFacing(SecureStoreError.Locked)
        #expect(withGuidance.text.hasPrefix(withGuidance.title))
        #expect(withGuidance.text.hasSuffix(withGuidance.guidance ?? ""))
        #expect(ErrorMapping.cancelled.text == ErrorMapping.cancelled.title)
    }
}
