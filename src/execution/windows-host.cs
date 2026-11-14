using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static partial class WindowsHost
{
    private const uint KillOnJobClose = 0x2000;
    private const uint ExtendedStartupInfo = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint UseStandardHandles = 0x100;
    private const int ExtendedLimitInformation = 9;
    private const int BasicAccountingInformation = 1;
    private const uint HandleList = 0x20002;
    private const uint JobList = 0x2000d;
    private const uint Synchronize = 0x00100000;

    public static int Main(string[] args)
    {
        try
        {
            uint ownerId;
            if (args.Length < 2 || !uint.TryParse(args[0], out ownerId))
                throw new ArgumentException("An execution owner PID is required.");
            var owner = OpenProcess(Synchronize, false, ownerId);
            Require(owner != IntPtr.Zero, "Open execution owner");
            try { return args[1] == "--terminal" ? RunTerminal(args, owner) : Run(args, owner); }
            finally { CloseHandle(owner); }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("VOKRI Code process host: " + error.Message);
            return 125;
        }
    }

    private static int Run(string[] args, IntPtr owner)
    {
        using (var cancel = new ManualResetEvent(false))
        {
            var listener = new Thread(delegate()
            {
                // Stop closes the control stream. The owner handle also detects sudden exit.
                try { Console.In.Read(); }
                catch (IOException) {}
                try { cancel.Set(); }
                catch (ObjectDisposedException) {}
            });
            listener.IsBackground = true;
            listener.Start();

            var job = CreateTrackedJob();
            try
            {
                if (cancel.WaitOne(0) || OwnerExited(owner)) return 1;
                return WaitForProcess(owner, cancel, job, Launch(args, 1, job, IntPtr.Zero, null));
            }
            finally { CloseHandle(job); }
        }
    }

    private static IntPtr CreateTrackedJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        Require(job != IntPtr.Zero, "CreateJobObject");
        try
        {
            var limits = new JobLimits();
            limits.Basic.LimitFlags = KillOnJobClose;
            Require(SetInformationJobObject(job, ExtendedLimitInformation, ref limits,
                Marshal.SizeOf(typeof(JobLimits))), "SetInformationJobObject");
            return job;
        }
        catch { CloseHandle(job); throw; }
    }

    private static bool OwnerExited(IntPtr owner)
    {
        uint state = WaitForSingleObject(owner, 0);
        Require(state == 0 || state == 258, "Check execution owner");
        return state == 0;
    }

    private static int WaitForProcess(IntPtr owner, ManualResetEvent cancel, IntPtr job, ProcessInfo process)
    {
        try
        {
            var handles = new[] { owner, cancel.SafeWaitHandle.DangerousGetHandle(), process.Process };
            uint result = WaitForMultipleObjects((uint)handles.Length, handles, false, uint.MaxValue);
            Require(result <= 2, "WaitForMultipleObjects");
            uint exitCode = 1;
            if (result == 2)
                Require(GetExitCodeProcess(process.Process, out exitCode), "GetExitCodeProcess");
            DrainJob(job);
            return unchecked((int)exitCode);
        }
        finally { CloseHandle(process.Process); }
    }

    private static ProcessInfo Launch(string[] args, int executable, IntPtr job, IntPtr pseudoConsole,
        string cwd, string commandTail = null)
    {
        if (!Path.IsPathRooted(args[executable])) throw new ArgumentException("An absolute executable path is required.");
        bool redirected = pseudoConsole == IntPtr.Zero;
        var security = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero, attributes = IntPtr.Zero;
        GCHandle handles = default(GCHandle), jobs = default(GCHandle);
        bool initialized = false;
        try
        {
            if (redirected)
            {
                input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
                Require(input != new IntPtr(-1), "Open NUL");
                output = InheritableStandardHandle(-11);
                error = InheritableStandardHandle(-12);
                handles = GCHandle.Alloc(new[] { input, output, error }, GCHandleType.Pinned);
            }
            jobs = GCHandle.Alloc(new[] { job }, GCHandleType.Pinned);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            Require(size != IntPtr.Zero, "Size process attributes");
            attributes = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "Initialize process attributes");
            initialized = true;
            if (redirected) AddAttribute(attributes, HandleList, handles, 3);
            else Require(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(PseudoConsoleAttribute), pseudoConsole,
                new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Attach pseudoconsole");
            AddAttribute(attributes, JobList, jobs, 1);

            var startup = new StartupInfoEx { Attributes = attributes };
            startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Flags = UseStandardHandles;
            startup.Startup.Input = input;
            startup.Startup.Output = output;
            startup.Startup.Error = error;
            var command = new StringBuilder();
            AppendArgument(command, args[executable]);
            if (commandTail != null) command.Append(' ').Append(commandTail);
            else for (int index = executable + 1; index < args.Length; index++)
            {
                command.Append(' ');
                AppendArgument(command, args[index]);
            }
            ProcessInfo process;
            Require(CreateProcess(args[executable], command, IntPtr.Zero, IntPtr.Zero, redirected,
                ExtendedStartupInfo | (redirected ? CreateNoWindow : 0), IntPtr.Zero, cwd, ref startup, out process), "CreateProcess");
            CloseHandle(process.Thread);
            return process;
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles.IsAllocated) handles.Free();
            if (jobs.IsAllocated) jobs.Free();
            if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
        }
    }

    private static void DrainJob(IntPtr job)
    {
        JobAccounting accounting;
        Require(QueryInformationJobObject(job, BasicAccountingInformation, out accounting,
            Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero), "Read job accounting");
        if (accounting.ActiveProcesses == 0) return;
        Require(TerminateJobObject(job, 1), "Terminate process tree");
        var elapsed = Stopwatch.StartNew();
        do
        {
            Require(QueryInformationJobObject(job, BasicAccountingInformation, out accounting,
                Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero), "Check process tree");
            if (accounting.ActiveProcesses == 0) return;
            Thread.Sleep(10);
        } while (elapsed.ElapsedMilliseconds < 5000);
        throw new IOException("The process tree did not finish cleanup within five seconds.");
    }

    private static IntPtr InheritableStandardHandle(int number)
    {
        IntPtr duplicate, process = GetCurrentProcess();
        Require(DuplicateHandle(process, GetStdHandle(number), process, out duplicate, 0, true, 2),
            "Duplicate standard stream");
        return duplicate;
    }

    private static void AddAttribute(IntPtr list, uint attribute, GCHandle value, int count)
    {
        Require(UpdateProcThreadAttribute(list, 0, new UIntPtr(attribute), value.AddrOfPinnedObject(),
            new UIntPtr((uint)(IntPtr.Size * count)), IntPtr.Zero, IntPtr.Zero), "Set process attributes");
    }

    private static void AppendArgument(StringBuilder command, string value)
    {
        command.Append('"');
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            command.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            command.Append(character);
            slashes = 0;
        }
        command.Append('\\', slashes * 2);
        command.Append('"');
    }

    private static void Require(bool success, string operation)
    {
        if (!success)
        {
            int code = Marshal.GetLastWin32Error();
            throw new Win32Exception(code, operation + " failed (" + code + "). " + new Win32Exception(code).Message);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Size; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobAccounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out JobAccounting info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFile(string file, uint access, uint share, ref SecurityAttributes security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value,
        UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string file, StringBuilder args, IntPtr processSecurity, IntPtr threadSecurity,
        bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
