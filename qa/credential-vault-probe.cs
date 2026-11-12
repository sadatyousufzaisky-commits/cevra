using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class VaultProbe
{
    private const uint Owner = 4, SetText = 0x000c, Close = 0x0010, Click = 0x00f5;
    private const int PasswordStyle = 0x20, Style = -16;
    private const string PromptTitle = "CEVRA Intelligence - OpenAI API key";
    private const string First = "G2-SYNTHETIC-KEY-ONE", Second = "G2-SYNTHETIC-KEY-TWO";
    private delegate bool Visit(IntPtr window, IntPtr argument);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(Visit visit, IntPtr argument);
    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr owner, Visit visit, IntPtr argument);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr window, StringBuilder title, int capacity);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowLongW(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr size, string text,
        uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr size, StringBuilder text,
        uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PostMessageW(IntPtr window, uint message, IntPtr arg, IntPtr data);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr result);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr result);

    [StructLayout(LayoutKind.Sequential)]
    private struct Credential
    {
        public uint Flags, Type;
        public IntPtr TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
    }

    private static string Fixture(string value)
    {
        if (value == "first") return First;
        if (value == "second") return Second;
        return null;
    }

    private static int Prompt(IntPtr owner, string value)
    {
        IntPtr dialog = IntPtr.Zero, edit = IntPtr.Zero, save = IntPtr.Zero;
        var title = new StringBuilder(256);
        var name = new StringBuilder(256);
        for (int i = 0; i < 120; i++)
        {
            EnumWindows(delegate(IntPtr window, IntPtr ignored)
            {
                if (GetWindow(window, Owner) != owner) return true;
                GetWindowTextW(window, title, title.Capacity);
                if (title.ToString() != PromptTitle) return true;
                dialog = window;
                return false;
            }, IntPtr.Zero);
            if (dialog != IntPtr.Zero)
            {
                if (value == "wait") return 0;
                if (value == "cancel") return PostMessageW(dialog, Close, IntPtr.Zero, IntPtr.Zero) ? 0 : 11;
                EnumChildWindows(dialog, delegate(IntPtr window, IntPtr ignored)
                {
                    GetClassNameW(window, name, name.Capacity);
                    string kind = name.ToString();
                    if (kind.IndexOf(".EDIT.", StringComparison.OrdinalIgnoreCase) >= 0 &&
                        (GetWindowLongW(window, Style) & PasswordStyle) != 0) edit = window;
                    if (kind.IndexOf(".BUTTON.", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        IntPtr result;
                        SendMessageTimeoutW(window, 0x000d, new IntPtr(title.Capacity), title, 2, 1000, out result);
                        if (title.ToString() == "Save Key") save = window;
                    }
                    return true;
                }, IntPtr.Zero);
                if (edit != IntPtr.Zero && save != IntPtr.Zero) break;
            }
            Thread.Sleep(50);
        }
        if (edit == IntPtr.Zero || save == IntPtr.Zero) return 10;
        IntPtr accepted;
        if (SendMessageTimeoutW(edit, SetText, IntPtr.Zero, Fixture(value), 2, 1000, out accepted) == IntPtr.Zero ||
            accepted == IntPtr.Zero) return 12;
        return PostMessageW(save, Click, IntPtr.Zero, IntPtr.Zero) ? 0 : 11;
    }

    private static int Verify(string target, string expected)
    {
        IntPtr pointer;
        if (!CredReadW(target, 1, 0, out pointer)) return Marshal.GetLastWin32Error() == 1168 ? 3 : 5;
        try
        {
            var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            try
            {
                if (credential.BlobSize != expected.Length) return 4;
                for (int i = 0; i < expected.Length; i++)
                    if (Marshal.ReadByte(credential.Blob, i) != expected[i]) return 4;
                return 0;
            }
            finally
            {
                if (credential.Blob != IntPtr.Zero && credential.BlobSize <= 2560)
                    WindowsCredentialVault.Clear(credential.Blob, (int)credential.BlobSize);
            }
        }
        finally { CredFree(pointer); }
    }

    private static int Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "prompt")
        {
            long owner;
            if (!long.TryParse(args[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out owner) ||
                (args[2] != "wait" && args[2] != "cancel" && Fixture(args[2]) == null)) return 4;
            return Prompt(new IntPtr(owner), args[2]);
        }
        if (args.Length != 5) return 4;
        string target = WindowsCredentialVault.Target(args[1], args[2], args[3]);
        string expected = Fixture(args[4]);
        if (target == null || expected == null) return 4;
        if (args[0] == "verify") return Verify(target, expected);
    if (args[0] == "delete") return WindowsCredentialVault.Delete(target);
        if (args[0] != "seed") return 4;
        IntPtr key = Marshal.AllocHGlobal(expected.Length);
        try
        {
            for (int i = 0; i < expected.Length; i++) Marshal.WriteByte(key, i, (byte)expected[i]);
            return WindowsCredentialVault.Store(target, key, expected.Length);
        }
        finally
        {
            WindowsCredentialVault.Clear(key, expected.Length);
            Marshal.FreeHGlobal(key);
        }
    }
}
