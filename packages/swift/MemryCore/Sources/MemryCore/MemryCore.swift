/// Namespace for the Rust core's Swift surface.
///
/// Everything callable lives in `Generated/`, written by
/// `crates/memry-core/build-xcframework.sh`. This file exists so the target
/// always has a source, including on a clean checkout before the first build.
public enum MemryCore {
    /// Version of the Swift wrapper, not of the core. The core reports its own.
    public static let wrapperVersion = "0.1.0"
}
