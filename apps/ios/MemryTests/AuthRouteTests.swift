import Foundation
import MemryCore
import Testing

@testable import Memry

// The routing rule a fresh signup broke, pinned in the one place it can be
// pinned without a running app: the source.
//
// `AuthRootView.route(for:)` decides which of four screens a registered device
// sees. The bug was not in the decision — the setup model was built correctly —
// but in what was built *beside* it: the vault list was minted in the same pass
// and the body renders it first, so a brand-new account was shown "No vaults
// yet" while its recovery phrase sat one branch away, never reached.
//
// A rendered-view test cannot catch that: both screens exist and SwiftUI simply
// picks the first. What catches it is the invariant the fix added — the vault
// model is built only when no earlier screen is pending — so that invariant is
// what this reads.

@Suite("Auth routing")
struct AuthRouteTests {
    private static var source: String? {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Memry/Features/Auth/AuthRootView.swift")
        return try? String(contentsOf: path, encoding: .utf8)
    }

    static var readable: Bool { source != nil }

    @Test(
        "the vault list is only built when no setup or unlock screen is pending",
        .enabled(if: readable, "the checkout is not present on a device")
    )
    func vaultsWaitForTheScreensAboveThem() throws {
        let source = try #require(Self.source)
        #expect(
            source.contains("if setup == nil, unlock == nil, vaults == nil {"),
            "a vault model built beside a pending setup is the screen a new account saw instead of its phrase"
        )
    }

    @Test(
        "the setup question stops the routing pass until it is answered",
        .enabled(if: readable, "the checkout is not present on a device")
    )
    func setupShortCircuitsTheRoute() throws {
        let source = try #require(Self.source)
        // The `return` is load-bearing: without it the pass falls through to
        // the unlock and vault branches while the server is still being asked
        // whether this account has any key material at all.
        #expect(source.contains("if setup == nil { setup = startup.accountSetupModel(for: state) }\n            return"))
    }

    @Test(
        "a device that already holds the master key never asks the setup question",
        .enabled(if: readable, "the checkout is not present on a device")
    )
    func anUnlockedDeviceSettlesSetup() throws {
        let source = try #require(Self.source)
        #expect(
            source.contains("setupSettled = true"),
            "an unlocked device must not spend a round trip asking whether its account is set up"
        )
    }

    /// A registry and opener that are never called: the list is only shown,
    /// not loaded.
    private struct Unused: VaultRegistry, VaultOpening {
        func vaults() async throws -> [VaultSummary] { [] }
        func open(_ vaultId: String) async throws -> Vault { Vault(noHandle: Vault.NoHandle()) }
    }

    /// A sign-out publishes `signedOut` one render before `route(for:)` drops
    /// the vault model. The account shell changes branch in that render, so a
    /// vault list still shown there was rebuilt: its stores reopened against
    /// the keychain the sign-out had just emptied (`auth.malformedToken`).
    @MainActor
    @Test("the vault list is shown only while the session is registered")
    func vaultsLeaveWithTheSession() {
        let vaults = VaultSelectionViewModel(
            registry: Unused(),
            opener: Unused(),
            snapshot: LaunchSnapshot(defaults: UserDefaults(suiteName: "auth-route-\(UUID().uuidString)")!)
        )
        #expect(AuthRootView.shownVaults(vaults, in: .registered) === vaults)
        for state: AuthState in [.signedOut, .sessionExpired, .revoked] {
            #expect(AuthRootView.shownVaults(vaults, in: state) == nil, "\(state)")
        }
    }
}
