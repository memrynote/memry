//! Temporary probe for #4668: why does the Recycle Bin delete abort.
use std::{
    fs,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use windows::core::{implement, Ref, Result as WResult, HRESULT, PCWSTR};
use windows::Win32::System::Com::*;
use windows::Win32::UI::Shell::*;

#[implement(IFileOperationProgressSink)]
struct Sink;

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for Sink_Impl {
    fn StartOperations(&self) -> WResult<()> { Ok(()) }
    fn FinishOperations(&self, hr: HRESULT) -> WResult<()> {
        if hr.is_err() { eprintln!("PROBE4668S Finish hr={:#x}", hr.0); }
        Ok(())
    }
    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> WResult<()> { Ok(()) }
    fn PostRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> WResult<()> { Ok(()) }
    fn PreMoveItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR) -> WResult<()> { Ok(()) }
    fn PostMoveItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> WResult<()> { Ok(()) }
    fn PreCopyItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR) -> WResult<()> { Ok(()) }
    fn PostCopyItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> WResult<()> { Ok(()) }
    fn PreDeleteItem(&self, flags: u32, _: Ref<IShellItem>) -> WResult<()> {
        if flags & 0x80 == 0 { eprintln!("PROBE4668S PreDelete NOT recyclable flags={flags:#x}"); }
        Ok(())
    }
    fn PostDeleteItem(&self, flags: u32, _: Ref<IShellItem>, hr: HRESULT, _: Ref<IShellItem>) -> WResult<()> {
        if hr.is_err() { eprintln!("PROBE4668S PostDelete flags={flags:#x} hr={:#x}", hr.0); }
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> WResult<()> { Ok(()) }
    fn PostNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR, _: &PCWSTR, _: u32, _: HRESULT, _: Ref<IShellItem>) -> WResult<()> { Ok(()) }
    fn UpdateProgress(&self, _: u32, _: u32) -> WResult<()> { Ok(()) }
    fn ResetTimer(&self) -> WResult<()> { Ok(()) }
    fn PauseTimer(&self) -> WResult<()> { Ok(()) }
    fn ResumeTimer(&self) -> WResult<()> { Ok(()) }
}

fn with_sink(path: &Path, flags: FILEOPERATION_FLAGS) -> Result<(), String> {
    unsafe {
        let pfo: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(|e| format!("create {e}"))?;
        pfo.SetOperationFlags(flags).map_err(|e| format!("flags {e}"))?;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).map_err(|e| format!("item {e}"))?;
        let sink: IFileOperationProgressSink = Sink.into();
        pfo.DeleteItem(&item, &sink).map_err(|e| format!("enqueue {e}"))?;
        let performed = pfo.PerformOperations();
        let aborted = pfo.GetAnyOperationsAborted().map_err(|e| format!("status {e}"))?;
        if let Err(e) = performed { return Err(format!("perform {e}")); }
        if aborted.as_bool() { return Err("aborted".to_owned()); }
        Ok(())
    }
}

fn make(root: &Path, i: usize) -> PathBuf {
    let dir = root.join(format!("Work{i}"));
    fs::create_dir_all(dir.join("Sub")).unwrap();
    fs::write(dir.join("a.md"), "---\nid: a\n---\nbody a\n").unwrap();
    fs::write(dir.join("b.md"), "---\nid: b\n---\nbody b\n").unwrap();
    dir
}

fn run(mode: &str, how: &dyn Fn(&Path) -> Result<(), String>, aged: bool, budget: Duration, vault: &Path) {
    let start = Instant::now();
    let (mut done, mut failed) = (0usize, 0usize);
    let mut n = 0usize;
    while start.elapsed() < budget {
        let batch: Vec<PathBuf> = (0..if aged { 60 } else { 1 }).map(|_| { n += 1; make(vault, n) }).collect();
        if aged { std::thread::sleep(Duration::from_secs(6)); }
        for dir in batch {
            done += 1;
            if let Err(e) = how(&dir) {
                failed += 1;
                eprintln!("PROBE4668 {mode} FAIL #{done}: {e}");
            }
        }
    }
    println!("PROBE4668 RESULT {mode}: {failed} failed / {done}");
}

fn main() {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(240);
    let budget = Duration::from_secs(secs);
    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    let crate_flags = FOF_NO_UI | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING;
    let electron_flags = FOF_NO_UI | FOFX_ADDUNDORECORD | FOF_NOERRORUI | FOF_SILENT | FOFX_SHOWELEVATIONPROMPT | FOFX_RECYCLEONDELETE;
    run("trash-crate fresh", &|p| trash::delete(p).map_err(|e| e.to_string()), false, budget, &vault);
    run("crate-flags+sink fresh", &|p| with_sink(p, crate_flags), false, budget, &vault);
    run("electron-flags+sink fresh", &|p| with_sink(p, electron_flags), false, budget, &vault);
    run("crate-flags+sink aged6s", &|p| with_sink(p, crate_flags), true, budget, &vault);
    run("trash-crate aged6s", &|p| trash::delete(p).map_err(|e| e.to_string()), true, budget, &vault);
}
