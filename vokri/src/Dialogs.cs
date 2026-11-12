using System;
using System.Runtime.InteropServices;

namespace Vokri
{
    public static class Dialogs
    {
        [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface FileDialog
        {
            [PreserveSig] int Show(IntPtr owner);
            void SetFileTypes(uint count, IntPtr filters);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IntPtr item);
            void SetFolder(IntPtr item);
            void GetFolder(out IntPtr item);
            void GetCurrentSelection(out IntPtr item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName(out IntPtr name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult(out ShellItem result);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ShellItem
        {
            void BindToHandler(IntPtr context, ref Guid handler, ref Guid type, out IntPtr result);
            void GetParent(out ShellItem parent);
            void GetDisplayName(uint kind, out IntPtr name);
        }

        private static readonly Guid OpenId = new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
        private static readonly Guid SaveId = new Guid("C0B4E2F3-BA21-4773-8DBA-335EC946EB8B");

        public static string OpenFolder(Window owner, string title = "Open folder")
        {
            return Choose(owner, OpenId, title, 0x20);
        }
        public static string OpenFile(Window owner, string title = "Open file")
        {
            return Choose(owner, OpenId, title, 0x1000);
        }
        public static string SaveFile(Window owner, string title = "Save file")
        {
            return Choose(owner, SaveId, title, 0x02);
        }

        private static string Choose(Window owner, Guid id, string title, uint flags)
        {
            owner.VerifyOpen();
            var dialog = (FileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(id, true));
            try
            {
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | flags | 0x40 | 0x800 | 0x08);
                dialog.SetTitle(title);
                int result = dialog.Show(owner.Handle);
                if (result == unchecked((int)0x800704c7)) return null;
                Marshal.ThrowExceptionForHR(result);
                ShellItem item;
                dialog.GetResult(out item);
                try
                {
                    IntPtr name;
                    item.GetDisplayName(0x80058000, out name);
                    try { return Marshal.PtrToStringUni(name); }
                    finally { Marshal.FreeCoTaskMem(name); }
                }
                finally { Marshal.FinalReleaseComObject(item); }
            }
            finally { Marshal.FinalReleaseComObject(dialog); }
        }

        public static bool Confirm(Window owner, string title, string message)
        {
            owner.VerifyOpen();
            return Native.MessageBoxW(owner.Handle, message, title, 0x04 | 0x30 | 0x100) == 6;
        }

        public static void Alert(Window owner, string title, string message)
        {
            owner.VerifyOpen();
            Native.MessageBoxW(owner.Handle, message, title, 0x10);
        }
    }

    public static class Clipboard
    {
        private const uint UnicodeText = 13;
        private const int Limit = 2 * 1024 * 1024;
        [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr owner);
        [DllImport("user32.dll")] private static extern bool CloseClipboard();
        [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
        [DllImport("user32.dll")] private static extern IntPtr GetClipboardData(uint format);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetClipboardData(uint format, IntPtr data);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr memory);
        [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr memory);
        [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr memory);
        [DllImport("kernel32.dll")] private static extern UIntPtr GlobalSize(IntPtr memory);

        public static string ReadText(Window owner)
        {
            owner.VerifyOpen();
            if (!OpenClipboard(owner.Handle)) throw new InvalidOperationException("The clipboard is in use.");
            try
            {
                IntPtr memory = GetClipboardData(UnicodeText);
                if (memory == IntPtr.Zero) return null;
                ulong length = GlobalSize(memory).ToUInt64() / 2;
                if (length == 0 || length > Limit + 1) throw new InvalidOperationException("Clipboard text exceeds the limit.");
                IntPtr pointer = Native.Require(GlobalLock(memory));
                try
                {
                    string text = Marshal.PtrToStringUni(pointer, (int)length);
                    int end = text.IndexOf('\0');
                    if (end < 0) throw new InvalidOperationException("Clipboard text is malformed.");
                    return text.Substring(0, end);
                }
                finally { GlobalUnlock(memory); }
            }
            finally { CloseClipboard(); }
        }

        public static void WriteText(Window owner, string text)
        {
            owner.VerifyOpen();
            if (text == null || text.Length > Limit || text.IndexOf('\0') >= 0) throw new ArgumentException("Use bounded Unicode text.");
            IntPtr memory = Native.Require(GlobalAlloc(2, new UIntPtr((uint)((text.Length + 1) * 2))));
            try
            {
                IntPtr pointer = Native.Require(GlobalLock(memory));
                try
                {
                    Marshal.Copy(text.ToCharArray(), 0, pointer, text.Length);
                    Marshal.WriteInt16(pointer, text.Length * 2, 0);
                }
                finally { GlobalUnlock(memory); }
                if (!OpenClipboard(owner.Handle)) throw new InvalidOperationException("The clipboard is in use.");
                try
                {
                    if (!EmptyClipboard()) throw new InvalidOperationException("The clipboard could not be opened for writing.");
                    Native.Require(SetClipboardData(UnicodeText, memory));
                    memory = IntPtr.Zero;
                }
                finally { CloseClipboard(); }
            }
            finally { if (memory != IntPtr.Zero) GlobalFree(memory); }
        }
    }
}
