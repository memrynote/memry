import Foundation
import MemryCore

// T142. The one place a core error becomes a sentence (Constitution II,
// `contracts/core-api.md` §"Error surfaces", `contracts/shell-seams.md`
// §"Why these particular enums have the variants they do").
//
// **No raw error object is ever shown.** That is not a style rule here, it is
// the enforcement point: every generated core enum is a `LocalizedError` whose
// `errorDescription` is `String(reflecting: self)`, so `localizedDescription`
// on any of them is the Swift case *with its associated values* — a path, a
// server message, a recovery word. A view that renders a caught error must
// render it through this file and nothing else.
//
// **Every `switch` below is exhaustive and none has a `default:`.** `MemryCore`
// is a local SwiftPM package built without library evolution, so its enums are
// frozen from the app's point of view and Swift requires no `@unknown default`.
// A `default:` is precisely how a variant added in a later core release would
// silently inherit its neighbour's sentence; when the core grows a case, this
// file must stop compiling. Splitting by enum — one small `switch` each,
// delegating for the wrapping variants — is also what keeps every function
// under the 100-line body ceiling without disabling a rule.
//
// **The copy rule, applied uniformly.** A message says what failed, and
// `guidance` answers "what now?": a concrete action when the user has one, and
// otherwise what happens next without them. It is `nil` only when there is
// genuinely neither, and then the title stands alone rather than inventing an
// instruction. Voice is `DESIGN.md` §"Copy and trust": concise sentence case,
// factual about sync and local data, no hype and no manufactured urgency.
//
// **Nothing calls this yet.** The first production call site is T147's
// `SignInView`, which is the first screen that catches an `AuthError`; T152's
// `RecoveryPhraseView` is the first that depends on two variants of one enum
// reading differently. Until one of them lands, this file is unwired, and the
// tests behind it are evidence about the mapping only.

/// What a view shows. Never an `Error`, never a `localizedDescription`.
struct UserFacingError: Hashable, Sendable {
    /// What the user can do about it. Three cases rather than a `Bool`, because
    /// two of the distinctions `core-api.md` demands are exactly this: a 400
    /// that wedges the outbox forever must not offer the same "try again" as a
    /// 503, and `AuthError.RefreshBlocked` ("the latch is holding, try later")
    /// must not offer the same thing as `.SessionExpired` ("this session is
    /// gone"). A view maps this to an affordance: a button now, a wait, or none.
    enum Recourse: Sendable, Hashable {
        /// Repeating the same action may now work.
        case retry
        /// It will resolve without the user doing anything new. Repeating now
        /// will not help; waiting will.
        case retryLater
        /// Repeating will never help. The fix is elsewhere, or nowhere.
        case blocked
    }

    /// A stable identifier for this variant, safe to log because it is a
    /// literal minted here and carries no part of the error's payload.
    let code: ErrorCode
    /// What failed. One sentence, always present, never empty.
    let title: String
    /// What now. `nil` when there is no action and no automatic resolution.
    let guidance: String?
    let recourse: Recourse
    /// `false` for the four errors the specification requires the shell to
    /// swallow: `ApiError.BootstrapUnavailable`, which chapter 10 §10.12 says
    /// "says nothing to the user", and the three cancellations, which are the
    /// user's own decision and not news. The value still carries a title and a
    /// code so it can be logged — swallowed means "not alerted", never "not
    /// known".
    let isUserVisible: Bool

    /// Title and guidance as one sentence. This is the VoiceOver label: an
    /// alert whose message is split across two elements is read as two
    /// unrelated fragments, and the guidance is the half that matters.
    var text: String {
        guard let guidance else { return title }
        return "\(title) \(guidance)"
    }
}

/// The renderer. One overload per core enum, plus one funnel for a caught
/// `Error` whose static type has been lost.
enum ErrorMapping {
    private static func copy(
        _ code: ErrorCode,
        _ title: String,
        _ guidance: String? = nil,
        _ recourse: UserFacingError.Recourse = .blocked,
        visible: Bool = true
    ) -> UserFacingError {
        UserFacingError(code: code, title: title, guidance: guidance, recourse: recourse, isUserVisible: visible)
    }

