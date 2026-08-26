# Custom NSIS include, picked up automatically from directories.buildResources.
#
# Why this exists — stock electron-builder makes a Windows update all-or-nothing.
# templates/nsis/uninstaller.nsh runs two different removal paths:
#
#   ${if} ${isUpdated}                 # update: every file in $INSTDIR is
#     un.atomicRMDir                   # Rename'd into $PLUGINSDIR\old-install,
#     ${if} $R0 != 0                   # and ONE unrenameable file (AV holding a
#       un.restoreFiles                # handle, a stray process, an ACL) rolls
#       Abort                          # the whole thing back and aborts.
#   ${endif}
#   RMDir /r $INSTDIR                  # plain uninstall: best-effort, tolerant
#
# The Abort exits the uninstaller with code 2, and include/installUtil.nsh's
# handleUninstallResult turns that into "Failed to uninstall old application
# files. Please try running the installer again.: 2" and quits the installer.
# Nothing is installed. Since the installer always passes --updated when it
# removes the old version, BOTH the in-app updater and manually running the new
# setup.exe over an existing install take the strict path and fail — while
# uninstalling from Control Panel first takes the tolerant RMDir path and works.
# That is exactly the "the only way I can update is to uninstall and reinstall"
# report from Windows users.
#
# customRemoveFiles replaces that whole block (see the !ifmacrodef in
# uninstaller.nsh), so this macro owns both paths.
#
# ── The self-destruct problem (#1851) ────────────────────────────────────────
#
# Both the stock template and the first version of this macro DELETE the old
# install before the new one exists: the uninstaller's staging area is
# $PLUGINSDIR, which NSIS wipes the moment the uninstaller process exits — long
# before the installer extracts a single new file. The window between "old
# install removed" and "new install written" is therefore unprotected. An
# extraction failure, a declined elevation, AV quarantining the freshly written
# exe — or, worst of all, Windows killing the silent installer that
# autoInstallOnAppQuit spawned during an OS shutdown — leaves the user with an
# install directory holding only the uninstaller and a Start menu shortcut that
# points at nothing. Recovery required a manual uninstall + reinstall.
#
# The fix is to make the removal recoverable at every step:
#
#   1. The update-path removal MOVES the old install into a sibling directory
#      ("$INSTDIR.update-backup" — same volume, so it is pure Rename, no copy,
#      no extra disk) instead of deleting it. Every file is always in exactly
#      one of the two directories, so an interruption at ANY point loses
#      nothing.
#   2. Before touching anything, the uninstaller arms a HKCU RunOnce entry: at
#      the next logon, if "$INSTDIR\<exe>" is missing, robocopy moves the
#      backup back; once the exe exists the leftover backup is deleted. This
#      is the only mechanism that survives the installer being KILLED (OS
#      shutdown mid-update) — no NSIS callback runs in that case.
#   3. .onInstFailed restores the backup in-process for the failures that DO
#      reach a callback (assisted-UI cancel, extraction failure).
#   4. customInstall — which only runs after the new files are on disk —
#      disarms the RunOnce entry and deletes the backup.
#
# A busy file (AV handle, stray process) no longer aborts the update either:
# the move falls back to restore + CopyFiles (a copy can read a mapped file),
# then the same tolerant sweep a manual uninstall would have done.
#
# The last obstacle is the app binary itself. It cannot be DELETED while a
# process still has it mapped — but Windows will happily RENAME it, because the
# loader opens an image with FILE_SHARE_DELETE. That asymmetry is why the happy
# path is rename-based, and it is the escape hatch at the end too: move the
# live binary aside and the installer has a clean $INSTDIR to extract into,
# with the running process still pointing at the renamed inode until it exits.

# These mirror common.nsh's APP_EXECUTABLE_FILENAME / UNINSTALL_FILENAME. They
# must be re-derived here because this include is compiled BEFORE common.nsh
# (electron-builder prepends the custom include to the script), so the
# template's defines do not exist yet at this point. PRODUCT_FILENAME and
# APP_ID arrive via makensis -D flags and are always available.
!define MEMRY_APP_EXE "${PRODUCT_FILENAME}.exe"
!define MEMRY_UNINSTALL_EXE "Uninstall ${PRODUCT_FILENAME}.exe"
!define MEMRY_RUNONCE_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!define MEMRY_RUNONCE_NAME "${APP_ID}.update-restore"

