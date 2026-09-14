import Foundation
import Testing

@testable import Memry

// The two tests that read a real `Bundle`, split out of `GoogleSignInTests`
// when `MemryGoogleClientID` landed in `Info.plist` and pushed that file past
// the 400-line test ceiling.
//
// They belong together for a better reason than line count: they are the only
// Google tests whose subject is the **shipped configuration** rather than the
// flow's logic, and they are converses of each other. One proves an absent key
// refuses; the other proves the key we actually ship resolves and derives the
// scheme Google will redirect to.

@Suite("Google sign-in configuration, against real bundles")
struct GoogleConfigurationTests {
    /// **This used to read `Bundle.main` and pass because the key was absent.**
    /// That made it a test of ambient build state rather than of behaviour: it
    /// held only while nobody had configured the app, and it inverted the
    /// moment `MemryGoogleClientID` landed in `Info.plist` — which is the
    /// moment the app started working. A bundle that genuinely has no key is
    /// the honest vehicle, and `Bundle(for:)` over the test bundle is one.
    @Test("a bundle with no client id throws rather than falling back to a web client")
    func refusesAbsentConfiguration() {
        // The test bundle carries no MemryGoogleClientID, and never will:
        // nothing writes one into it.
        let bundleWithoutTheKey = Bundle(for: BundleAnchor.self)
        #expect(bundleWithoutTheKey.object(forInfoDictionaryKey: "MemryGoogleClientID") == nil)
        #expect(throws: GoogleSignInFailure.notConfigured) {
            try GoogleSignInConfiguration.fromBundle(bundleWithoutTheKey)
        }
    }

    /// The converse, and the one that actually protects a shipped build: the
    /// **real** `Info.plist` must resolve, and the scheme it derives must be
    /// the reversed client id Google will redirect to. A typo in the plist is
    /// otherwise invisible until a user taps the button and the browser hands
    /// the callback to nobody.
    @Test("the shipped Info.plist resolves, and derives the reversed client id as its scheme")
    func shippedConfigurationResolves() throws {
        let configuration = try GoogleSignInConfiguration.fromBundle(Bundle.main)
        #expect(configuration.clientID.hasSuffix(".apps.googleusercontent.com"))
        #expect(configuration.callbackURLScheme.hasPrefix("com.googleusercontent.apps."))
        // Derived, never stored twice: reversing the scheme's components must
        // give the client id back.
        let reversed = configuration.callbackURLScheme.split(separator: ".").reversed().joined(separator: ".")
        #expect(reversed == configuration.clientID)
        #expect(configuration.redirectURI == "\(configuration.callbackURLScheme):/oauth2redirect")
    }
}

/// An anchor for `Bundle(for:)`, which needs a class defined in the test bundle.
private final class BundleAnchor {}
