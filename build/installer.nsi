; Fully offline, per-user NSIS installer. The uninstaller is generated on the
; destination machine, so a Linux build does not execute Windows code via Wine.
!include "MUI2.nsh"
!include "x64.nsh"
Name "${PRODUCT_NAME}"
InstallDir "$LOCALAPPDATA\Programs\HLR Writing Tool"
InstallDirRegKey HKCU "Software\HLR Writing Tool" "InstallDir"
RequestExecutionLevel user
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "HLR Writing Tool requires 64-bit Windows."
    Abort
  ${EndIf}
FunctionEnd
Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${PROJECT_DIR}/release/win-unpacked/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\HLR Writing Tool"
  CreateShortcut "$SMPROGRAMS\HLR Writing Tool\HLR Writing Tool.lnk" "$INSTDIR\HLR Writing Tool.exe"
  CreateShortcut "$SMPROGRAMS\HLR Writing Tool\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\HLR Writing Tool" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HLR Writing Tool" "DisplayName" "HLR Writing Tool"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HLR Writing Tool" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HLR Writing Tool" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd
Section "Uninstall"
  ; Remove only shipped files; never recursively delete user-created files.
  !include "${BUILD_RESOURCES_DIR}/uninstall-files.nsh"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\HLR Writing Tool\HLR Writing Tool.lnk"
  Delete "$SMPROGRAMS\HLR Writing Tool\Uninstall.lnk"
  RMDir "$SMPROGRAMS\HLR Writing Tool"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HLR Writing Tool"
  DeleteRegKey HKCU "Software\HLR Writing Tool"
SectionEnd
