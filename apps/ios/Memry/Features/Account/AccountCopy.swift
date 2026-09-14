import Foundation

// T159's copy. Every sentence a user reads on the way out of an account.
//
// **Literals, by decision** (spec-defect 98, Phase 4 Scope decisions):
// localization is out of scope for this phase and a hard-coded string is not a
// defect here. The strings are gathered in one file so the conversion, when it
// comes, is one pass over one file — the shape `SignInCopy.swift` and
// `GoogleSignInCopy.swift` already set.
//
// **Three rules were binding while writing these** (`DESIGN.md` §"Error copy,
// in detail" and §"Copy and trust"):
//
//   1. *Explain destructive effects before the confirmation.* The dialog names
//      the three things that go, in the user's words rather than the
//      specification's: keys, the copy of the notes, the downloaded images.
//   2. *A sentence must be true on every screen that can show it*
//      (spec-defect 111). The revoked screen never says a second device did
//      this, because this phone was not told who did — it was told the server
//      refuses it. It also promises no mechanism beyond the one button in front
//      of the user.
//   3. *Never accuse, and never promise what does not exist.* There is no
//      support channel to report this to (spec-defect 94), so none is offered.
enum AccountCopy {
    static let signOut = "Sign out"
    static let signingOut = "Signing out…"

    static let confirmTitle = "Sign out of Memry on this phone?"
    /// Named effects, not "all local data". A user cannot weigh a phrase that
    /// does not say what it covers.
    static let confirmMessage = """
        This phone's keys, its copy of your notes, and any images downloaded to it are removed. \
        Your account and the notes in it are not deleted, and you can sign in again here at any time.
        """

    static let revokedTitle = "This phone's access to your account was turned off."
    /// No accusation and no mechanism. "Turned off for your account" is what
    /// this device actually knows: the server refused it, and it was not told
    /// by whom or why.
    static let revokedBody = """
        Memry has removed this phone's keys and its copy of your notes. \
        Nothing was deleted from your account — your notes are still there, \
        and signing in again brings them back to this phone.
        """
    static let revokedAction = "Sign in again"

    /// The keys went and some vault content did not.
    ///
    /// Its own sentence rather than the mapped `StorageError`, because the
    /// mapped one ("Memry could not read or write its database. Close Memry and
    /// open it again.") is about a database this app is trying to *use*, and
    /// after a sign-out there is nothing left to use it with. The underlying
    /// code still reaches the log, where it is the diagnostic.
    ///
    /// `.retry` and not `.blocked`: signing out again really does re-run the
    /// removal, because the removal is idempotent. The second sentence names
    /// the two things that work, and both exist.
    static let contentSurvived = UserFacingError(
        code: "account.contentSurvived",
        title: "You are signed out, but part of this phone's copy could not be removed.",
        guidance: "Your keys are gone, so nothing left behind can be opened. "
            + "Signing out again removes the rest; deleting Memry from this phone also removes it.",
        recourse: .retry,
        isUserVisible: true
    )
}