!ifdef BUILD_UNINSTALLER
  Var updateBackupDir

  # Recursive move of $INSTDIR into $updateBackupDir — the same walk as the
  # template's un.atomicRMDir, but renaming into a directory that SURVIVES the
  # uninstaller's exit instead of into $PLUGINSDIR. Plain NSIS only (no
  # LogicLib) because this compiles before the template's includes.
  # Push "" (subpath) before calling; returns 0 on success or the path of the
  # first file that could not be renamed.
  Function un.moveToUpdateBackup
    Exch $R0
    Push $R1
    Push $R2
    Push $R3

    StrCpy $R3 "$INSTDIR$R0\*.*"
    FindFirst $R1 $R2 $R3

    loop:
      StrCmp $R2 "" break

      StrCmp $R2 "." continue
      StrCmp $R2 ".." continue

      IfFileExists "$INSTDIR$R0\$R2\*.*" isDir isNotDir

      isDir:
        CreateDirectory "$updateBackupDir$R0\$R2"

        Push "$R0\$R2"
        Call un.moveToUpdateBackup
        Pop $R3

        StrCmp $R3 "0" continue done

      isNotDir:
        ClearErrors
        Rename "$INSTDIR$R0\$R2" "$updateBackupDir$R0\$R2"

        # Ignore errors when renaming the uninstaller itself (it may be held
        # by the copy the installer is ExecWait'ing).
        StrCmp "$R0\$R2" "\${MEMRY_UNINSTALL_EXE}" 0 +2
        ClearErrors

        IfErrors 0 continue
        StrCpy $R3 "$INSTDIR$R0\$R2"
        Goto done

      continue:
        FindNext $R1 $R2
        Goto loop

    break:
      StrCpy $R3 0

    done:
      FindClose $R1

      StrCpy $R0 $R3

      Pop $R3
      Pop $R2
      Pop $R1
      Exch $R0
  FunctionEnd

  # Inverse walk: move everything in $updateBackupDir back into $INSTDIR.
  # Used when the rename pass hit a busy file and the removal falls back to
  # copy-then-sweep, so the copy sees one complete tree.
  Function un.restoreFromUpdateBackup
    Exch $R0
    Push $R1
    Push $R2
    Push $R3

    StrCpy $R3 "$updateBackupDir$R0\*.*"
    FindFirst $R1 $R2 $R3

    loop:
      StrCmp $R2 "" break

      StrCmp $R2 "." continue
      StrCmp $R2 ".." continue

      IfFileExists "$updateBackupDir$R0\$R2\*.*" isDir isNotDir

      isDir:
        CreateDirectory "$INSTDIR$R0\$R2"

        Push "$R0\$R2"
        Call un.restoreFromUpdateBackup
        Pop $R3

        Goto continue

      isNotDir:
        ClearErrors
        Rename "$updateBackupDir$R0\$R2" "$INSTDIR$R0\$R2"

      continue:
        FindNext $R1 $R2
        Goto loop

    break:
      StrCpy $R0 0
      FindClose $R1

      Pop $R3
      Pop $R2
      Pop $R1
      Exch $R0
  FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
  # Restore the moved-aside install when the installer aborts AFTER the old
  # version was removed (assisted-UI cancel, extraction failure, silent-mode
  # auto-abort). Copy, not move: the RunOnce entry stays armed and cleans the
  # backup up at the next logon, and a half-copied restore here must not eat
  # the backup. A killed installer (OS shutdown) never reaches this callback —
  # that case is covered by the RunOnce entry alone.
  Function .onInstFailed
    IfFileExists "$INSTDIR\${MEMRY_APP_EXE}" restoreDone
    IfFileExists "$INSTDIR.update-backup\*.*" 0 restoreDone
    ClearErrors
    CopyFiles /SILENT "$INSTDIR.update-backup\*.*" "$INSTDIR"
    restoreDone:
  FunctionEnd
!endif

# Why customInstall exists — the Start menu entry must survive every path.
#
# electron-builder's keep-shortcuts handshake preserves shortcuts (and thus
# Start/taskbar pins) across silent auto-updates, but it has two holes that
# real Windows users fell into:
#
#   1. templates/nsis/include/installer.nsh's addStartMenuLink, on the
#      keepShortcuts=true path, only RENAMES an existing link — a MISSING
#      Start menu link is never recreated ("the user deleted it" is assumed).
#      Any one-time loss becomes permanent: every later update keeps the
#      shortcut missing, the app vanishes from Start search, and pinning
#      looks broken to the user.
#   2. include/installUtil.nsh's setIsTryToKeepShortcuts disables the keep
#      mechanism entirely when allowToChangeInstallationDirectory is defined
#      and the run is not an auto-update (--updated). Manually running a
#      downloaded setup.exe over an existing install — the exact workaround
#      users learned while in-place updates were broken (see
#      customRemoveFiles below) — therefore wipes shortcuts and unregisters
#      the AppUserModelID, killing Start menu and taskbar pins.
#
# Both holes end in the same state: no "$SMPROGRAMS\MemryNote.lnk". This
# macro runs at the end of every install (fresh, auto-update, manual rerun)
# and recreates the Start menu link only when it is missing, with the AUMID
# stamped so Windows groups/pins it as com.memrynote.memry. When the link
# exists it is left untouched, so a live pin is never disturbed. The pin
# itself cannot be restored programmatically (Windows offers no API), but
# with the link and AUMID back the user can re-pin — and with in-place
# updates fixed, the keep path preserves that pin from then on.
#
# It is also the update's commit point: it only runs after the new files are
# on disk, so this is where the removal's safety net is disarmed — first the
# RunOnce entry (so a kill between the two deletes can at worst leave a stale
# backup, never resurrect one), then the backup itself. Both are no-ops for a
# fresh install, and they also clean up leftovers when a manual reinstall
# repairs a previously failed update.
!macro customInstall
  ${ifNot} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    # refresh the shell so Start search picks the entry up immediately
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${endIf}

  DeleteRegValue HKCU "${MEMRY_RUNONCE_KEY}" "${MEMRY_RUNONCE_NAME}"
  RMDir /r "$INSTDIR.update-backup"