    // MARK: - The funnel

    /// For a `catch` block, which sees `any Error`.
    ///
    /// The fallback is the part that matters. An unrecognised error must not
    /// render blank and must not render as calm: "could not tell" looking like
    /// "nothing wrong" is the bug this whole file exists to refuse. So it gets
    /// real copy, stays user-visible, and is logged at `fault` — the one level
    /// that is on by default on a user's device — so the gap is findable.
    static func userFacing(_ error: any Error) -> UserFacingError {
        if let mapped = mappedCoreError(error) { return mapped }
        if let mapped = mappedSeamError(error) { return mapped }
        if error is CancellationError { return cancelled }
        Log.core.fault("unrecognised error reached the shell", .code(unrecognised.code))
        return unrecognised
    }

    /// The seven enums of `core-api.md` §"Error surfaces".
    private static func mappedCoreError(_ error: any Error) -> UserFacingError? {
        if let error = error as? CryptoError { return userFacing(error) }
        if let error = error as? RecoveryError { return userFacing(error) }
        if let error = error as? CborError { return userFacing(error) }
        if let error = error as? CompressError { return userFacing(error) }
        if let error = error as? CrdtError { return userFacing(error) }
        if let error = error as? ApiError { return userFacing(error) }
        if let error = error as? AuthError { return userFacing(error) }
        // T153/T154. `LinkingError` is newer than `core-api.md`'s list of
        // seven and was uncovered until the two linking screens landed: a
        // caught `LinkingError` fell through to `unrecognised`, which is
        // honest but says nothing about a QR code.
        if let error = error as? LinkingError { return userFacing(error) }
        // T237. `SyncError` is newer still, and it arrived uncovered for
        // exactly the reason `LinkingError` did. `ErrorMappingSync.swift`.
        if let error = error as? SyncError { return userFacing(error) }
        return nil
    }

    /// The seven enums the shell throws back across a seam, which return to it
    /// nested inside the enums above (`shell-seams.md`).
    private static func mappedSeamError(_ error: any Error) -> UserFacingError? {
        if let error = error as? SecureStoreError { return userFacing(error) }
        if let error = error as? StorageError { return userFacing(error) }
        if let error = error as? TransportError { return userFacing(error) }
        if let error = error as? CaptureError { return userFacing(error) }
        if let error = error as? NotificationError { return userFacing(error) }
        if let error = error as? BackgroundError { return userFacing(error) }
        if let error = error as? EditorError { return userFacing(error) }
        return nil
    }

    /// The shell's own cancellation, not the core's. Distinct code from
    /// `TransportError.Cancelled` so a log can tell a dropped `Task` from a
    /// cancelled request.
    static let cancelled = copy("shell.cancelled", "Cancelled.", nil, .retry, visible: false)

    static let unrecognised = copy(
        "shell.unrecognised",
        "Memry hit a problem it could not identify.",
        "As far as Memry can tell nothing was changed. Try again; if it keeps happening it is worth reporting.",
        .retry
    )

    // MARK: - Crypto and recovery

    static func userFacing(_ error: CryptoError) -> UserFacingError {
        switch error {
        case .InvalidLength:
            copy("crypto.invalidLength", "Memry could not read that data.",
                 "It was not the size Memry expected. Nothing on this phone was changed.")
        case .InvalidParameter:
            copy("crypto.invalidParameter", "Memry could not complete that.",
                 "Nothing on this phone was changed.")
        case .DecryptionFailed:
            copy("crypto.decryptionFailed", "Memry could not decrypt that item.",
                 "It was encrypted with a different key, or it was altered. Your other notes are unaffected.")
        case .EncryptionFailed:
            copy("crypto.encryptionFailed", "Memry could not encrypt that change.",
                 "It was not saved. Try again.", .retry)
        // The variant's whole reason for existing (research R3, chapter 01
        // §1.1): libsodium answers a 64 MiB allocation failure with the same -1
        // it answers a bad parameter with, and rendering this as "wrong phrase"
        // tells the user to re-type a phrase that was correct.
        case .OutOfMemory:
            copy("crypto.outOfMemory", "Your phone ran out of memory while unlocking.",
                 "Your recovery phrase was correct. Close a few apps, then try again.", .retry)
        case .InvalidBase64:
            copy("crypto.invalidBase64", "Memry could not read an encoded value.",
                 "It was not valid base64. Nothing on this phone was changed.")
        case .InvalidHex:
            copy("crypto.invalidHex", "Memry could not read an encoded value.",
                 "It was not valid hexadecimal. Nothing on this phone was changed.")
        }
    }

