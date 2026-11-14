Option Explicit
' Double-click launcher for Windows: starts RTM without a console window.
Dim shell, fso, rootDir, logDir, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = fso.BuildPath(rootDir, ".agent-hub")
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
shell.CurrentDirectory = rootDir
cmd = "cmd /c node node_modules\tsx\dist\cli.mjs src\index.ts desktop" & _
      " 1> "".agent-hub\desktop.stdout.log"" 2> "".agent-hub\desktop.stderr.log"""
shell.Run cmd, 0, False
