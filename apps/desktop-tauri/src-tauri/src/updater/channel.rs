//! Which Velopack channel this install updates from. An x64 pack running emulated on an ARM64
//! Windows PC (the only Windows build Electron shipped) moves to the native `win-arm64` pack on its
//! next update; every other install keeps the channel its `sq.version` memorized.

use velopack::{UpdateInfo, UpdateOptions};

/// The Windows ARM64 pack's channel (Step 07, #3524).
const ARM64_CHANNEL: &str = "win-arm64";

/// `IMAGE_FILE_MACHINE_ARM64`.
const MACHINE_ARM64: u16 = 0xAA64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Switch {
    /// The memorized channel, no downgrade.
    Memorized,
    /// The native ARM64 pack of the same release or later.
    ToArm64,
}

impl Switch {
    /// The same version on another channel is a lateral update only when downgrade is allowed
    /// (velopack `manager.rs` `check_for_updates`).
    pub fn options(self) -> UpdateOptions {
        match self {
            Self::Memorized => UpdateOptions::default(),
            Self::ToArm64 => UpdateOptions {
                AllowVersionDowngrade: true,
                ExplicitChannel: Some(ARM64_CHANNEL.to_owned()),
                ..UpdateOptions::default()
            },
        }
    }

    /// Only a full package crosses architectures: a `win-arm64` delta does not apply to the x64
    /// package on disk. Velopack 1.2.161 ignores `MaximumDeltasBeforeFallback`, and a failed delta
    /// costs a wasted download before its full fallback, so the deltas are dropped up front.
    pub fn restrict(self, info: &mut UpdateInfo) {
        if self == Self::ToArm64 {
            info.BaseRelease = None;
            info.DeltasToTarget.clear();
        }
    }

    pub fn describe(self, memorized: &str) -> String {
        match self {
            Self::Memorized => memorized.to_owned(),
            Self::ToArm64 => format!("{ARM64_CHANNEL} (from {memorized}, x64 under emulation)"),
        }
    }
}

/// An x64 process reports no WOW64 machine (`IsWow64Process2` is about 32-bit processes), so the
/// process side is the compile target, and only the native machine is asked of the OS.
pub fn needs_arm64_channel(process_is_x64: bool, native_machine: u16) -> bool {
    process_is_x64 && native_machine == MACHINE_ARM64
}

pub fn current() -> Switch {
    if needs_arm64_channel(cfg!(target_arch = "x86_64"), native_machine()) {
        Switch::ToArm64
    } else {
        Switch::Memorized
    }
}

#[cfg(windows)]
fn native_machine() -> u16 {
    use windows::Win32::System::SystemInformation::IMAGE_FILE_MACHINE;
    use windows::Win32::System::Threading::{GetCurrentProcess, IsWow64Process2};

    let mut process = IMAGE_FILE_MACHINE::default();
    let mut native = IMAGE_FILE_MACHINE::default();
    // SAFETY: the pseudo handle of this process and two out-parameters this frame owns.
    match unsafe { IsWow64Process2(GetCurrentProcess(), &raw mut process, Some(&raw mut native)) } {
        Ok(()) => native.0,
        Err(error) => {
            tracing::warn!(scope = "Updater", "IsWow64Process2 failed: {error}");
            0
        }
    }
}

#[cfg(not(windows))]
fn native_machine() -> u16 {
    0
}

/// A release lower than the running one is never installed. The ARM64 switch allows downgrades
/// only to reach the same version on the native channel; a retracted release must not use it.
pub fn is_older(current: &semver::Version, target: &str) -> bool {
    semver::Version::parse(target).is_ok_and(|target| target < *current)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MACHINE_AMD64: u16 = 0x8664;

    #[test]
    fn only_an_x64_build_on_an_arm64_machine_moves_to_the_arm64_pack() {
        assert!(needs_arm64_channel(true, MACHINE_ARM64));
        assert!(!needs_arm64_channel(true, MACHINE_AMD64));
        assert!(!needs_arm64_channel(false, MACHINE_ARM64));
        assert!(!needs_arm64_channel(true, 0));
    }

    #[test]
    fn the_arm64_switch_allows_the_lateral_full_update_and_nothing_else_does() {
        let switch = Switch::ToArm64.options();
        assert_eq!(switch.ExplicitChannel.as_deref(), Some("win-arm64"));
        assert!(switch.AllowVersionDowngrade);
        let memorized = Switch::Memorized.options();
        assert_eq!(memorized.ExplicitChannel, None);
        assert!(!memorized.AllowVersionDowngrade);
    }

    #[test]
    fn the_move_to_the_arm64_pack_downloads_the_full_package() {
        let delta = || UpdateInfo {
            BaseRelease: Some(velopack::VelopackAsset::default()),
            DeltasToTarget: vec![velopack::VelopackAsset::default()],
            ..UpdateInfo::default()
        };
        let mut moving = delta();
        Switch::ToArm64.restrict(&mut moving);
        assert!(moving.BaseRelease.is_none() && moving.DeltasToTarget.is_empty());
        let mut staying = delta();
        Switch::Memorized.restrict(&mut staying);
        assert_eq!(staying.DeltasToTarget.len(), 1);
    }

    #[test]
    fn a_lower_release_is_older_and_the_same_or_a_higher_one_is_not() {
        let current = semver::Version::parse("2099.101.3").unwrap();
        assert!(is_older(&current, "2099.101.2"));
        assert!(!is_older(&current, "2099.101.3"));
        assert!(!is_older(&current, "2099.101.4"));
        assert!(!is_older(&current, "not a version"));
    }
}
