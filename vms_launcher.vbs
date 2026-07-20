Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Resolve absolute directory path of the launcher
strScriptPath = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
' Set working directory explicitly to installation folder
WshShell.CurrentDirectory = strScriptPath

' Start node.exe index.js in background with hidden window (0)
WshShell.Run Chr(34) & strScriptPath & "node.exe" & Chr(34) & " index.js", 0, False
' Allow 3 seconds for server startup before opening browser
WScript.Sleep 3000

' Check standard Google Chrome installation paths
chrome64 = WshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"
chrome86 = WshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe"
chromeUser = WshShell.ExpandEnvironmentStrings("%LocalAppData%") & "\Google\Chrome\Application\chrome.exe"

targetUrl = "http://localhost:3000"

If fso.FileExists(chrome64) Then
    WshShell.Run Chr(34) & chrome64 & Chr(34) & " " & targetUrl
ElseIf fso.FileExists(chrome86) Then
    WshShell.Run Chr(34) & chrome86 & Chr(34) & " " & targetUrl
ElseIf fso.FileExists(chromeUser) Then
    WshShell.Run Chr(34) & chromeUser & Chr(34) & " " & targetUrl
Else
    ' Fallback to system default browser if Chrome is not found
    WshShell.Run targetUrl
End If
