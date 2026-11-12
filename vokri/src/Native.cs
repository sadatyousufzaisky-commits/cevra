using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Vokri
{
    internal static class Native
    {
        internal const uint Close = 0x0010, Destroy = 0x0002, Paint = 0x000f, Size = 0x0005,
            Command = 0x0111, MinMax = 0x0024, DpiChanged = 0x02e0, SetFont = 0x0030,
            Dispatch = 0x8001, MouseDown = 0x0201, KeyDown = 0x0100, SysKeyDown = 0x0104;
        internal const uint Child = 0x40000000, Visible = 0x10000000, TabStop = 0x00010000,
            VScroll = 0x00200000, HScroll = 0x00100000, ClipChildren = 0x02000000,
            ClipSiblings = 0x04000000, OverlappedWindow = 0x00cf0000;
        internal const int WindowColor = 5, WindowTextColor = 8, FaceColor = 15;

        internal delegate IntPtr WindowProcedure(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)]
        internal struct Point { internal int X, Y; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct Rectangle { internal int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct Message
        {
            internal IntPtr Window;
            internal uint Id;
            internal IntPtr WParam, LParam;
            internal uint Time;
            internal Point Position;
            internal uint Private;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct WindowClass
        {
            internal uint Size, Style;
            internal WindowProcedure Procedure;
            internal int ClassExtra, WindowExtra;
            internal IntPtr Instance, Icon, Cursor, Background;
            internal string Menu, Name;
            internal IntPtr SmallIcon;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct MinMaxInfo
        {
            internal Point Reserved, MaxSize, MaxPosition, MinTrack, MaxTrack;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct PaintInfo
        {
            internal IntPtr Dc;
            internal int Erase;
            internal Rectangle Bounds;
            internal int Restore, Update;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] internal byte[] Reserved;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct TextLength { internal uint Flags, CodePage; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct TextBuffer
        {
            internal uint Bytes, Flags, CodePage;
            internal IntPtr DefaultCharacter, UsedDefaultCharacter;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern IntPtr GetModuleHandleW(string name);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        internal static extern IntPtr LoadLibraryExW(string name, IntPtr file, uint flags);
        [DllImport("kernel32.dll")] internal static extern bool FreeLibrary(IntPtr module);
        [DllImport("ole32.dll")] internal static extern int OleInitialize(IntPtr reserved);
        [DllImport("ole32.dll")] internal static extern void OleUninitialize();
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        internal static extern ushort RegisterClassExW(ref WindowClass definition);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern bool UnregisterClassW(string name, IntPtr instance);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        internal static extern IntPtr CreateWindowExW(uint extended, string type, string text, uint style, int x, int y,
            int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
        [DllImport("user32.dll")] internal static extern bool DestroyWindow(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] internal static extern bool EnableWindow(IntPtr window, bool enabled);
        [DllImport("user32.dll")] internal static extern IntPtr SetFocus(IntPtr window);
        [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] internal static extern short GetKeyState(int key);
        [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr window, out Rectangle bounds);
        [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] internal static extern bool AdjustWindowRectExForDpi(ref Rectangle bounds, uint style, bool menu, uint extended, uint dpi);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        internal static extern int GetMessageW(out Message message, IntPtr window, uint min, uint max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern bool IsDialogMessageW(IntPtr window, ref Message message);
        [DllImport("user32.dll")] internal static extern bool TranslateMessage(ref Message message);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern IntPtr DispatchMessageW(ref Message message);
        [DllImport("user32.dll")] internal static extern void PostQuitMessage(int code);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern IntPtr LoadCursorW(IntPtr instance, IntPtr id);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern bool SetWindowTextW(IntPtr window, string value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int GetWindowTextW(IntPtr window, StringBuilder value, int capacity);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int GetWindowTextLengthW(IntPtr window);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern IntPtr Send(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern IntPtr SendString(IntPtr window, uint message, IntPtr wParam, string lParam);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern IntPtr SendTextLength(IntPtr window, uint message, ref TextLength options, IntPtr lParam);
        [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern IntPtr SendTextBuffer(IntPtr window, uint message, ref TextBuffer options, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int MessageBoxW(IntPtr owner, string text, string title, uint flags);
        [DllImport("user32.dll")] internal static extern IntPtr BeginPaint(IntPtr window, out PaintInfo paint);
        [DllImport("user32.dll")] internal static extern bool EndPaint(IntPtr window, ref PaintInfo paint);
        [DllImport("user32.dll")] internal static extern bool InvalidateRect(IntPtr window, IntPtr bounds, bool erase);
        [DllImport("user32.dll")] internal static extern uint GetSysColor(int index);
        [DllImport("user32.dll")] internal static extern int FillRect(IntPtr dc, ref Rectangle bounds, IntPtr brush);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int DrawTextW(IntPtr dc, string text, int length, ref Rectangle bounds, uint format);
        [DllImport("gdi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern IntPtr CreateFontW(int height, int width, int escapement, int orientation, int weight,
            uint italic, uint underline, uint strikeout, uint charset, uint output, uint clip, uint quality, uint family, string face);
        [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr value);
        [DllImport("gdi32.dll")] internal static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
        [DllImport("gdi32.dll")] internal static extern IntPtr CreateSolidBrush(uint color);
        [DllImport("gdi32.dll")] internal static extern IntPtr CreatePen(int style, int width, uint color);
        [DllImport("gdi32.dll")] internal static extern bool MoveToEx(IntPtr dc, int x, int y, IntPtr previous);
        [DllImport("gdi32.dll")] internal static extern bool LineTo(IntPtr dc, int x, int y);
        [DllImport("gdi32.dll")] internal static extern int SetBkMode(IntPtr dc, int mode);
        [DllImport("gdi32.dll")] internal static extern uint SetTextColor(IntPtr dc, uint color);

        internal static int Low(IntPtr value) { return (int)(value.ToInt64() & 65535); }
        internal static int High(IntPtr value) { return (int)((value.ToInt64() >> 16) & 65535); }
        internal static IntPtr Require(IntPtr handle)
        {
            if (handle == IntPtr.Zero) throw new Win32Exception();
            return handle;
        }
    }
}
