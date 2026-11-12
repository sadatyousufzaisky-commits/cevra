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
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBoxW(IntPtr owner, string text, string title, uint flags);

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if ((args.Length != 3 && args.Length != 4) || !Path.IsPathRooted(args[0]) ||
                !Path.IsPathRooted(args[1]) || !Path.IsPathRooted(args[2]))
                throw new ArgumentException("Launch the native workbench with npm run start:vokri.");
            string root = Path.GetFullPath(args[1]);
            string profile = Path.GetFullPath(args[2]).TrimEnd(Path.DirectorySeparatorChar);
            string serviceFile = Path.Combine(root, "vokri", "hosts", "cevra", "service.cjs");
            if (!File.Exists(serviceFile)) throw new FileNotFoundException("The CEVRA workspace service is missing.");
            Directory.CreateDirectory(profile);
            string identity;
            using (var sha = SHA256.Create())
                identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(profile.ToLowerInvariant()))).Replace("-", "");
            using (var mutex = new Mutex(false, "Local\\Vokri.CEVRA." + identity))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new InvalidOperationException("This native CEVRA profile is already open.");
                try
                {
                    using (var application = new Application())
                    using (var service = new ServiceClient(args[0], new[] { serviceFile, profile }, root,
                        new Dictionary<string, string> {
                            { "NODE_OPTIONS", null }, { "NODE_PATH", null }, { "NODE_TEST_CONTEXT", null },
                            { "ELECTRON_RUN_AS_NODE", null }
                        }))
                    using (var workbench = new Workbench(application, service))
                    {
                        workbench.Show(args.Length == 4 ? args[3] : null);
                        return application.Run();
                    }
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            MessageBoxW(IntPtr.Zero, error.Message, "CEVRA · Vokri", 0x10);
            return 1;
        }
    }
}
