; dsh-desktop WSL 版安装脚本 — 独立于 electron-builder 直接编译（免 wine）
; 机器级安装：默认 C:\Program Files\DeepSeek Harness (WSL)，需要管理员授权

Unicode true
ManifestDPIAware true

!define APPNAME "DeepSeek Harness (WSL)"
!define EXENAME "DeepSeek Harness (WSL).exe"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DshDesktopWSL"
!define SRC "/opt/dsh-build/dsh-desktop/release/win-unpacked"

Name "${APPNAME}"
OutFile "/opt/dsh-build/dsh-desktop/release/dsh-desktop-wsl-0.2.1-setup.exe"
InstallDir "$PROGRAMFILES64\DeepSeek Harness (WSL)"
InstallDirRegKey HKLM "${REGKEY}" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

Icon "/opt/dsh-build/dsh-desktop/assets/icon.ico"
UninstallIcon "/opt/dsh-build/dsh-desktop/assets/icon.ico"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
    SetOutPath "$INSTDIR"

    ; 主程序文件树
    File /r "${SRC}\*.*"

    ; 卸载器
    WriteUninstaller "$INSTDIR\Uninstall.exe"

    ; 开始菜单快捷方式
    CreateDirectory "$SMPROGRAMS\${APPNAME}"
    CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${EXENAME}"
    CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"

    ; 桌面快捷方式
    CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXENAME}"

    ; 「应用和功能」注册表项（机器级 → HKLM）
    WriteRegStr HKLM "${REGKEY}" "DisplayName" "${APPNAME}"
    WriteRegStr HKLM "${REGKEY}" "DisplayVersion" "0.2.1"
    WriteRegStr HKLM "${REGKEY}" "Publisher" "luminus-xt"
    WriteRegStr HKLM "${REGKEY}" "DisplayIcon" "$INSTDIR\${EXENAME}"
    WriteRegStr HKLM "${REGKEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
    WriteRegStr HKLM "${REGKEY}" "QuietUninstallString" "$INSTDIR\Uninstall.exe /S"
    WriteRegDWORD HKLM "${REGKEY}" "NoModify" 1
    WriteRegDWORD HKLM "${REGKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
    RMDir /r "$INSTDIR"
    RMDir /r "$SMPROGRAMS\${APPNAME}"
    Delete "$DESKTOP\${APPNAME}.lnk"
    DeleteRegKey HKLM "${REGKEY}"
SectionEnd