    /// `UnknownWord` carries the offending word and this copy **does not echo
    /// it**. A recovery word is key material: eleven bits of the seed, and a
    /// string that reaches an alert can reach a screenshot or a crash report.
    /// The view has the associated value and can highlight the field; the
    /// sentence does not need it.
    static func userFacing(_ error: RecoveryError) -> UserFacingError {
        switch error {
        case .UnknownWord:
            copy("recovery.unknownWord", "One of those words is not in Memry's word list.",
                 "Check each word for a typo. A recovery phrase only uses words from that list.", .retry)
        case .BadChecksum:
            copy("recovery.badChecksum", "Every word is real, but that is not a phrase Memry issued.",
                 "A word is probably mistyped or out of order. Check it against the phrase you saved.", .retry)
        case .WrongWordCount:
            copy("recovery.wrongWordCount", "A recovery phrase is 24 words.",
                 "Check for a missing or repeated word.", .retry)
        case .NonAscii:
            copy("recovery.nonAscii", "That phrase contains characters Memry cannot use.",
                 "Recovery phrases are plain English letters. Retype it without accents or another alphabet.", .retry)
        case .VerifierMismatch:
            copy("recovery.verifierMismatch", "That is a valid recovery phrase, but not this account's.",
                 "Check you are signed in to the right account, or use the phrase you saved for it.", .retry)
        // Delegated, which is the point of the variant: an Argon2id
        // out-of-memory must not surface as "wrong phrase".
        case let .Crypto(source):
            userFacing(source)
        }
    }

    // MARK: - Payload encoding

    static func userFacing(_ error: CborError) -> UserFacingError {
        switch error {
        case .FieldNotInOrdering:
            copy("cbor.fieldNotInOrdering", "Memry could not prepare that item for sync.",
                 "It holds a field this version does not know how to send. Updating Memry may fix it.")
        case .Unencodable:
            copy("cbor.unencodable", "Memry could not prepare that item for sync.",
                 "A value in it could not be encoded. It stays on this phone and was not lost.")
        case .Malformed:
            copy("cbor.malformed", "Memry could not read an item that arrived.",
                 "It was not in a shape this version understands. Updating Memry may fix it.")
        }
    }

    /// Chapter 04 §4.1: a truncated body is an error rather than an empty
    /// result, because an empty result reaches the applier as a content wipe.
    /// The copy carries that through — it says the note arrived incomplete and
    /// that Memry declined to overwrite, never that the note is blank.
    static func userFacing(_ error: CompressError) -> UserFacingError {
        switch error {
        case .IncompleteDeflateStream:
            copy("compress.incompleteDeflateStream", "That note arrived incomplete.",
                 "Memry declined to overwrite your copy with it. It will be fetched again on the next sync.",
                 .retryLater)
        case .Corrupt:
            copy("compress.corrupt", "That note's contents could not be unpacked.",
                 "Memry left the copy on this phone as it is. It will be fetched again on the next sync.",
                 .retryLater)
        }
    }

    static func userFacing(_ error: CrdtError) -> UserFacingError {
        switch error {
        case .DocumentBusy:
            copy("crdt.documentBusy", "That note is busy.",
                 "Another change to it is still being saved. Try again in a moment.", .retry)
        case .Undecodable:
            copy("crdt.undecodable", "Memry could not read a change that arrived for that note.",
                 "The note on this phone was left as it is.")
        case .NotApplicable:
            copy("crdt.notApplicable", "Memry could not apply a change to that note.",
                 "The note on this phone was left as it is.")
        // Delegated so that an out-of-space does not surface as "bad document".
        case let .Storage(source):
            userFacing(source)
        }
    }

