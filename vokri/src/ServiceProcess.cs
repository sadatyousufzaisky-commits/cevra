using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Vokri
{
    internal sealed class ServiceProcess : IDisposable
    {
        private const uint ExtendedStartupInfo = 0x00080000;
        private const uint CreateNoWindow = 0x08000000;
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const int UseStandardHandles = 0x100;
        private const uint HandleList = 0x20002;
        private const uint JobList = 0x2000d;
        private const uint KillOnJobClose = 0x2000;
        private const int ExtendedLimitInformation = 9;
        private readonly SafeFileHandle job;
        internal readonly Stream Input, Output, Error;

        private ServiceProcess(SafeFileHandle job, Stream input, Stream output, Stream error)
        {
            this.job = job;
            Input = input;
            Output = output;
            Error = error;
        }

        internal static ServiceProcess Start(string executable, IEnumerable<string> arguments, string workingDirectory,
            IDictionary<string, string> environment)
        {
            if (arguments == null) throw new ArgumentNullException("arguments");
            var command = new StringBuilder();
            AppendArgument(command, executable);
            foreach (var argument in arguments)
            {
                command.Append(' ');
                AppendArgument(command, argument);
            }
            using (var childInput = new Pipe(true))
            using (var childOutput = new Pipe(false))
            using (var childError = new Pipe(false))
            {
                var job = new SafeFileHandle(Native.Require(CreateJobObjectW(IntPtr.Zero, null)), true);
                IntPtr list = IntPtr.Zero, block = IntPtr.Zero;
                bool initialized = false;
                GCHandle handles = default(GCHandle), jobs = default(GCHandle);
                Stream input = null, output = null, error = null;
                try
                {
                    var limits = new JobLimits { Basic = new BasicLimits { Flags = KillOnJobClose } };
                    Require(SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JobLimits))));
                    var inherited = new[] { childInput.Child, childOutput.Child, childError.Child };
                    handles = GCHandle.Alloc(inherited, GCHandleType.Pinned);
                    jobs = GCHandle.Alloc(new[] { job.DangerousGetHandle() }, GCHandleType.Pinned);
                    IntPtr bytes = IntPtr.Zero;
                    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
                    list = Marshal.AllocHGlobal(Native.Require(bytes));
                    Require(InitializeProcThreadAttributeList(list, 2, 0, ref bytes));
                    initialized = true;
                    SetAttribute(list, HandleList, handles, inherited.Length);
                    SetAttribute(list, JobList, jobs, 1);
                    var startup = new StartupEx { Attributes = list, Startup = new StartupInfo {
                        Size = Marshal.SizeOf(typeof(StartupEx)), Flags = UseStandardHandles,
                        Input = inherited[0], Output = inherited[1], Error = inherited[2]
                    } };
                    block = EnvironmentBlock(environment);
                    ProcessInfo process;
                    Require(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                        ExtendedStartupInfo | CreateNoWindow | CreateUnicodeEnvironment, block, workingDirectory, ref startup, out process));
                    CloseHandle(process.Thread);
                    CloseHandle(process.Process);
                    input = childInput.TakeParent(FileAccess.Write);
                    output = childOutput.TakeParent(FileAccess.Read);
                    error = childError.TakeParent(FileAccess.Read);
                    return new ServiceProcess(job, input, output, error);
                }
                catch
                {
                    job.Dispose();
                    CloseStream(input);
                    CloseStream(output);
                    CloseStream(error);
                    throw;
                }
                finally
                {
                    if (initialized) DeleteProcThreadAttributeList(list);
                    Marshal.FreeHGlobal(list);
                    Marshal.FreeHGlobal(block);
                    if (handles.IsAllocated) handles.Free();
                    if (jobs.IsAllocated) jobs.Free();
                }
            }
        }

        private static void AppendArgument(StringBuilder command, string value)
        {
            if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid service argument.");
            command.Append('"');
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                command.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
                command.Append(character);
                slashes = 0;
            }
            command.Append('\\', slashes * 2).Append('"');
        }

        private static IntPtr EnvironmentBlock(IDictionary<string, string> changes)
        {
            if (changes == null || changes.Count == 0) return IntPtr.Zero;
            var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
                values[(string)entry.Key] = (string)entry.Value;
            foreach (var entry in changes)
            {
                if (string.IsNullOrEmpty(entry.Key) || entry.Key.IndexOfAny(new[] { '=', '\0' }) >= 0 ||
                    (entry.Value != null && entry.Value.IndexOf('\0') >= 0))
                    throw new ArgumentException("Invalid service environment.");
                if (entry.Value == null) values.Remove(entry.Key);
                else values[entry.Key] = entry.Value;
            }
            var block = new StringBuilder();
            foreach (var entry in values) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
            if (block.Length == 0) block.Append('\0');
            return Marshal.StringToHGlobalUni(block.ToString());
        }

        private static void SetAttribute(IntPtr list, uint key, GCHandle value, int count)
        {
            Require(UpdateProcThreadAttribute(list, 0, new UIntPtr(key), value.AddrOfPinnedObject(),
                new UIntPtr((uint)(IntPtr.Size * count)), IntPtr.Zero, IntPtr.Zero));
        }

        private sealed class Pipe : IDisposable
        {
            private SafeFileHandle parent, child;
            internal IntPtr Child { get { return child.DangerousGetHandle(); } }
            internal Pipe(bool childReads)
            {
                var security = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
                SafeFileHandle read, write;
                Require(CreatePipe(out read, out write, ref security, 0));
                parent = childReads ? write : read;
                child = childReads ? read : write;
                try { Require(SetHandleInformation(parent, 1, 0)); }
                catch { Dispose(); throw; }
            }
            internal Stream TakeParent(FileAccess access)
            {
                var stream = new FileStream(parent, access, 4096, false);
                parent = null;
                return stream;
            }
            public void Dispose()
            {
                if (parent != null) parent.Dispose();
                child.Dispose();
            }
        }

        private static void Require(bool success)
        {
            if (!success) throw new System.ComponentModel.Win32Exception();
        }
        private static void CloseStream(Stream stream)
        {
            if (stream != null) { try { stream.Dispose(); } catch {} }
        }
        public void Dispose()
        {
            job.Dispose();
            CloseStream(Input);
            CloseStream(Output);
            CloseStream(Error);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            internal int Size;
            internal IntPtr Descriptor;
            [MarshalAs(UnmanagedType.Bool)] internal bool Inherit;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfo
        {
            internal int Size;
            internal IntPtr Reserved, Desktop, Title;
            internal int X, Y, Width, Height, XChars, YChars, Fill, Flags;
            internal short ShowWindow, ReservedSize;
            internal IntPtr ReservedData, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct StartupEx { internal StartupInfo Startup; internal IntPtr Attributes; }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInfo { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            internal long ProcessTime, JobTime;
            internal uint Flags;
            internal UIntPtr Minimum, Maximum;
            internal uint Active;
            internal UIntPtr Affinity;
            internal uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct Counters { internal ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)]
        private struct JobLimits
        {
            internal BasicLimits Basic;
            internal Counters Io;
            internal UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(SafeFileHandle job, int type, ref JobLimits info, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SecurityAttributes attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr key, IntPtr value,
            UIntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern bool CreateProcessW(string file, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup,
            out ProcessInfo process);
    }
}
