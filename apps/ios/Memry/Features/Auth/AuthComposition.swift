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
        try AuthSession(
            transport: URLSessionTransport(emitter: emitter, configuration: transportConfiguration),
            secureStore: Keychain(emitter: emitter, items: keychainItems),
            baseUrl: environment.baseURL,
            clientPlatform: clientPlatform,
            device: device
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
            // Chapter 02 §2.3: absent means the server's `default`. Picking a
            // vault is T155's, and it happens after registration.
            vaultId: nil
        )
    }
}