    // MARK: - Server and session

    // `ApiError` has eleven variants and this function is eleven `case`s and no
    // other branch, so its measured complexity is the size of the enum. The two
    // ways to quiet the rule are both worse: a `default:` is what the contract
    // forbids, and splitting the switch in two leaves one arm unreachable in
    // each half, which is the same shrug wearing a different hat. Scoped to
    // this function, with the reason, rather than widened in `.swiftlint.yml`.
    // swiftlint:disable:next cyclomatic_complexity
    static func userFacing(_ error: ApiError) -> UserFacingError {
        switch error {
        case let .Transport(source):
            userFacing(source)
        // Never "the server is unreachable": this arm is the one that is not a
        // server answer at all. The copy names the phone and its database and
        // mentions neither the network nor the server.
        case .Storage:
            copy("api.storage", "This phone could not read its own Memry database.",
                 "Restart Memry. If it keeps happening, free up storage space on this phone.", .retry)
        case .Unauthorized:
            copy("api.unauthorized", "Memry is no longer signed in on this phone.",
                 "Sign in again to continue.")
        case .DeviceRevoked:
            copy("api.deviceRevoked", "This phone's access to your account was revoked.",
                 "Its copy of your vault has been removed. Sign in again to use Memry here.")
        // spec-defect 111. The old second sentence promised that "syncing will
        // resume on its own", and the screen this error is met on most often is
        // the sign-in screen, where there is no sync to resume and nothing
        // resumes by itself. `DESIGN.md` §"Error copy, in detail": a sentence
        // must be true on every screen that can show it, so this one now states
        // the outcome — nothing was lost — and promises no mechanism. The
        // recourse, not the prose, is what says when to come back.
        case .RateLimited:
            copy("api.rateLimited", "Memry is being asked to slow down.",
                 "Nothing has been lost. Try again in a little while.", .retryLater)
        // Chapter 11 §11.6 and §11.9. Read-only: the outbox parks, accrues no
        // backoff, and this is not a failure the user retries.
        case .WritesDisabled:
            copy("api.writesDisabled", "Memry is read-only right now.",
                 "Your changes are saved on this phone and will sync once writing is available again.", .retryLater)
        case .UpgradeRequired:
            copy("api.upgradeRequired", "This version of Memry is too old to sync.",
                 "Update Memry from the App Store to start syncing again.")
        // Chapter 10 §10.12: a deployment fact, and the caller "says nothing to
        // the user". Kept as a real value so it can still be logged.
        case .BootstrapUnavailable:
            copy("api.bootstrapUnavailable", "Memry is syncing the ordinary way.",
                 nil, .retryLater, visible: false)
        case let .Status(status, _, _):
            statusCopy(status)
        case .MalformedResponse:
            copy("api.malformedResponse", "Memry could not read the server's answer.",
                 "Nothing was changed. Updating Memry may fix it.")
        case .InvalidClientIdentity:
            copy("api.invalidClientIdentity", "This copy of Memry cannot identify itself to the server.",
                 "Reinstalling Memry from the App Store should fix it.")
        }
    }

    /// The one arm of `ApiError` that needs the status to decide, because the
    /// two readings are opposite and a single sentence would be wrong for one.
    private static func statusCopy(_ status: UInt16) -> UserFacingError {
        status >= 500 || status == 408 ? serverFault : serverRefusal
    }

    /// A 5xx or a 408. Transient, and saying so is honest.
    private static let serverFault = copy(
        "api.statusServerFault",
        "The Memry server could not handle that request.",
        "Memry will try again on the next sync. Your changes are saved on this phone.",
        .retryLater
    )

