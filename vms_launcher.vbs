Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Resolve absolute directory path of the launcher
strScriptPath = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
WshShell.CurrentDirectory = strScriptPath

' Start node.exe index.js in background with hidden window (0)
WshShell.Run Chr(34) & strScriptPath & "node.exe" & Chr(34) & " index.js", 0, False

targetUrl = "http://localhost:3000"

' Poll localhost:3000 until web server is online and listening (up to 15 seconds)
For i = 1 To 15
    WScript.Sleep 1000
    On Error Resume Next
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", targetUrl, False
    http.Send
    If Err.Number = 0 Then
        If http.Status = 200 Or http.Status = 403 Or http.Status = 302 Then
            Exit For
        End If
    End If
    On Error GoTo 0
Next

' Check Chrome and Edge browser executable paths
chrome64 = WshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"
chrome86 = WshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe"
chromeUser = WshShell.ExpandEnvironmentStrings("%LocalAppData%") & "\Google\Chrome\Application\chrome.exe"
edgePath = WshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"

If fso.FileExists(chrome64) Then
    WshShell.Run Chr(34) & chrome64 & Chr(34) & " " & targetUrl
ElseIf fso.FileExists(chrome86) Then
    WshShell.Run Chr(34) & chrome86 & Chr(34) & " " & targetUrl
ElseIf fso.FileExists(chromeUser) Then
    WshShell.Run Chr(34) & chromeUser & Chr(34) & " " & targetUrl
ElseIf fso.FileExists(edgePath) Then
    WshShell.Run Chr(34) & edgePath & Chr(34) & " " & targetUrl
Else
    WshShell.Run targetUrl
End If
