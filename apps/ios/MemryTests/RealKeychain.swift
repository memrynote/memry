import Testing

/// The one place a test may touch the **real** keychain from, and the reason
/// it exists is spec-defect 131.
///
/// data-model §B fixes five account names under one service, and two suites
/// both have to use those exact identities to prove what they exist to prove:
/// `KeychainRealStoreTests` proves the core writes §B's service and accounts,
/// and `SignOutKeychainTests` proves the real `Keychain.clear()` deletes those
/// same five. Neither can move to a test-only service without ceasing to be
/// evidence of anything.
///
/// Swift Testing runs sibling suites **in parallel**, and `.serialized` on a
/// suite orders only that suite's own tests — it does nothing between
/// siblings. So the two ran at once against one process-wide store, and a
/// whole-plan run failed with a value the other suite had written.
///
/// **The direction that matters is the silent one.** The sign-out suite can
/// *pass* because the other suite's `clear()` happened to run first, which is
/// a green result for a deletion that was never performed; and the keychain
/// suite can *fail* for a reason that has nothing to do with the keychain.
/// One of those costs an afternoon of debugging. The other ships a sign-out
/// that leaves a master key on the phone.
///
/// **Nesting is the mechanism, not decoration.** `.serialized` is inherited by
/// sub-suites, so no two tests anywhere under `RealKeychainSuite` run at the
/// same time, whatever file they live in. A lock taken per test would order
/// them too — but `SignOutKeychainTests` is `async` and holds the keychain
/// across `await`s, so that lock would have to be held across a suspension
/// point, which is the shape that causes this family of bug rather than one
/// that fixes it.
///
/// **A third suite must not be able to forget.** The SwiftLint custom rule
/// `real_keychain_must_be_serialized` (`apps/ios/.swiftlint.yml`) fails the
/// project-wide `swiftlint --strict` on any test file naming `SecItemAdd`,
/// `SecItemDelete`, `SecItemUpdate`, `SecItemCopyMatching` or
/// `SystemKeychainItemStore` unless that file is on its short excluded list.
/// A new real-keychain test therefore cannot land without someone reading
/// this comment and nesting the suite here.
@Suite("the real keychain, one suite at a time", .serialized)
struct RealKeychainSuite {}