    /// Any other non-2xx, which in practice means a 4xx the client has no
    /// specific policy for. It must **not** read as transient: a permanently
    /// rejected record wedges the outbox and retries forever, so "try again"
    /// here would describe a loop as a fix.
    private static let serverRefusal = copy(
        "api.statusRefused",
        "The Memry server refused that request.",
        "Repeating it will not change the answer. Updating Memry may fix it."
    )

    static func userFacing(_ error: AuthError) -> UserFacingError {
        switch error {
        case let .Api(source):
            userFacing(source)
        // Delegated, so a locked keychain reads as locked and never as signed
        // out (`shell-seams.md`: reading "no master key" from a locked device
        // and re-registering throws the key away).
        case let .SecureStore(source):
            userFacing(source)
        case let .Crypto(source):
            userFacing(source)
        // spec-defect 111. "Close this screen" is false wherever the screen is
        // the root — which the sign-in screen is, and it is the screen that
        // reaches this error most. Same rule as `RateLimited` above: say what
        // happened and that nothing is lost, and name no affordance that may
        // not exist where the sentence is read.
        case .InvalidState:
            copy("auth.invalidState", "Memry could not do that from where it is.",
                 "Nothing has changed and nothing is lost. Start that step again.", .retry)
        case .MalformedToken:
            copy("auth.malformedToken", "Memry's stored sign-in details are unreadable.",
                 "Sign in again to replace them.")
        // "The latch is holding, try later." Must never tell the user to sign
        // in again: they are still signed in and the refusal is transient.
        case .RefreshBlocked:
            copy("auth.refreshBlocked", "Memry is waiting before it reconnects your account.",
                 "There is nothing to do. It will retry on its own shortly.", .retryLater)
        // "This session is gone." Must never read as transient: spinning on a
        // dead session is the other half of the collapse.
        case .SessionExpired:
            copy("auth.sessionExpired", "Your session has expired.",
                 "Sign in again to continue.")
        case .NoSetupToken:
            copy("auth.noSetupToken", "Memry could not finish setting up this phone.",
                 "Start sign-in again from the beginning.", .retry)
        }
    }

}

// MARK: - Seams
//
// An extension rather than more of the enum body: the split is the one
// `core-api.md` and `shell-seams.md` already draw — seven enums the core raises
// at the shell, seven the shell raises at the core and which come back nested
// inside the first seven — and it is also what keeps the type body under its
// ceiling without disabling a rule.
extension ErrorMapping {
    static func userFacing(_ error: SecureStoreError) -> UserFacingError {
        switch error {
        case .Locked:
            copy("secureStore.locked", "Memry cannot reach its keys until this phone is unlocked.",
                 "Unlock the phone, then open Memry again. Your vault is still here.", .retryLater)
        case .Denied:
            copy("secureStore.denied", "iOS refused Memry access to the keychain.",
                 "Close Memry and open it again. If it keeps happening, restart the phone.", .retry)
        case .Failed:
            copy("secureStore.failed", "Memry could not read its keys from the keychain.",
                 "Close Memry and open it again.", .retry)
        }
    }

    static func userFacing(_ error: StorageError) -> UserFacingError {
        switch error {
        case .NotOpen:
            copy("storage.notOpen", "Memry's database is not open yet.",
                 "Wait a moment, then try again.", .retry)
        case .Migration:
            copy("storage.migration", "Memry could not upgrade its database.",
                 "Your notes are untouched and still at the previous version. Updating Memry may fix it.")
        case .MissingFts5:
            copy("storage.missingFts5", "Search is unavailable in this build of Memry.",
                 "Everything else works. Reinstalling Memry from the App Store should restore search.")
        // Not data loss: the index lives in its own file precisely so it can be
        // deleted and rebuilt from `data.db`.
        case .IndexRebuildRequired:
            copy("storage.indexRebuildRequired", "Memry is rebuilding its search index.",
                 "Your notes are safe. Search results will be incomplete until it finishes.", .retryLater)
        case .OutOfSpace:
            copy("storage.outOfSpace", "This phone is out of storage.",
                 "Free up some space, then try again. Nothing was lost.", .retry)
        case .Failed:
            copy("storage.failed", "Memry could not read or write its database.",
                 "Close Memry and open it again.", .retry)
        }
    }

