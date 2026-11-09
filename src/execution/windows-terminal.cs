using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static partial class WindowsHost
{
    private const uint PseudoConsoleAttribute = 0x20016;
    private const int MaxInputBytes = 16384;

    private static int RunTerminal(string[] args, IntPtr owner)
    {
        short columns, rows;
        if (args.Length < 6 || !short.TryParse(args[2], out columns) || !short.TryParse(args[3], out rows) ||
            !Path.IsPathRooted(args[4])) throw new ArgumentException("Terminal dimensions and an absolute working directory are required.");
        var size = new Coord(columns, rows);
        if (OwnerExited(owner)) return 1;
        var job = CreateTrackedJob();
        IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, console = IntPtr.Zero;
        Thread outputPump = null;
        var consoleGate = new object();
        using (var cancel = new ManualResetEvent(false))
        {
            try
            {
                Require(CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0), "Open terminal input pipe");
                Require(CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0), "Open terminal output pipe");
                Marshal.ThrowExceptionForHR(CreatePseudoConsole(size, inputRead, outputWrite, 0, out console));
                var input = TakeStream(ref inputWrite, FileAccess.Write);
                var output = TakeStream(ref outputRead, FileAccess.Read);
                var queue = new BlockingCollection<byte[]>(8);
                outputPump = StartPump(delegate { DrainTerminal(output, cancel); });
                // CMD interprets /K as a command line. Keep its syntax fixed and expand the path once.
                string commandTail = string.Equals(Path.GetFileName(args[5]), "cmd.exe", StringComparison.OrdinalIgnoreCase)
                    ? "/D /V:OFF /K cd /D \"%CEVRA_TERMINAL_ROOT%\" && set \"CEVRA_TERMINAL_ROOT=\" || exit /b 1" : null;
                var process = Launch(args, 5, job, console, args[4], commandTail);
                Release(ref inputRead);
                Release(ref outputWrite);
                StartPump(delegate { WriteTerminal(input, queue, cancel); });
                StartPump(delegate {
                    ReadTerminalControls(delegate(Coord next)
                    {
                        lock (consoleGate)
                        {
                            if (console != IntPtr.Zero) Marshal.ThrowExceptionForHR(ResizePseudoConsole(console, next));
                        }
                    }, queue, cancel);
                });
                return WaitForProcess(owner, cancel, job, process);
            }
            finally
            {
                CloseHandle(job);
                Release(ref inputRead);
                Release(ref inputWrite);
                Release(ref outputRead);
                Release(ref outputWrite);
                lock (consoleGate)
                {
                    if (console != IntPtr.Zero) ClosePseudoConsole(console);
                    console = IntPtr.Zero;
                }
                if (outputPump != null) outputPump.Join(2000);
            }
        }
    }

    private static void DrainTerminal(Stream output, ManualResetEvent cancel)
    {
        using (output)
        using (var destination = StandardStream(-11, FileAccess.Write))
        {
            var buffer = new byte[16384];
            bool connected = true;
            try
            {
                for (int count; (count = output.Read(buffer, 0, buffer.Length)) > 0;)
                {
                    if (!connected) continue;
                    try { destination.Write(buffer, 0, count); destination.Flush(); }
                    catch (IOException) { connected = false; Signal(cancel); }
                }
            }
            catch (IOException) { Signal(cancel); }
        }
    }

    private static void WriteTerminal(Stream input, BlockingCollection<byte[]> queue, ManualResetEvent cancel)
    {
        using (input)
        {
            try
            {
                foreach (byte[] data in queue.GetConsumingEnumerable())
                {
                    byte[] keys = EncodeTerminalInput(data);
                    input.Write(keys, 0, keys.Length);
                    input.Flush();
                }
            }
            catch (IOException) { Signal(cancel); }
        }
    }

    private static byte[] EncodeTerminalInput(byte[] data)
    {
        if (!Array.Exists(data, value => value >= 128)) return data;
        var input = new StringBuilder();
        foreach (char character in Encoding.UTF8.GetString(data))
        {
            // Win32 input records preserve Unicode characters that have no key in the active layout.
            if (character >= 128) input.Append("\u001b[0;0;").Append((int)character).Append(";1;0;1_");
            else input.Append(character);
        }
        return Encoding.ASCII.GetBytes(input.ToString());
    }

    private static void ReadTerminalControls(Action<Coord> resize, BlockingCollection<byte[]> queue, ManualResetEvent cancel)
    {
        using (var reader = new StreamReader(StandardStream(-10, FileAccess.Read), Encoding.ASCII))
        {
            try
            {
                string command;
                while ((command = ReadControl(reader)) != null)
                {
                    if (command.StartsWith("i:", StringComparison.Ordinal))
                    {
                        byte[] data = Convert.FromBase64String(command.Substring(2));
                        if (data.Length < 1 || data.Length > MaxInputBytes) throw new IOException("Invalid terminal input frame.");
                        if (!queue.TryAdd(data, 1000)) throw new IOException("The shell did not accept terminal input.");
                    }
                    else if (command.StartsWith("r:", StringComparison.Ordinal))
                    {
                        string[] dimensions = command.Substring(2).Split(',');
                        short columns, rows;
                        if (dimensions.Length != 2 || !short.TryParse(dimensions[0], out columns) ||
                            !short.TryParse(dimensions[1], out rows)) throw new IOException("Invalid terminal size.");
                        resize(new Coord(columns, rows));
                    }
                    else throw new IOException("Unknown terminal control frame.");
                }
            }
            catch (Exception error) { Console.Error.WriteLine("CEVRA terminal: " + error.Message); }
            finally { queue.CompleteAdding(); Signal(cancel); }
        }
    }

    private static string ReadControl(StreamReader reader)
    {
        var line = new StringBuilder();
        for (int character; (character = reader.Read()) >= 0;)
        {
            if (character == '\n') return line.ToString();
            if (line.Length >= 22000) throw new IOException("Terminal control frame exceeds its limit.");
            line.Append((char)character);
        }
        return null;
    }

    private static Thread StartPump(ThreadStart action)
    {
        var thread = new Thread(action) { IsBackground = true };
        thread.Start();
        return thread;
    }

    private static void Signal(ManualResetEvent cancel)
    {
        try { cancel.Set(); }
        catch (ObjectDisposedException) {}
    }

    private static FileStream TakeStream(ref IntPtr handle, FileAccess access)
    {
        var stream = new FileStream(new SafeFileHandle(handle, true), access, 4096, false);
        handle = IntPtr.Zero;
        return stream;
    }

    private static FileStream StandardStream(int number, FileAccess access)
    {
        return new FileStream(new SafeFileHandle(GetStdHandle(number), false), access, 4096, false);
    }

    private static void Release(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero) return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Coord
    {
        public short Columns, Rows;
        public Coord(short columns, short rows)
        {
            if (columns < 2 || columns > 500 || rows < 2 || rows > 200)
                throw new ArgumentOutOfRangeException("size", "Terminal size is outside the supported range.");
            Columns = columns;
            Rows = rows;
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
    [DllImport("kernel32.dll")]
    private static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")]
    private static extern int ResizePseudoConsole(IntPtr console, Coord size);
    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr console);
}
