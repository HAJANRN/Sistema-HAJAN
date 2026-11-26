using System.Diagnostics;

var packageDirectory = AppContext.BaseDirectory;
var acompanhamentoDirectory = Path.GetFullPath(
    Path.Combine(packageDirectory, "..", "Acompanhamento de entregas")
);
var batchPath = Path.Combine(acompanhamentoDirectory, "iniciar.cmd");

if (!File.Exists(batchPath))
{
    Console.Error.WriteLine(
        "Arquivo Acompanhamento de entregas\\iniciar.cmd não encontrado. " +
        "Mantenha as pastas Acompanhamento de entregas e HAJAN-Emissor-Local - V6 juntas."
    );
    Console.WriteLine("Pressione uma tecla para fechar.");
    Console.ReadKey();
    return 1;
}

var startInfo = new ProcessStartInfo
{
    FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
    Arguments = $"/c \"\"{batchPath}\"\"",
    WorkingDirectory = acompanhamentoDirectory,
    UseShellExecute = true
};

using var process = Process.Start(startInfo);
if (process is null)
{
    Console.Error.WriteLine("Não foi possível iniciar os sistemas HAJAN.");
    Console.WriteLine("Pressione uma tecla para fechar.");
    Console.ReadKey();
    return 1;
}

process.WaitForExit();
return process.ExitCode;