    static func userFacing(_ error: TransportError) -> UserFacingError {
        switch error {
        case .Offline:
            copy("transport.offline", "You are offline.",
                 "Memry will sync when the connection is back. Your changes are saved on this phone.", .retryLater)
        case .Timeout:
            copy("transport.timeout", "The Memry server took too long to answer.",
                 "Try again, or wait for the next sync.", .retry)
        // Not retryable, deliberately: retrying a certificate failure turns a
        // possible interception into a loop.
        case .Tls:
            copy("transport.tls", "Memry could not verify the server's certificate.",
                 "Memry stopped rather than send anything. This can happen on networks that inspect traffic.")
        case .Cancelled:
            copy("transport.cancelled", "That request was cancelled.", nil, .retry, visible: false)
        case .Failed:
            copy("transport.failed", "Memry could not reach the server.",
                 "Try again, or wait for the next sync.", .retry)
        case .SocketClosed:
            copy("transport.socketClosed", "Memry's live connection closed.",
                 "It will reconnect on its own. Your changes are saved on this phone.", .retryLater)
        }
    }

    static func userFacing(_ error: CaptureError) -> UserFacingError {
        switch error {
        case .NotPermitted:
            copy("capture.notPermitted", "Memry does not have camera access.",
                 "Allow the camera in Settings, or type the linking code instead.")
        // The user cannot grant this from Settings, so sending them there is
        // the wrong instruction and the word does not appear.
        case .Restricted:
            copy("capture.restricted", "Camera access is blocked on this phone.",
                 "A device profile or Screen Time rule controls it, so you cannot turn it on yourself. " +
                 "Type the linking code instead.")
        case .Cancelled:
            copy("capture.cancelled", "Scanning was cancelled.", nil, .retry, visible: false)
        case .Failed:
            copy("capture.failed", "The camera could not start.",
                 "Try again, or type the linking code instead.", .retry)
        }
    }

    static func userFacing(_ error: NotificationError) -> UserFacingError {
        switch error {
        case .NotPermitted:
            copy("notification.notPermitted", "Memry cannot send you reminders.",
                 "Allow notifications in Settings. Your reminders are kept and will be scheduled if you do.")
        // The core must choose which reminders to hold; the copy says they are
        // kept, never that they were dropped.
        case .LimitReached:
            copy("notification.limitReached", "iOS allows only 64 scheduled reminders at a time.",
                 "Memry scheduled the soonest ones and kept the rest, scheduling them as those pass.")
        case .Failed:
            copy("notification.failed", "Memry could not schedule that reminder.",
                 "Try again.", .retry)
        }
    }

    static func userFacing(_ error: BackgroundError) -> UserFacingError {
        switch error {
        // Constitution IV: an absent capability says it is absent.
        case .Unavailable:
            copy("background.unavailable", "Background App Refresh is off for Memry.",
                 "Memry will only sync while it is open. Turn it on in Settings to sync in the background.")
        case .Failed:
            copy("background.failed", "A background sync did not finish.",
                 "Memry will try again the next time it runs.", .retryLater)
        }
    }

    static func userFacing(_ error: EditorError) -> UserFacingError {
        switch error {
        // The core queues rather than losing the message, so this is not a loss.
        case .NotAttached:
            copy("editor.notAttached", "The editor is not ready yet.",
                 "Your change is queued and will be applied when it opens.", .retryLater)
        case .Timeout:
            copy("editor.timeout", "The editor stopped responding.",
                 "Close the note and open it again. Your saved text is unaffected.", .retry)
        case .ProtocolMismatch:
            copy("editor.protocolMismatch", "Memry's editor does not match the rest of the app.",
                 "Reinstalling Memry from the App Store should fix it.")
        case .Failed:
            copy("editor.failed", "The editor could not complete that.",
                 "Try again.", .retry)
        }
    }
}