!macroend

!macro customRemoveFiles
  ${if} ${isUpdated}
    StrCpy $updateBackupDir "$INSTDIR.update-backup"

    # A leftover backup from an earlier failed update whose RunOnce never got
    # a chance to run. The current install is the state to preserve now.
    RMDir /r "$updateBackupDir"

    # Arm the safety net BEFORE touching any file, so even a kill inside the
    # move below is recoverable at the next logon. The command restores the
    # backup only while the exe is missing, and removes the backup only once
    # the exe exists — so a partially failed robocopy keeps the backup for
    # the next attempt instead of deleting the only copy.
    WriteRegStr HKCU "${MEMRY_RUNONCE_KEY}" "${MEMRY_RUNONCE_NAME}" 'cmd.exe /c if not exist "$INSTDIR\${MEMRY_APP_EXE}" robocopy "$updateBackupDir" "$INSTDIR" /E /MOVE >nul 2>&1 & if exist "$INSTDIR\${MEMRY_APP_EXE}" rmdir /s /q "$updateBackupDir"'

    CreateDirectory "$updateBackupDir"

    Push ""
    Call un.moveToUpdateBackup
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy: $R0"
      DetailPrint "Atomic move failed; falling back to copy + in-place removal."

      # Reassemble the original tree so the copy below sees every file in one
      # place, then COPY it into the backup — CopyFiles can read a file whose
      # image is mapped by a running process, which Rename could not move.
      Push ""
      Call un.restoreFromUpdateBackup
      Pop $R9

      ClearErrors
      CreateDirectory "$updateBackupDir"
      CopyFiles /SILENT "$INSTDIR\*.*" "$updateBackupDir"
      ClearErrors
    ${endif}
  ${endif}

  # Move out of $INSTDIR so it can be removed. After a clean move this only
  # clears the leftover empty directory skeleton; on the busy-file fallback it
  # is the same tolerant sweep a manual uninstall would have done — it deletes
  # what it can and skips what it cannot, leaving only genuinely locked files
  # behind for the installer to overwrite.
  SetOutPath $TEMP
  RMDir /r $INSTDIR

  # Do NOT schedule the sweep's leftovers with /REBOOTOK: the installer is about
  # to extract the new version into this very directory, and a pending
  # reboot-time delete would take the fresh install with it. The single file
  # below is the exception, and only because its name is one the installer never
  # writes.
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "$INSTDIR\${APP_EXECUTABLE_FILENAME} is still in use; renaming it aside."

    # A leftover from an earlier pass that was never rebooted away. Rename fails
    # if the destination exists, so clear it first — best-effort, because if it
    # is still mapped the rename below fails and we abort exactly as before.
    Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}.old-update"

    ClearErrors
    Rename "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}.old-update"

    ${if} ${errors}
      DetailPrint "Could not rename $INSTDIR\${APP_EXECUTABLE_FILENAME}; aborting."
      Abort `Can't remove "$INSTDIR\${APP_EXECUTABLE_FILENAME}".`
    ${else}
      # Safe to schedule: nothing the installer extracts is ever called
      # "<app>.exe.old-update", so this pending delete cannot reach the new
      # install. SetRebootFlag false because the user has nothing to do — the
      # update is complete either way and the leftover goes at the next reboot
      # (or is deleted by the block above on the next update, whichever is
      # first). Prompting to restart Windows over a stale file would be noise.
      Delete /REBOOTOK "$INSTDIR\${APP_EXECUTABLE_FILENAME}.old-update"
      SetRebootFlag false
      DetailPrint "Renamed the in-use binary aside; continuing with the update."
    ${endif}
  ${endif}
!macroend
