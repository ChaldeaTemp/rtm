Option Explicit
Dim shell, fso, rootDir, psScript, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = fso.BuildPath(rootDir, "scripts\desktop-launcher.ps1")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Sta -File """ & psScript & """"
shell.Run cmd, 0, False