// MARK: - Device linking
//
// T153/T154. Chapter 03's fourteen variants, and the four distinctions the
// flow turns on: a code that was never a Memry code, a code whose secret was
// the wrong size, a window that closed, and a peer that did not hold the
// shared secret. They are four sentences because they are four next actions.
//
// **Nothing here echoes a payload.** `InvalidQrPayload` and `InvalidLength`
// both carry a `what` naming the field, and none of it reaches a sentence: the
// QR carries a 256-bit one-time secret and a session id, and a string that
// reaches an alert can reach a screenshot.
extension ErrorMapping {
    // Fourteen `case`s and no other branch, so the measured complexity is the
    // size of the enum. Same argument as `ApiError` above: a `default:` is
    // what the contract forbids, and splitting the switch leaves unreachable
    // arms in each half. Scoped here, with the reason.
    // swiftlint:disable:next cyclomatic_complexity
    static func userFacing(_ error: LinkingError) -> UserFacingError {
        switch error {
        case .InvalidQrPayload:
            copy("linking.invalidQrPayload", "That is not a Memry linking code.",
                 "Scan the code your computer is showing, or paste it exactly as it appears.", .retry)
        // §3.3: the decoded `linkingSecret` must be exactly 32 bytes, and the
        // server's schema is only `min(1)`, so this is the client's refusal of
        // a code that looked well-formed and was not.
        case .InvalidLength:
            copy("linking.invalidLength", "That linking code is not the right size.",
                 "Part of it is missing or was altered. Show a new code on your computer and scan it.", .retry)
        case .InvalidBase64:
            copy("linking.invalidBase64", "Memry could not read part of that linking code.",
                 "It may have been copied incompletely. Show a new code on your computer and scan it.", .retry)
        // §3.12's `LINKING_SECRET_INVALID`: the QR was wrong.
        case .ScanMacInvalid:
            copy("linking.scanMacInvalid", "That code is not the one your computer is showing.",
                 "Show a new code on your computer and scan it.", .retry)
        // §3.9: raised before the master key is touched, so nothing was
        // decrypted and nothing was stored. Never described as a retry of the
        // same code, which cannot work.
        case .ConfirmMacInvalid:
            copy("linking.confirmMacInvalid", "Memry could not verify that computer.",
                 "The two devices did not agree on a key, so nothing was transferred. " +
                 "Start the link again on your computer.")
        // §3.10 makes this block hard-fail, and it came from the peer rather
        // than from the camera, so it is not "scan more carefully".
        case .InvalidVaultTransfer:
            copy("linking.invalidVaultTransfer", "Your computer's vault list did not arrive intact.",
                 "Nothing was unlocked on this phone. Start the link again on your computer.")
        // §3.4: 300 s, absolute, and neither the scan nor the approval extends
        // it. The duration is not rendered — the recourse is a new code.
        case .SessionExpired:
            copy("linking.sessionExpired", "That linking code has expired.",
                 "Codes are only good for a few minutes. Show a new one on your computer and scan it.", .retry)
        case .NotScanned:
            copy("linking.notScanned", "Memry has no linking code to check yet.",
                 "Scan the code your computer is showing to start.", .retry)
        // Refused rather than silently replacing the first session: a client
        // that dropped its own would be reporting the wrong one.
        case .AlreadyScanned:
            copy("linking.alreadyScanned", "Memry is already linking with a code you scanned.",
                 "Finish that link on your computer, or stop it here and scan a new code.")
        // §3.4's budget, refused **before** a request is spent. Transient by
        // construction: the core says how long to wait and the poll resumes.
        // No duration in the copy (`DESIGN.md`).
        case .PollBudgetExhausted:
            copy("linking.pollBudgetExhausted", "Memry is checking with the server too often.",
                 "It will check again shortly. Nothing has been lost.", .retryLater)
        case let .Crypto(source):
            userFacing(source)
        case let .Cbor(source):
            userFacing(source)
        case let .Api(source):
            userFacing(source)
        case let .SecureStore(source):
            userFacing(source)
        }
    }
}
