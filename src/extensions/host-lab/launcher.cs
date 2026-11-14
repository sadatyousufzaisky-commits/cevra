using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class ExtensionLabLauncher
{
    public static int Main(string[] args)
    {
        try { return WindowsHost.RunExtensionLab(args); }
        catch (Exception error)
        {
            Console.Error.WriteLine("VOKRI Code isolation lab: " + error.Message);
            return 125;
        }
    }
}

internal static partial class WindowsHost
{
    private const uint SecurityCapabilitiesAttribute = 0x20009;
    private const uint ChildProcessPolicy = 0x2000e;
    private const uint AllApplicationPackagesPolicy = 0x2000f;
    private const uint UnicodeEnvironment = 0x400;
    private const uint CreateSuspended = 4;
    private const uint DetachedProcess = 8;
    private const uint ExtensionUiLimits = 0xff;

    private sealed class ExtensionAttributes : IDisposable
    {
        private readonly List<IntPtr> values = new List<IntPtr>();
        public readonly IntPtr List;

        public ExtensionAttributes(int count)
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size);
            Require(size != IntPtr.Zero, "Size extension attributes");
            List = Marshal.AllocHGlobal(size);
            try { Require(InitializeProcThreadAttributeList(List, count, 0, ref size), "Initialize extension attributes"); }
            catch { Marshal.FreeHGlobal(List); throw; }
        }

        public void Add(uint attribute, int size, Action<IntPtr> write)
        {
            var value = Marshal.AllocHGlobal(size);
            values.Add(value);
            write(value);
            Require(UpdateProcThreadAttribute(List, 0, new UIntPtr(attribute), value, new UIntPtr((uint)size),
                IntPtr.Zero, IntPtr.Zero), "Set extension attribute " + attribute);
        }

        public void Dispose()
        {
            DeleteProcThreadAttributeList(List);
            foreach (var value in values) Marshal.FreeHGlobal(value);
            Marshal.FreeHGlobal(List);
        }
    }

    public static int RunExtensionLab(string[] args)
    {
        uint ownerId;
        if (args.Length != 4 || !uint.TryParse(args[0], out ownerId) ||
            (args[3] != "worker" && args[3] != "probe"))
            throw new ArgumentException("Expected an owner, trusted build folder, scratch directory and lab mode.");
        var owner = OpenProcess(Synchronize, false, ownerId);
        Require(owner != IntPtr.Zero, "Open lab owner");
        var profile = "Cevra.ExtensionLab." + Guid.NewGuid().ToString("N");
        var stage = Path.Combine(Path.GetFullPath(args[2]), profile);
        var workerName = "extension-" + args[3] + ".exe";
        var executable = Path.Combine(stage, workerName);
        var runtime = Path.Combine(stage, "wasmtime.dll");
        var canary = Path.Combine(stage, "ordinary-app-container.txt");
        IntPtr sid = IntPtr.Zero;
        try
        {
            Marshal.ThrowExceptionForHR(CreateAppContainerProfile(profile, "VOKRI Code Isolation Lab",
                "Temporary VOKRI Code extension host", IntPtr.Zero, 0, out sid));
            Directory.CreateDirectory(stage);
            var identity = new SecurityIdentifier(sid);
            var directoryAcl = Directory.GetAccessControl(stage);
            directoryAcl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
            Directory.SetAccessControl(stage, directoryAcl);
            CopyExtensionArtifact(Path.Combine(args[1], workerName), executable, identity);
            if (args[3] == "worker") CopyExtensionArtifact(Path.Combine(args[1], "wasmtime.dll"), runtime, identity);
            File.WriteAllText(canary, "VOKRI Code LPAC access check");
            var canaryAcl = new FileSecurity();
            canaryAcl.SetAccessRuleProtection(true, false);
            using (var user = WindowsIdentity.GetCurrent())
                canaryAcl.AddAccessRule(new FileSystemAccessRule(user.User, FileSystemRights.FullControl, AccessControlType.Allow));
            canaryAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-15-2-1"),
                FileSystemRights.ReadAndExecute, AccessControlType.Allow));
            File.SetAccessControl(canary, canaryAcl);
            return SuperviseExtension(owner, sid, executable, stage, canary);
        }
        finally
        {
            CloseHandle(owner);
            try
            {
                DeleteExtensionArtifact(executable);
                DeleteExtensionArtifact(runtime);
                DeleteExtensionArtifact(canary);
                if (Directory.Exists(stage)) Directory.Delete(stage);
            }
            finally
            {
                if (sid != IntPtr.Zero)
                {
                    FreeSid(sid);
                    Marshal.ThrowExceptionForHR(DeleteAppContainerProfile(profile));
                }
            }
        }
    }

    private static void DeleteExtensionArtifact(string file)
    {
        for (int attempt = 0; ; attempt++)
        {
            try { File.Delete(file); return; }
            catch (IOException) { if (attempt == 19) throw; }
            catch (UnauthorizedAccessException) { if (attempt == 19) throw; }
            Thread.Sleep(25);
        }
    }

    private static void CopyExtensionArtifact(string source, string target, SecurityIdentifier identity)
    {
        File.Copy(source, target);
        var acl = File.GetAccessControl(target);
        acl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        File.SetAccessControl(target, acl);
    }

    private static int SuperviseExtension(IntPtr owner, IntPtr sid, string executable, string stage, string canary)
    {
        using (var cancel = new ManualResetEvent(false))
        {
            var job = CreateTrackedJob();
            try
            {
                var limits = new JobLimits();
                limits.Basic.LimitFlags = KillOnJobClose | 0x8 | 0x100;
                limits.Basic.ProcessLimit = 1;
                limits.ProcessMemory = new UIntPtr(256 * 1024 * 1024);
                Require(SetInformationJobObject(job, ExtendedLimitInformation, ref limits,
                    Marshal.SizeOf(typeof(JobLimits))), "Limit extension job");
                uint uiLimits = ExtensionUiLimits;
                Require(SetExtensionUiLimits(job, 4, ref uiLimits, sizeof(uint)), "Restrict extension UI access");
                if (OwnerExited(owner)) return 1;
                IntPtr read, write;
                var security = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
                Require(CreatePipe(out read, out write, ref security, 0), "Create extension input pipe");
                using (var pipe = new SafeFileHandle(write, true))
                {
                    ProcessInfo process;
                    try
                    {
                        Require(SetHandleInformation(write, 1, 0), "Protect extension input writer");
                        process = LaunchExtension(job, sid, executable, stage, canary, read);
                    }
                    finally { CloseHandle(read); }
                    var pump = new Thread(delegate()
                    {
                        try
                        {
                            using (var input = Console.OpenStandardInput())
                            using (var output = new FileStream(pipe, FileAccess.Write))
                            {
                                var buffer = new byte[4096];
                                int count;
                                while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
                                {
                                    output.Write(buffer, 0, count);
                                    output.Flush();
                                }
                            }
                        }
                        catch (IOException) {}
                        catch (ObjectDisposedException) {}
                        finally { try { cancel.Set(); } catch (ObjectDisposedException) {} }
                    });
                    pump.IsBackground = true;
                    pump.Start();
                    return WaitForProcess(owner, cancel, job, process);
                }
            }
            finally { CloseHandle(job); }
        }
    }

    private static ProcessInfo LaunchExtension(IntPtr job, IntPtr sid, string executable, string stage, string canary, IntPtr input)
    {
        IntPtr output = IntPtr.Zero, error = IntPtr.Zero, environment = IntPtr.Zero;
        try
        {
            output = InheritableStandardHandle(-11);
            error = InheritableStandardHandle(-12);
            var root = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            environment = Marshal.StringToHGlobalUni("LOCALAPPDATA=" + local +
                "\0SystemDrive=" + Path.GetPathRoot(root).TrimEnd('\\') + "\0SystemRoot=" + root +
                "\0TEMP=" + stage + "\0TMP=" + stage + "\0WINDIR=" + root + "\0\0");
            using (var attributes = new ExtensionAttributes(5))
            {
                attributes.Add(HandleList, IntPtr.Size * 3, p => Marshal.Copy(new[] { input, output, error }, 0, p, 3));
                attributes.Add(JobList, IntPtr.Size, p => Marshal.WriteIntPtr(p, job));
                attributes.Add(SecurityCapabilitiesAttribute, Marshal.SizeOf(typeof(ExtensionSecurityCapabilities)),
                    p => Marshal.StructureToPtr(new ExtensionSecurityCapabilities { Sid = sid }, p, false));
                attributes.Add(AllApplicationPackagesPolicy, 4, p => Marshal.WriteInt32(p, 1));
                attributes.Add(ChildProcessPolicy, 4, p => Marshal.WriteInt32(p, 1));
                var startup = new StartupInfoEx { Attributes = attributes.List };
                startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.Startup.Flags = UseStandardHandles;
                startup.Startup.Input = input;
                startup.Startup.Output = output;
                startup.Startup.Error = error;
                var command = new StringBuilder();
                AppendArgument(command, executable);
                command.Append(" --isolated");
                ProcessInfo process;
                Require(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                    ExtendedStartupInfo | DetachedProcess | CreateSuspended | UnicodeEnvironment,
                    environment, stage, ref startup, out process), "Launch LPAC worker");
                try
                {
                    VerifyExtensionToken(process.Process, job, executable, canary);
                    Require(ResumeThread(process.Thread) == 1, "Resume verified extension worker");
                    return process;
                }
                catch
                {
                    DrainJob(job);
                    CloseHandle(process.Process);
                    throw;
                }
                finally { CloseHandle(process.Thread); }
            }
        }
        finally
        {
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }

    private static void VerifyExtensionToken(IntPtr process, IntPtr job, string executable, string canary)
    {
        bool inJob;
        Require(IsProcessInJob(process, job, out inJob) && inJob, "Verify extension job");
        uint uiLimits;
        Require(QueryExtensionUiLimits(job, 4, out uiLimits, sizeof(uint), IntPtr.Zero) &&
            (uiLimits & ExtensionUiLimits) == ExtensionUiLimits, "Verify extension UI restrictions");
        IntPtr token;
        Require(OpenProcessToken(process, 8 | 2, out token), "Open extension token");
        try
        {
            if (TokenNumber(token, 29) != 1 || TokenNumber(token, 30) != 0)
                throw new InvalidOperationException("Windows did not establish the required zero-capability LPAC token.");
            // Validate the documented access distinction instead of depending on token information class 46.
            IntPtr impersonation;
            Require(DuplicateToken(token, 2, out impersonation), "Duplicate extension token for access check");
            try
            {
                using (WindowsIdentity.Impersonate(impersonation))
                {
                    using (File.OpenRead(executable)) {}
                    try { using (File.OpenRead(canary)) {} }
                    catch (UnauthorizedAccessException) { return; }
                    throw new InvalidOperationException("The worker can read the ordinary AppContainer canary.");
                }
            }
            finally { CloseHandle(impersonation); }
        }
        finally { CloseHandle(token); }
    }

    private static int TokenNumber(IntPtr token, int kind)
    {
        uint size;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out size);
        Require(size >= 4 && size <= 65536, "Size extension token information " + kind);
        var data = Marshal.AllocHGlobal((int)size);
        try
        {
            uint written;
            Require(GetTokenInformation(token, kind, data, size, out written), "Read extension token information " + kind);
            return Marshal.ReadInt32(data);
        }
        finally { Marshal.FreeHGlobal(data); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtensionSecurityCapabilities { public IntPtr Sid, Capabilities; public uint Count, Reserved; }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(string name, string title, string description,
        IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")]
    private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint size, out uint written);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
    private static extern bool SetExtensionUiLimits(IntPtr job, int kind, ref uint restrictions, int size);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    private static extern bool QueryExtensionUiLimits(IntPtr job, int kind, out uint restrictions, int size, IntPtr returned);
}
