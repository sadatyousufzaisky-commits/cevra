using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class VokriProbe
{
    private delegate bool Enumerate(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll")] private static extern bool EnumWindows(Enumerate callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr root, Enumerate callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out int process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr handle, int id);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr Send(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr Send(IntPtr handle, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static IntPtr Send(IntPtr handle, uint message, int wParam = 0, IntPtr lParam = default(IntPtr))
    {
        IntPtr result;
        Check(Send(handle, message, new IntPtr(wParam), lParam, 2, 1500, out result) != IntPtr.Zero,
            "The desktop window did not respond to message " + message + ".");
        return result;
    }

    private static void Send(IntPtr handle, uint message, int wParam, StringBuilder text)
    {
        IntPtr result;
        Check(Send(handle, message, new IntPtr(wParam), text, 2, 1500, out result) != IntPtr.Zero,
            "The desktop control did not respond to text message " + message + ".");
    }

    private static string ClassName(IntPtr handle)
    {
        var name = new StringBuilder(256);
        GetClassName(handle, name, name.Capacity);
        return name.ToString();
    }

    private static string Caption(IntPtr handle)
    {
        var caption = new StringBuilder(Send(handle, 0x000e).ToInt32() + 2);
        Send(handle, 0x000d, caption.Capacity, caption);
        return caption.ToString();
    }

    private static IntPtr FindWindow(int process, string className, IntPtr owner)
    {
        IntPtr match = IntPtr.Zero;
        EnumWindows((handle, _) =>
        {
            int actualProcess;
            GetWindowThreadProcessId(handle, out actualProcess);
            if (actualProcess != process || ClassName(handle) != className || GetWindow(handle, 4) != owner) return true;
            match = handle;
            return false;
        }, IntPtr.Zero);
        return match;
    }

    private static IntPtr[] Children(IntPtr root, string className)
    {
        var matches = new List<IntPtr>();
        EnumChildWindows(root, (handle, _) =>
        {
            if (string.Equals(ClassName(handle), className, StringComparison.OrdinalIgnoreCase)) matches.Add(handle);
            return true;
        }, IntPtr.Zero);
        return matches.ToArray();
    }

    private static IntPtr WaitFor(Func<IntPtr> find, Func<string> reason)
    {
        var wait = System.Diagnostics.Stopwatch.StartNew();
        do
        {
            IntPtr result = find();
            if (result != IntPtr.Zero) return result;
            Thread.Sleep(45);
        } while (wait.ElapsedMilliseconds < 12000);
        throw new InvalidOperationException(reason());
    }

    private static void Command(IntPtr root, IntPtr control, int notification)
    {
        Check(IsWindowEnabled(control), "The requested control is disabled.");
        Send(root, 0x0111, (GetDlgCtrlID(control) & 0xffff) | notification << 16, control);
    }

    private static void Select(IntPtr root, string name)
    {
        IntPtr list = Children(root, "LISTBOX").First();
        int count = Send(list, 0x018b).ToInt32();
        for (int index = 0; index < count; index++)
        {
            int length = Send(list, 0x018a, index).ToInt32();
            var caption = new StringBuilder(length + 1);
            Send(list, 0x0189, index, caption);
            string item = caption.ToString();
            if (item != name && item != name + "  /") continue;
            Send(list, 0x0186, index);
            Command(root, list, 1);
            return;
        }
        throw new InvalidOperationException("The file list did not contain " + name + ".");
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            int process = int.Parse(args[0]);
            IntPtr root = WaitFor(() => FindWindow(process, "Vokri.Window.1", IntPtr.Zero), () => "Vokri did not open its desktop window.");
            switch (args[1])
            {
                case "wait":
                    WaitFor(() => Children(root, "STATIC").FirstOrDefault(handle => Caption(handle).Contains(args[2])),
                        () => "Expected " + args[2] + ". Actual labels: " + string.Join(" | ", Children(root, "STATIC").Select(Caption)) +
                            ". Output: " + Caption(Children(root, "RichEdit50W")[1]));
                    break;
                case "click":
                    IntPtr button = Children(root, "BUTTON").FirstOrDefault(handle => Caption(handle) == args[2]);
                    Check(button != IntPtr.Zero && IsWindowEnabled(button), "No enabled button named " + args[2] + ".");
                    Check(PostMessage(button, 0x00f5, IntPtr.Zero, IntPtr.Zero), "Unable to click " + args[2] + ".");
                    break;
                case "select":
                    Select(root, args[2]);
                    break;
                case "editor":
                case "output":
                    Console.Write(Caption(Children(root, "RichEdit50W")[args[1] == "editor" ? 0 : 1]));
                    break;
                case "type":
                    IntPtr editor = Children(root, "RichEdit50W").First();
                    Send(editor, 0x00b1, 0, IntPtr.Zero);
                    foreach (char key in args[2]) Send(editor, 0x0102, key, new IntPtr(1));
                    break;
                case "confirm":
                case "cancel":
                    IntPtr dialog = WaitFor(() => FindWindow(process, "#32770", root), () => "The confirmation dialog did not appear.");
                    Check(Caption(dialog) == args[2], "Unexpected confirmation dialog " + Caption(dialog) + ".");
                    int choice = args[1] == "confirm" ? 6 : 2;
                    Check(PostMessage(dialog, 0x0111, new IntPtr(choice), GetDlgItem(dialog, choice)), "Unable to close the dialog.");
                    break;
                case "close":
                    Check(PostMessage(root, 0x0010, IntPtr.Zero, IntPtr.Zero), "Unable to close the desktop window.");
                    break;
                default:
                    throw new InvalidOperationException("Unknown Vokri probe command.");
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
