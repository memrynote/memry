import Foundation
import MemryCore
import UIKit

// T147. The first production construction of anything in `Memry/Core` or
// `Memry/Seams`, and therefore the file that decides whether the five tiers
// landed before it are real.
//
// **The seams are handed a `CoreEventEmitter`, never the hub and never the
// executor** (`contracts/shell-seams.md` §"There is no event seam"). Rust calls
// `Keychain` and `URLSessionTransport` synchronously on its own thread while it
// may hold a lock; a seam holding `CoreExecutor` could call back into the core
// from there and deadlock the queue against itself. `CoreEventEmitter`'s entire
// surface is a synchronous `Void` `emit`, so the deadlock is not a rule anyone
// has to remember here — there is nothing to await and nothing to block on.
//
// **`AuthSession` is constructed with the real seams, and only the platform
// underneath them is ever substituted.** The two injection points below take
// the `URLSession` configuration and the `SecItem*` family, which is what lets
// a test drive the genuine `Keychain` and the genuine `URLSessionTransport`
// with no network and no keychain, rather than drive a fake and learn nothing.

/// What one production object graph is: the core's session, and the one
/// network seam underneath it.
struct AuthGraph {
    let session: AuthSession
    /// Held so a second consumer of the **same** session can be built over it.
    /// See `AuthComposition.googleSignIn`.
    let transport: URLSessionTransport
    /// T153/T154, and the caller spec-defect 114 was waiting for.
    ///
    /// A **separate core object** rather than a method on `AuthSession`: both
    /// of chapter 03's phone-side routes are unauthenticated (§3.1), so the
    /// linking client deliberately carries no token provider, and a second
    /// `AuthSession` over the same keychain entries would be a chapter 02 §2.9
    /// device revocation. It shares the transport and the keychain, because
    /// one `URLSession` and one `Keychain` in the process is the rule the rest
    /// of this file exists to keep.
    let deviceLink: DeviceLink
}

/// Builds the production object graph.
enum AuthComposition {
    /// Chapter 11 §11.2's `CLIENT_PLATFORMS`, not chapter 02 §2.12's
    /// registration enum. They are different lists that happen to coincide for
    /// a phone, and the core validates this one in its constructor.
    static let clientPlatform = "ios"

    /// - Parameters:
    ///   - emitter: the shell's event hub emitter. See the file comment.
    ///   - transportConfiguration: substitutes the network under the real
    ///     transport. Production passes the default.
    ///   - keychainItems: substitutes the keychain under the real
    ///     `Keychain`. Production passes the default.
    static func makeSession(
        environment: SyncEnvironment,
        device: DeviceDescriptor,
        emitter: CoreEventEmitter,
        transportConfiguration: URLSessionConfiguration = URLSessionTransport.defaultConfiguration(),
        keychainItems: any KeychainItemStore = SystemKeychainItemStore()
    ) throws -> AuthSession {
        try makeGraph(
            environment: environment,
            device: device,
            emitter: emitter,
            transportConfiguration: transportConfiguration,
            keychainItems: keychainItems
        ).session
    }

    /// The session **and** the transport under it.
    ///
    /// T165. The transport is returned rather than kept private because the
    /// Google token exchange goes through it (`GoogleTokenExchange`): one
    /// `URLSession` in the process, not two. `makeSession` above stays as the
    /// narrower entry point for every caller that does not need the seam.
    static func makeGraph(
        environment: SyncEnvironment,
        device: DeviceDescriptor,
        emitter: CoreEventEmitter,
        transportConfiguration: URLSessionConfiguration = URLSessionTransport.defaultConfiguration(),
        keychainItems: any KeychainItemStore = SystemKeychainItemStore()
    ) throws -> AuthGraph {
        let transport = URLSessionTransport(emitter: emitter, configuration: transportConfiguration)
        let store = Keychain(emitter: emitter, items: keychainItems)
        let session = try AuthSession(
            transport: transport,
            secureStore: store,
            baseUrl: environment.baseURL,
            clientPlatform: clientPlatform,
            device: device
        )
        // Blocking and does no I/O at all (spec-defect 90), so building it
        // beside the session costs nothing and keeps the whole graph on one
        // trip through `CoreExecutor`.
        //
        // **`deviceName` and `devicePlatform` come from the same
        // `DeviceDescriptor` that registers this phone, and they are not the
        // `clientPlatform` above** (spec-defect 140). Chapter 03 §3.1's `scan`
        // requires both, and chapter 02 §2.12's two platform lists only look
        // alike here: `device.platform` is the registration enum, which a
        // desktop fills with `macos`, and `clientPlatform` is
        // `CLIENT_PLATFORMS`, which has no such value. The core takes them as
        // two parameters so the coincidence cannot be leaned on.
        //
        // The name is `UIDevice.name`, which is the model — see `device()`
        // below for why that is deliberate rather than incidental. It reaches
        // the approving computer as the label beside Approve, and it reaches
        // no log: `Log`'s surface is a `StaticString` plus a closed
        // `LogDetail`, and nothing here widens it.
        let deviceLink = try DeviceLink(
            transport: transport,
            secureStore: store,
            baseUrl: environment.baseURL,
            clientPlatform: clientPlatform,
            appVersion: device.appVersion,
            deviceName: device.name,
            devicePlatform: device.platform
        )
        return AuthGraph(session: session, transport: transport, deviceLink: deviceLink)
    }

