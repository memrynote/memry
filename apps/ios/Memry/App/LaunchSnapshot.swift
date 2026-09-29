import Foundation
import SwiftUI

// Where the user was, so the next launch continues there: the vault, the tab,
// each tab's stack, and scroll offsets.
//
// `UserDefaults` rather than `@SceneStorage`: iOS drops scene storage when the
// user swipes the app away, which is the relaunch this exists for.
//
// Only ids and offsets are stored, never titles or text, because
// `UserDefaults` sits outside the vault's encryption. Sign-out clears it.
//
// Stack changes are written through on each change. Scroll offsets change on
// every frame, so they are held in memory and written when the app leaves the
// foreground (`flush()`), which comes before any swipe-away kill.

final class LaunchSnapshot: @unchecked Sendable {
    static let shared = LaunchSnapshot()

    struct VaultState: Codable, Equatable {
        var tab: String?
        var stacks: [String: Data] = [:]
        var scroll: [String: Double] = [:]
    }

    private struct Stored: Codable {
        var lastVault: String?
        var vaults: [String: VaultState] = [:]
    }

    private static let key = "launchSnapshot.v1"
    private static let scrollLimit = 32
    private let defaults: UserDefaults
    private let lock = NSLock()
    private var stored: Stored
    private var dirty = false
    /// The vault the shell has open; every per-vault read and write goes here.
    private var current: String?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        stored = defaults.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode(Stored.self, from: $0) } ?? Stored()
    }

    // MARK: - Vault

    /// The vault open when the app was last used.
    var lastVault: String? { lock.withLock { stored.lastVault } }

    /// A vault was opened: it becomes the one to reopen, and the scope for
    /// everything below.
    func vaultOpened(_ id: String) {
        lock.withLock {
            current = id
            stored.lastVault = id
        }
        write()
    }

    /// The user asked to choose again: the next launch shows the list.
    func vaultClosed() {
        lock.withLock {
            current = nil
            stored.lastVault = nil
        }
        write()
    }

    /// Only vaults still on the account keep a state.
    func prune(keeping ids: Set<String>) {
        lock.withLock {
            stored.vaults = stored.vaults.filter { ids.contains($0.key) }
            if let last = stored.lastVault, !ids.contains(last) { stored.lastVault = nil }
        }
        write()
    }

    /// Sign-out: nothing about the account survives.
    func clear() {
        lock.withLock {
            current = nil
            stored = Stored()
            dirty = false
        }
        defaults.removeObject(forKey: Self.key)
    }

    // MARK: - Per vault

    var tab: String? { lock.withLock { state?.tab } }

    func setTab(_ tab: String) {
        guard update({ $0.tab = tab }) else { return }
        write()
    }

    func stack(_ name: String) -> Data? { lock.withLock { state?.stacks[name] } }

    func setStack(_ name: String, _ data: Data?) {
        guard update({ $0.stacks[name] = data }) else { return }
        write()
    }

    func stack<T: Decodable>(_ name: String, as type: T.Type) -> T? {
        stack(name).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    func setStack<T: Encodable>(_ name: String, value: T) {
        setStack(name, try? JSONEncoder().encode(value))
    }

    func scroll(_ name: String) -> Double? { lock.withLock { state?.scroll[name] } }

    /// Held in memory until ``flush()``.
    func setScroll(_ name: String, _ offset: Double) {
        _ = update { vault in
            // One key per note ever opened would grow without bound; past a
            // handful, only the screen being scrolled keeps its offset.
            if vault.scroll[name] == nil, vault.scroll.count >= Self.scrollLimit {
                vault.scroll = vault.scroll.filter { !$0.key.hasPrefix("note.") }
            }
            vault.scroll[name] = offset > 0 ? offset : nil
        }
    }

    /// Writes held scroll offsets. Called when the scene leaves the foreground.
    func flush() {
        guard lock.withLock({ dirty }) else { return }
        write()
    }

    // MARK: - Storage

    /// Caller holds the lock.
    private var state: VaultState? {
        guard let current else { return nil }
        return stored.vaults[current] ?? VaultState()
    }

    /// `false` when no vault is open, so nothing is written under no scope.
    private func update(_ change: (inout VaultState) -> Void) -> Bool {
        lock.withLock {
            guard let current else { return false }
            var vault = stored.vaults[current] ?? VaultState()
            change(&vault)
            guard stored.vaults[current] != vault else { return false }
            stored.vaults[current] = vault
            dirty = true
            return true
        }
    }

    private func write() {
        let data: Data? = lock.withLock {
            dirty = false
            return try? JSONEncoder().encode(stored)
        }
        if let data { defaults.set(data, forKey: Self.key) }
    }
}

extension LaunchSnapshot {
    /// A `NavigationPath` stack. A route type this build no longer decodes
    /// restores as the root rather than failing.
    func path(_ name: String) -> NavigationPath {
        guard let representation = stack(name, as: NavigationPath.CodableRepresentation.self) else {
            return NavigationPath()
        }
        return NavigationPath(representation)
    }

    func setPath(_ name: String, _ path: NavigationPath) {
        // `nil` when a route on it is not `Codable`; the root is saved then.
        setStack(name, try? path.codable.map { try JSONEncoder().encode($0) })
    }
}

extension View {
    /// Restores this scroll view's offset under `name` once its content is
    /// tall enough to hold it, then records every change.
    func restoresScroll(_ name: String) -> some View {
        modifier(ScrollRestoration(name: name))
    }
}

private struct ScrollRestoration: ViewModifier {
    let name: String
    @State private var position = ScrollPosition(edge: .top)
    @State private var restored = false

    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .onScrollGeometryChange(for: ScrollGeometry.self) { $0 } action: { _, geometry in
                let snapshot = LaunchSnapshot.shared
                let offset = geometry.contentOffset.y + geometry.contentInsets.top
                if restored {
                    snapshot.setScroll(name, offset)
                    return
                }
                guard let saved = snapshot.scroll(name) else {
                    restored = true
                    return
                }
                // Content still loading: wait until the offset fits, or the
                // restore lands short and is recorded as the new position.
                let reachable = geometry.contentSize.height - geometry.containerSize.height
                    + geometry.contentInsets.top + geometry.contentInsets.bottom
                guard reachable >= saved else { return }
                restored = true
                position.scrollTo(y: saved)
            }
            // A screen that never grows tall enough gives up after a moment,
            // so the user's own scrolling is recorded from then on.
            .task {
                try? await Task.sleep(for: .seconds(2))
                restored = true
            }
    }
}
