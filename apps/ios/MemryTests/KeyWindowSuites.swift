import Testing

/// The parent of every suite that makes a window key or gives a view the
/// caret. The app has one key window and one first responder, and
/// `.serialized` on a suite orders only its own tests: two such suites
/// running at once took the key window from each other, and their waits ran
/// into the time limit (#4893). Nested here, they run one at a time while
/// the rest of the plan stays parallel.
@Suite(.serialized)
@MainActor
enum KeyWindowSuites {}
