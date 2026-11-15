using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
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
            string executable, root, profile, project;
            ParseArguments(args, out executable, out root, out profile, out project);
            string serviceFile = Path.Combine(root, "vokri", "hosts", "cevra", "service.cjs");
            if (!File.Exists(executable)) throw new FileNotFoundException("The VOKRI Code Node.js runtime is missing.");
            if (!File.Exists(serviceFile)) throw new FileNotFoundException("The VOKRI Code workspace service is missing.");
            Directory.CreateDirectory(profile);
            profile = ProfilePath(profile);
            string identity;
            using (var sha = SHA256.Create())
                identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(profile.ToLowerInvariant()))).Replace("-", "");
            using (var mutex = new Mutex(false, "Local\\Vokri.CEVRA." + identity))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new InvalidOperationException("This VOKRI Code profile is already open.");
                try
                {
                    using (var application = new Application())
                    using (var service = new ServiceClient(executable, new[] { serviceFile, profile }, root,
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
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            MessageBoxW(IntPtr.Zero, error.Message, Title, 0x10);
            return 1;
        }
    }

    private static void ParseArguments(string[] args, out string executable, out string root, out string profile, out string project)
    {
#if VOKRI_PRODUCT
        root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        executable = Path.Combine(root, "runtime", "node.exe");
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(localAppData)) throw new InvalidOperationException("The Windows local app-data directory is unavailable.");
        profile = Path.Combine(localAppData, "VOKRI Code", "Native");
        project = null;
        bool customProfile = false;
        foreach (string arg in args)
        {
            const string option = "--user-data-dir=";
            if (!customProfile && arg.StartsWith(option, StringComparison.Ordinal))
            {
                profile = ProfilePath(arg.Substring(option.Length));
                customProfile = true;
            }
            else if (project == null && !string.IsNullOrWhiteSpace(arg) && !arg.StartsWith("-", StringComparison.Ordinal))
                project = Path.GetFullPath(arg);
            else throw new ArgumentException("Launch VokriCode.exe [project folder] [--user-data-dir=<absolute folder>].");
        }
#else
        if ((args.Length != 3 && args.Length != 4) || !Path.IsPathRooted(args[0]) ||
            !Path.IsPathRooted(args[1]) || !Path.IsPathRooted(args[2]))
            throw new ArgumentException("Launch the native workbench with npm run start:vokri.");
        executable = args[0];
        root = Path.GetFullPath(args[1]);
        profile = ProfilePath(args[2]);
        project = args.Length == 4 ? args[3] : null;
#endif
    }

    private static string ProfilePath(string directory)
    {
        if (directory.Length < 4 || directory[1] != ':' || (directory[2] != '\\' && directory[2] != '/'))
            throw new ArgumentException("Use an absolute profile folder on a local drive.");
        string full = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (full.Length < 4) throw new ArgumentException("Choose a profile folder inside the drive.");
        return full;
    }
}
