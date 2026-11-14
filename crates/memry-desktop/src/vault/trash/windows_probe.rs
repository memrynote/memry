//! TEMPORARY probe for #4668.
use std::{os::windows::ffi::OsStrExt, os::windows::fs::OpenOptionsExt, path::Path};
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

struct Com;
impl Com {
    fn init() -> Com {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
        Com
    }
}
impl Drop for Com {
    fn drop(&mut self) { unsafe { CoUninitialize() } }
}
thread_local! { static COM: Com = Com::init(); }

fn attempt(path: &Path) -> Result<(), String> {
    COM.with(|_| ());
    unsafe {
        let pfo: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(|e| format!("create {e}"))?;
        pfo.SetOperationFlags(FOF_NO_UI | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING).map_err(|e| format!("flags {e}"))?;
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

fn dump(p: &Path, depth: usize) {
    // FILE_FLAG_BACKUP_SEMANTICS opens a directory; share mode 0 fails while anyone holds it.
    let mut o = std::fs::OpenOptions::new();
    o.read(true).share_mode(0).custom_flags(0x0200_0000);
    let state = match o.open(p) { Ok(_) => "free".to_owned(), Err(e) => format!("HELD {e}") };
    eprintln!("PROBE4668 {:indent$}{} {state}", "", p.display(), indent = depth * 2);
    let Ok(rd) = std::fs::read_dir(p) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() { dump(&path, depth + 1); } else {
            let st = match std::fs::OpenOptions::new().read(true).share_mode(0).open(&path) { Ok(_) => "free".to_owned(), Err(e) => format!("HELD {e}") };
            eprintln!("PROBE4668 {:indent$}{} {st}", "", path.display(), indent = (depth + 1) * 2);
        }
    }
}

pub fn delete(path: &Path) -> Result<(), String> {
    match attempt(path) {
        Ok(()) => Ok(()),
        Err(first) => {
            eprintln!("PROBE4668 first attempt failed: {first}");
            dump(path, 1);
            if let Some(parent) = path.parent() { dump(parent, 0); }
            let again = attempt(path);
            eprintln!("PROBE4668 retry: {again:?}");
            Err(first)
        }
    }
}
