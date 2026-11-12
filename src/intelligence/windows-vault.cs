using System;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;

internal static class WindowsCredentialVault
{
    internal const int Ok = 0, Cancelled = 2, Missing = 3, Invalid = 4, Unavailable = 5;
    internal const int KeyLimit = 2048;
    private const uint Generic = 1, LocalMachine = 2;
    private const int NotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);

    internal static string ProviderLabel(string provider)
    {
        switch (provider)
        {
            case "openai": return "OpenAI";
            case "anthropic": return "Anthropic";
            case "gemini": return "Gemini";
            default: return null;
        }
    }

    internal static string Target(string scope, string provider, string reference)
    {
        if (scope.Length != 64 || !Regex.IsMatch(scope, "\\A[a-f0-9]{64}\\z") || ProviderLabel(provider) == null ||
            reference.Length != 36 || !Regex.IsMatch(reference, "\\A[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\z"))
            return null;
        return "CEVRA/Intelligence/v1/" + scope + "/" + provider + "/" + reference;
    }

    internal static void Clear(IntPtr buffer, int bytes)
    {
        for (int i = 0; i < bytes; i++) Marshal.WriteByte(buffer, i, 0);
    }

    internal static int Store(string target, IntPtr key, int length)
    {
        if (length < 1 || length > KeyLimit) return Invalid;
        for (int i = 0; i < length; i++)
        {
            byte item = Marshal.ReadByte(key, i);
            if (item < 0x21 || item > 0x7e) return Invalid;
        }
        var value = new Credential {
            Type = Generic, TargetName = target, Blob = key, BlobSize = (uint)length,
            Persist = LocalMachine, UserName = "CEVRA Intelligence"
        };
        return CredWriteW(ref value, 0) ? Ok : Unavailable;
    }

    internal static int Inspect(string target)
    {
        IntPtr pointer;
        if (!CredReadW(target, Generic, 0, out pointer))
            return Marshal.GetLastWin32Error() == NotFound ? Missing : Unavailable;
        try
        {
            var value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            try
            {
                if (value.Type != Generic || value.Persist != LocalMachine || value.Blob == IntPtr.Zero ||
                    value.BlobSize == 0 || value.BlobSize > KeyLimit) return Invalid;
                for (int i = 0; i < value.BlobSize; i++)
                {
                    byte item = Marshal.ReadByte(value.Blob, i);
                    if (item < 0x21 || item > 0x7e) return Invalid;
                }
                return Ok;
            }
            finally
            {
                if (value.Blob != IntPtr.Zero && value.BlobSize <= 2560) Clear(value.Blob, (int)value.BlobSize);
            }
        }
        finally { CredFree(pointer); }
    }

    internal static int Delete(string target)
    {
        return CredDeleteW(target, Generic, 0) || Marshal.GetLastWin32Error() == NotFound ? Ok : Unavailable;
    }
}

internal static class CredentialVaultProgram
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 4 || args.Length > 6) return WindowsCredentialVault.Invalid;
            string target = WindowsCredentialVault.Target(args[1], args[2], args[3]);
            if (target == null) return WindowsCredentialVault.Invalid;
            if (args.Length == 4 && args[0] == "inspect") return WindowsCredentialVault.Inspect(target);
            if (args.Length == 4 && args[0] == "delete") return WindowsCredentialVault.Delete(target);
            long handle;
            uint ownerPid;
            if (args.Length != 6 || args[0] != "prompt" ||
                !long.TryParse(args[4], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out handle) || handle == 0 ||
                !uint.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out ownerPid) || ownerPid == 0)
                return WindowsCredentialVault.Invalid;
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            Application.EnableVisualStyles();
            using (var prompt = new ApiKeyPrompt(new IntPtr(handle), ownerPid, WindowsCredentialVault.ProviderLabel(args[2]), target))
                return prompt.Run();
        }
        catch { return WindowsCredentialVault.Unavailable; }
    }
}

internal sealed class ApiKeyPrompt : Form, IWin32Window
{
    private readonly IntPtr owner;
    private readonly uint ownerPid;
    private readonly string target;
    private readonly TextBox key = new TextBox();
    private readonly Label message = new Label();
    private int result = WindowsCredentialVault.Cancelled;

    private sealed class OwnerWindow : IWin32Window
    {
        public IntPtr Handle { get; private set; }
        public OwnerWindow(IntPtr handle) { Handle = handle; }
    }

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr size, IntPtr destination);

    internal ApiKeyPrompt(IntPtr owner, uint ownerPid, string provider, string target)
    {
        this.owner = owner;
        this.ownerPid = ownerPid;
        this.target = target;
        Text = "CEVRA Intelligence - " + provider + " API key";
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(456, 176);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = MaximizeBox = ShowInTaskbar = false;
        var label = new Label { Text = "Enter the API key for " + provider + ".", AutoSize = true, Location = new Point(16, 18) };
        key.AccessibleName = "API key";
        key.UseSystemPasswordChar = true;
        key.MaxLength = WindowsCredentialVault.KeyLimit + 1;
        key.SetBounds(16, 46, 424, 24);
        message.Text = "Windows Credential Manager will store this key on this computer.";
        message.SetBounds(16, 81, 424, 36);
        var save = new Button { Text = "Save Key", Location = new Point(244, 126), Size = new Size(92, 30) };
        var cancel = new Button { Text = "Cancel", Location = new Point(348, 126), Size = new Size(92, 30),
            DialogResult = DialogResult.Cancel };
        save.Click += delegate { SaveKey(); };
        AcceptButton = save;
        CancelButton = cancel;
        Controls.AddRange(new Control[] { label, key, message, save, cancel });
        ActiveControl = key;
        FormClosed += delegate { key.Clear(); };
    }

    private bool OwnerIsCurrent()
    {
        uint actualPid;
        return GetWindowThreadProcessId(owner, out actualPid) != 0 && actualPid == ownerPid;
    }

    internal int Run()
    {
        if (!OwnerIsCurrent()) return WindowsCredentialVault.Cancelled;
        using (var watch = new Timer { Interval = 100 })
        {
            watch.Tick += delegate { if (!OwnerIsCurrent()) Close(); };
            watch.Start();
            ShowDialog(new OwnerWindow(owner));
        }
        return result;
    }

    private void SaveKey()
    {
        if (!OwnerIsCurrent()) { Close(); return; }
        int capacity = WindowsCredentialVault.KeyLimit + 2;
        IntPtr text = Marshal.AllocHGlobal(capacity * 2);
        try
        {
            int length = SendMessageW(key.Handle, 0x000D, new IntPtr(capacity), text).ToInt32(); // WM_GETTEXT
            if (length < 1 || length > WindowsCredentialVault.KeyLimit)
            {
                message.Text = "Enter an API key of up to 2,048 characters.";
                return;
            }
            for (int i = 0; i < length; i++)
            {
                int character = Marshal.ReadInt16(text, i * 2);
                if (character < 0x21 || character > 0x7e)
                {
                    message.Text = "Use an API key without spaces or line breaks.";
                    return;
                }
                Marshal.WriteByte(text, i, (byte)character);
            }
            if (!OwnerIsCurrent()) { Close(); return; }
            result = WindowsCredentialVault.Store(target, text, length);
            Close();
        }
        finally
        {
            key.Clear();
            WindowsCredentialVault.Clear(text, capacity * 2);
            Marshal.FreeHGlobal(text);
        }
    }
}