    /// T165. The production Google flow, or `nil` when this build carries no
    /// iOS OAuth client id.
    ///
    /// `nil` is **not** "Google is off": the button is offered either way and
    /// pressing it renders `GoogleSignInFailure.notConfigured`'s sentence,
    /// which says the build cannot do it and points at the email code. A
    /// button that disappears tells the user nothing; `Info.plist` is missing
    /// `MemryGoogleClientID` on every build today (spec-defect 117), so the
    /// silent version of this would be a Google button nobody has ever seen.
    @MainActor
    static func googleSignIn(
        transport: any Transport,
        bundle: Bundle = .main
    ) -> GoogleSignIn? {
        guard let configuration = try? GoogleSignInConfiguration.fromBundle(bundle) else {
            return nil
        }
        return GoogleSignIn(
            configuration: configuration,
            authenticator: SystemWebAuthenticator(),
            exchange: GoogleTokenExchange.through(transport)
        )
    }

    /// What this phone calls itself at registration (chapter 02 §2.3).
    ///
    /// `UIDevice.name` is the model name — "iPhone" — on iOS 16 and later
    /// without the user-assigned-name entitlement, which this app does not
    /// request and does not want: the device list is a security surface, not a
    /// place to publish what someone named their phone.
    ///
    /// An absent or empty `CFBundleShortVersionString` throws rather than
    /// sending `""`. The server rejects an empty `appVersion` with a
    /// `400 VALIDATION_ERROR` whose body says nothing a user could act on,
    /// and `InvalidClientIdentity` is the variant that already reads
    /// correctly for a bundle that cannot identify itself.
    @MainActor
    static func device(bundle: Bundle = .main, phone: UIDevice = .current) throws -> DeviceDescriptor {
        try device(
            appVersion: (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "",
            phone: phone
        )
    }

    /// Split from the bundle read so the empty-version refusal is reachable
    /// from a test: there is no way to hand `Bundle` a missing key.
    @MainActor
    static func device(appVersion: String, phone: UIDevice = .current) throws -> DeviceDescriptor {
        guard !appVersion.isEmpty else {
            throw ApiError.InvalidClientIdentity(what: "the bundle carries no CFBundleShortVersionString")
        }
        return DeviceDescriptor(
            name: phone.name,
            platform: .ios,
            osVersion: phone.systemVersion,
            appVersion: appVersion,
            // Chapter 02 §2.3: absent means the server's `default`.
            //
            // **T155 decided: picking a vault does not update this, ever.**
            // The registration field is a 128-character label the server
            // sanitises and stores; routing a read to a vault is the
            // `X-Memry-Vault-Id` header on each request (chapter 05 §5.2),
            // which the core owns, so rewriting the registration would change
            // no routing. Nor is there a way to: the exported surface has one
            // `registerDevice`, and re-registering to carry a new label mints a
            // second device against the account's 50-device budget. Chapter 01
            // §1.7 removes the last reason to want it — one vault key per
            // account, no vault id in the derivation — so the device record
            // does not need to know which vault is on screen.
            vaultId: nil
        )
    }
}
