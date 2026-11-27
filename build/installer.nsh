; Included automatically by electron-builder (build/installer.nsh).
;
; The three trees with tens of thousands of small files (the app's node_modules, the npm-based CLIs,
; and Node itself) are packed into resources\payload.tar by afterPack (electron-builder.config.mjs).
; The stock NSIS path writes every file twice (7z extract into a temp folder, then CopyFiles into
; the install dir) and measured 19 min for 46k files with Defender on; one tar extraction of the same
; tree measured 46 s. System32\tar.exe is bsdtar and ships with Windows 10 1803 and later.
!macro customInstall
  IfFileExists "$INSTDIR\resources\payload.tar" unpackPayload donePayload
  unpackPayload:
    DetailPrint "Unpacking components..."
    nsExec::ExecToLog '"$SYSDIR\tar.exe" -xf "$INSTDIR\resources\payload.tar" -C "$INSTDIR\resources"'
    Pop $0
    StrCmp $0 "0" payloadOk payloadFailed
  payloadFailed:
    DetailPrint "Unpacking failed (tar exit $0)"
    MessageBox MB_OK|MB_ICONSTOP "Dazzi could not unpack its components (tar exit code $0). Free some disk space and run the installer again." /SD IDOK
    Abort
  payloadOk:
    Delete "$INSTDIR\resources\payload.tar"
  donePayload:
!macroend

; Restore Windows File Explorer as the default folder and Win+E handler when Dazzi is uninstalled,
; so removing Dazzi never leaves broken HKCU\Software\Classes commands behind.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Folder\shell\open"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\open"
  DeleteRegKey HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}"
  DeleteRegKey HKCU "Software\Classes\*\shell\AutoRAG.ask"
  DeleteRegKey HKCU "Software\Classes\*\shell\AutoRAG.reveal"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AutoRAG.ask"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AutoRAG.reveal"
!macroend
