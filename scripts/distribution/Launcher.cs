using System;
using System.IO;
using System.Diagnostics;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Text.RegularExpressions;
using System.Text;
using System.Threading.Tasks;

class TaboraLauncher {
    static async Task Pump(Stream source, Stream destination) {
        byte[] buffer = new byte[32768]; int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) > 0) {
            await destination.WriteAsync(buffer, 0, count);
            await destination.FlushAsync();
        }
    }
    static async Task Input(Process child) {
        try { await Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
        catch { }
        finally { try { child.StandardInput.Close(); } catch { } }
    }
    static string Quote(string value) {
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') text.Append('\\', slashes * 2 + 1);
            else text.Append('\\', slashes);
            text.Append(c); slashes = 0;
        }
        text.Append('\\', slashes * 2); text.Append('"'); return text.ToString();
    }
    static int Main(string[] args) {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string version = root;
            string configuration = Path.Combine(root, "installation.json");
            var start = new ProcessStartInfo();
            if (File.Exists(configuration)) {
                var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configuration));
                string current = (string)config["current"];
                if (!Regex.IsMatch(current, @"^\d+\.\d+\.\d+-[a-f0-9]{16}$")) throw new Exception("invalid_installation");
                version = Path.Combine(root, "versions", current);
                start.EnvironmentVariables["TABORA_INSTALL_ROOT"] = root;
                start.EnvironmentVariables["TABORA_STATE_DIR"] = (string)config["stateDir"];
            }
            start.FileName = Path.Combine(version, "runtime", "node.exe");
            start.Arguments = Quote(Path.Combine(version, "scripts", "cli.mjs"));
            foreach (string arg in args) start.Arguments += " " + Quote(arg);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (var process = Process.Start(start)) {
                Task input = Input(process);
                Task output = Pump(process.StandardOutput.BaseStream, Console.OpenStandardOutput());
                Task errors = Pump(process.StandardError.BaseStream, Console.OpenStandardError());
                process.WaitForExit(); Task.WaitAll(output, errors); return process.ExitCode;
            }
        } catch { Console.Error.WriteLine("Tabora launcher failed. Run the installer repair or check installation.json."); return 1; }
    }
}
