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
    MessageBox MB_OK|MB_ICONSTOP "AutoRAG could not unpack its components (tar exit code $0). Free some disk space and run the installer again." /SD IDOK
    Abort
  payloadOk:
    Delete "$INSTDIR\resources\payload.tar"
  donePayload:
!macroend
