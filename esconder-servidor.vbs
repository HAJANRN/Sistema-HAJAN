' Deixa o servidor no ar sem janela, desde que o Windows iniciar este usuário.
Dim shell, pasta
Set shell = CreateObject("WScript.Shell")
pasta = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & pasta & "\servidor.cmd" & """", 0, False
