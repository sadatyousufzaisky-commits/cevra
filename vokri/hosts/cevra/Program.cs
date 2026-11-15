using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Vokri;

internal static class Program
{
#if VOKRI_PRODUCT
    private const string Title = "VOKRI Code";
#else
    private const string Title = "VOKRI Code · Native Preview";
#endif

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBoxW(IntPtr owner, string text, string title, uint flags);

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string executable, root, project;
            string[] profileArgs = ParseArguments(args, out executable, out root, out project);
            string serviceFile = Path.Combine(root, "vokri", "hosts", "cevra", "service.cjs");
            if (!File.Exists(executable)) throw new FileNotFoundException("The VOKRI Code Node.js runtime is missing.");
            if (!File.Exists(serviceFile)) throw new FileNotFoundException("The VOKRI Code workspace service is missing.");
            var serviceArgs = new List<string> { serviceFile };
            serviceArgs.AddRange(profileArgs);
            using (var application = new Application())
            using (var service = new ServiceClient(executable, serviceArgs, root,
                new Dictionary<string, string> {
                    { "NODE_OPTIONS", null }, { "NODE_PATH", null }, { "NODE_TEST_CONTEXT", null },
                    { "ELECTRON_RUN_AS_NODE", null }
                }))
            using (var workbench = new Workbench(application, service, Title))
            {
                workbench.Show(project);
                return application.Run();
            }
        }
        catch (Exception error)
        {
            MessageBoxW(IntPtr.Zero, error.Message, Title, 0x10);
            return 1;
        }
    }

    private static string[] ParseArguments(string[] args, out string executable, out string root, out string project)
    {
#if VOKRI_PRODUCT
        root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        executable = Path.Combine(root, "runtime", "node.exe");
        var roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (string.IsNullOrEmpty(roaming)) throw new InvalidOperationException("The Windows roaming app-data directory is unavailable.");
        string profile = null;
        project = null;
        foreach (string arg in args)
        {
            const string option = "--user-data-dir=";
            if (profile == null && arg.StartsWith(option, StringComparison.Ordinal))
                profile = arg.Substring(option.Length);
            else if (project == null && !string.IsNullOrWhiteSpace(arg) && !arg.StartsWith("-", StringComparison.Ordinal))
                project = Path.GetFullPath(arg);
            else throw new ArgumentException("Launch VokriCode.exe [project folder] [--user-data-dir=<absolute folder>].");
        }
        return profile == null ? new[] { "--roaming-profile", roaming } : new[] { "--roaming-profile", roaming, profile };
#else
        if ((args.Length != 3 && args.Length != 4) || !Path.IsPathRooted(args[0]) ||
            !Path.IsPathRooted(args[1]) || !Path.IsPathRooted(args[2]))
            throw new ArgumentException("Launch the native workbench with npm run start:vokri.");
        executable = args[0];
        root = Path.GetFullPath(args[1]);
        project = args.Length == 4 ? args[3] : null;
        return new[] { args[2] };
#endif
    }
}
