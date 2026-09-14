import Foundation
import MemryCore
import Observation

// T159's screen half. What the user presses, and what they are told afterwards.
//
// **The state on screen is always one the core returned** (FR-037, research
// R15's shape, and `SignInViewModel`'s rule). Nothing here decides that a
// device is signed out or revoked; `SignOutService` hands back the state the
// core applied and this publishes it.
//
// **There is no Cancel, anywhere in this file.** An async core call cannot be
// cancelled (spec-defect 108) and a half-cancelled destruction is the worst
// outcome available, so the confirmation is the last moment a user can change
// their mind. That is also why the confirmation exists at all: `DESIGN.md`
// §"Copy and trust" — "explain destructive or privacy-sensitive effects before
// confirmation" — and the sentence it shows names the three things that go.

@MainActor
@Observable
final class AccountViewModel {
    private let service: SignOutService
    /// Hands the core's new state back to the app root, which is what re-reads
    /// it into the screens. A closure rather than a reference, so this type
    /// does not own the object that owns it.
    private let publish: @MainActor (AuthState) -> Void

    /// A destruction is in flight. The only thing it disables is starting a
    /// second one — it is never a Cancel.
    private(set) var isWorking = false
    /// The core refused, and **nothing local was removed**. The user is still
    /// signed in and the action is offered again. A locked keychain is the case
    /// this exists for.
    private(set) var error: UserFacingError?
    /// The keys went and some vault content did not. Rendered as a notice
    /// *beside* the completed sign-out, never as a failed one: the user is
    /// signed out either way, and telling them otherwise would invite them to
    /// retry a thing that already happened.
    private(set) var residue: UserFacingError?
    /// The confirmation sheet.
    var isConfirming = false

    /// Whether there is anything to say at all. Read by `AccountShell`, which
    /// keeps the notice on screen after a sign-out has moved the state past the
    /// point where the control itself is offered.
    var hasNotice: Bool { residue != nil || error != nil }

    init(service: SignOutService, publish: @escaping @MainActor (AuthState) -> Void) {
        self.service = service
        self.publish = publish
    }

    /// FR-025.
    func signOut() async {
        guard !isWorking else { return }
        isWorking = true
        error = nil
        isConfirming = false
        defer { isWorking = false }
        do {
            let wipe = try await service.signOut()
            apply(wipe)
        } catch {
            record(error)
        }
    }

    /// FR-026, driven by `RevocationWatch` when the server refuses this device
    /// on a call the app was making anyway.
    ///
    /// - Returns: `false` when the destruction could not run. The watch then
    ///   **does not latch**, so the next call that meets the same refusal tries
    ///   again — a keychain that is locked now is readable after the phone is
    ///   unlocked, and latching on that failure would leave a revoked device
    ///   holding its vault forever.
    func revocationDetected() async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        error = nil
        defer { isWorking = false }
        do {
            let wipe = try await service.markRevoked()
            apply(wipe)
            return true
        } catch {
            record(error)
            return false
        }
    }

    /// The revoked screen's one action: §C.1's `Revoked -> SignedOut`, "local
    /// vault content removed, reason shown".
    ///
    /// It is the same `signOut()`, deliberately. The keychain is already empty
    /// so the core's half is a no-op, and the removal is idempotent — which
    /// means this is also the retry for a revocation that left residue behind.
    func signInAgain() async {
        await signOut()
    }

    private func apply(_ wipe: LocalWipe) {
        residue = wipe.residue
        error = nil
        publish(wipe.state)
    }

    private func record(_ raised: any Error) {
        let mapped = ErrorMapping.userFacing(raised)
        Log.auth.error("a local wipe did not run", .code(mapped.code))
        error = mapped.isUserVisible ? mapped : nil
    }
}
