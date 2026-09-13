import Foundation

// T147. Which server this build talks to, and the refusal to guess.
//
// **The base URL is not hard-coded and prod is not reachable by accident.**
// Three environments exist, and the rules below are arranged so that the two
// ways a build has historically ended up pointed at the wrong one are both
// refused rather than defaulted through:
//
//   * **A missing configuration never falls back to localhost.** A Memry
//     worktree without its env file has silently resolved to
//     `http://localhost:8787`, and the app then looked like it worked while
//     talking to nothing. Here an unconfigured release build is a fault the
//     user sees, not a quiet local URL.
//   * **`production` is never the answer to an absent or ambiguous input.** It
//     is selectable only by an explicit, correctly-spelled Info.plist value in
//     a build compiled without `DEBUG`. A debug build asking for it is a fault,
//     which is what makes "a developer build cannot reach prod" a property of
//     the resolver rather than a habit.
//
// Phase 4 runs against **staging only** and nothing here points at prod.

/// One deployment of the sync server.
enum SyncEnvironment: String, Sendable, CaseIterable {
    case staging
    case production
    case local

    /// No trailing slash: the core appends paths beginning with `/`.
    var baseURL: String {
        switch self {
        case .staging: "https://sync-staging.memrynote.com"
        case .production: "https://sync.memrynote.com"
        case .local: "http://localhost:8787"
        }
    }
}

/// Why a build has no environment. Each case is a distinct misconfiguration,
/// because "could not tell" must never render as one generic shrug and must
/// never render as "nothing wrong".
enum SyncEnvironmentFault: Sendable, Equatable {
    /// A value was configured and matches no environment. Deliberately not
    /// "fall back to staging": a typo that silently worked would be found in
    /// production.
    case unrecognisedName
    /// `production` was asked for from a build that may not have it.
    case productionNotSelectable
    /// A release build with nothing configured at all.
    case notConfigured

    /// Shown on the one screen that exists when this happens. Written against
    /// `DESIGN.md` §"Error copy, in detail" rather than produced by
    /// `ErrorMapping`, which maps **core** errors: no core call has been made
    /// when this is decided, and there is no core error to map.
    ///
    /// It reuses `UserFacingError` unchanged, which is the shape T147 ratifies
    /// (spec-defect 95) — a shell-originated failure needs no field the core's
    /// errors did not already need.
    var userFacing: UserFacingError {
        switch self {
        case .unrecognisedName:
            UserFacingError(
                code: "shell.syncEnvironmentUnrecognised",
                title: "This build of Memry names a server that does not exist.",
                guidance: "It has not contacted anything. Install a build from the App Store.",
                recourse: .blocked,
                isUserVisible: true
            )
        case .productionNotSelectable:
            UserFacingError(
                code: "shell.syncEnvironmentProductionRefused",
                title: "This build of Memry may not use the live server.",
                guidance: "It has not contacted anything. Install a build from the App Store.",
                recourse: .blocked,
                isUserVisible: true
            )
        case .notConfigured:
            UserFacingError(
                code: "shell.syncEnvironmentMissing",
                title: "This build of Memry has no server configured.",
                guidance: "It has not contacted anything. Install a build from the App Store.",
                recourse: .blocked,
                isUserVisible: true
            )
        }
    }
}

/// Resolved, or a named fault. There is no third answer and no default.
enum SyncEnvironmentChoice: Sendable, Equatable {
    case resolved(SyncEnvironment)
    case misconfigured(SyncEnvironmentFault)
}

/// The rules, as a pure function of its three inputs so that every branch is
/// reachable from a test without a second build configuration.
enum SyncEnvironmentResolver {
    /// Set from a build setting on the release configuration. **Absent today**,
    /// deliberately: adding it means editing `Memry/Resources/Info.plist` and
    /// the project's build settings, both shared files, and T147 does not own
    /// them. Until it is added, a debug build resolves to staging (below) and a
    /// release build is `notConfigured`, which is the loud half of the rule.
    static let infoDictionaryKey = "MemrySyncEnvironment"

    /// `--sync-environment=local`, for pointing a local build at
    /// `wrangler dev`. Cannot select `production`; see ``resolve``.
    static let launchArgumentPrefix = "--sync-environment="

    /// - Parameters:
    ///   - configuredName: the Info.plist value, or `nil` when the key is absent.
    ///   - launchArguments: `ProcessInfo.processInfo.arguments`.
    ///   - isDebugBuild: `true` when compiled with `DEBUG`.
    static func resolve(
        configuredName: String?,
        launchArguments: [String],
        isDebugBuild: Bool
    ) -> SyncEnvironmentChoice {
        if let argument = launchArguments
            .first(where: { $0.hasPrefix(launchArgumentPrefix) })?
            .dropFirst(launchArgumentPrefix.count) {
            // An override the operator typed. `production` is refused here on
            // every build, debug or not: a command line is exactly where a
            // wrong word reaches the live server.
            guard let named = SyncEnvironment(rawValue: String(argument)) else {
                return .misconfigured(.unrecognisedName)
            }
            return named == .production ? .misconfigured(.productionNotSelectable) : .resolved(named)
        }

        guard let configuredName else {
            // Nothing configured. A debug build is a development build and
            // development means staging; a release build that reached here was
            // shipped without its setting and says so.
            return isDebugBuild ? .resolved(.staging) : .misconfigured(.notConfigured)
        }

        guard let named = SyncEnvironment(rawValue: configuredName) else {
            return .misconfigured(.unrecognisedName)
        }
        if named == .production && isDebugBuild {
            return .misconfigured(.productionNotSelectable)
        }
        return .resolved(named)
    }
}

extension SyncEnvironment {
    /// This process's answer.
    static var current: SyncEnvironmentChoice {
        #if DEBUG
        let isDebugBuild = true
        #else
        let isDebugBuild = false
        #endif
        return SyncEnvironmentResolver.resolve(
            configuredName: Bundle.main.object(
                forInfoDictionaryKey: SyncEnvironmentResolver.infoDictionaryKey
            ) as? String,
            launchArguments: ProcessInfo.processInfo.arguments,
            isDebugBuild: isDebugBuild
        )
    }
}
