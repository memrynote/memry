//! The process-wide ONNX Runtime environment and the priority of the thread that runs the model.

use std::sync::OnceLock;

use ort::environment::Environment;
use ort::session::Session;
use ort::session::builder::{AutoDevicePolicy, GraphOptimizationLevel, SessionBuilder};

use crate::MlError;

static ENVIRONMENT: OnceLock<Environment> = OnceLock::new();

/// The environment every session is built in, with ONNX Runtime's telemetry off.
fn environment() -> Result<&'static Environment, MlError> {
    if let Some(environment) = ENVIRONMENT.get() {
        return Ok(environment);
    }
    let built = ort::init()
        .with_name("memry")
        .with_telemetry(false)
        .build()
        .map_err(|error| MlError::Load(error.to_string()))?;
    // A racing thread may have set it first; its environment is the same configuration.
    Ok(ENVIRONMENT.get_or_init(|| built))
}

/// A session builder with the worker's options: the CPU execution provider only, `intra_threads`
/// within an operator, one thread across operators, every graph optimisation.
pub(crate) fn session_builder(intra_threads: usize) -> Result<SessionBuilder, MlError> {
    let load = |error: String| MlError::Load(error);
    Session::builder(environment()?)
        .map_err(|error| load(error.to_string()))?
        // ort's default policy picks an execution provider per device and on macOS registers the
        // linked CoreML provider, which refuses the text graph's empty feature inputs.
        .with_auto_device(AutoDevicePolicy::PreferCPU)
        .map_err(|error| load(error.to_string()))?
        .with_optimization_level(GraphOptimizationLevel::All)
        .map_err(|error| load(error.to_string()))?
        .with_intra_threads(intra_threads)
        .map_err(|error| load(error.to_string()))?
        .with_inter_threads(1)
        .map_err(|error| load(error.to_string()))
}

/// Lowers the calling thread to background priority, so embedding a vault never competes with
/// the UI: QoS background class on macOS, nice 10 on Linux, below normal on Windows.
pub fn lower_thread_priority() -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: plain FFI call on the current thread; it returns an errno value.
        let code = unsafe {
            libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0)
        };
        if code != 0 {
            return Err(std::io::Error::from_raw_os_error(code));
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Linux applies `setpriority` with a thread id to that thread alone.
        // SAFETY: plain FFI calls on the current thread.
        let code = unsafe {
            let tid = libc::gettid();
            libc::setpriority(libc::PRIO_PROCESS, tid as libc::id_t, 10)
        };
        if code != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
        };
        // SAFETY: the pseudo handle of the current thread is always valid.
        unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL) }
            .map_err(std::io::Error::other)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Building the environment calls into the linked ONNX Runtime, so this fails on a target
    /// whose static library is missing or does not link.
    #[test]
    fn environment_builds_once() {
        let first = environment().expect("environment");
        let second = environment().expect("environment");
        assert!(std::ptr::eq(first, second));
        session_builder(1).expect("session builder");
    }

    #[test]
    fn lower_thread_priority_lowers_only_the_calling_thread() {
        let lowered = std::thread::spawn(|| {
            lower_thread_priority().expect("lower");
            current_priority()
        })
        .join()
        .expect("thread");
        assert_eq!(lowered, LOWERED);
        assert_ne!(current_priority(), LOWERED);
    }

    #[cfg(target_os = "macos")]
    const LOWERED: i64 = libc::qos_class_t::QOS_CLASS_BACKGROUND as i64;
    #[cfg(target_os = "linux")]
    const LOWERED: i64 = 10;
    #[cfg(windows)]
    const LOWERED: i64 = windows::Win32::System::Threading::THREAD_PRIORITY_BELOW_NORMAL.0 as i64;

    #[cfg(target_os = "macos")]
    fn current_priority() -> i64 {
        let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
        let mut relative = 0;
        // SAFETY: both out-pointers are valid for the call.
        let code = unsafe {
            libc::pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut relative)
        };
        assert_eq!(code, 0);
        class as i64
    }

    #[cfg(target_os = "linux")]
    fn current_priority() -> i64 {
        // SAFETY: plain FFI calls on the current thread.
        unsafe { libc::getpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t) as i64 }
    }

    #[cfg(windows)]
    fn current_priority() -> i64 {
        use windows::Win32::System::Threading::{GetCurrentThread, GetThreadPriority};
        // SAFETY: the pseudo handle of the current thread is always valid.
        unsafe { GetThreadPriority(GetCurrentThread()) as i64 }
    }
}
