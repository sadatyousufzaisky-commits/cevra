using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

namespace Vokri
{
    [Flags]
    public enum Modifiers { None = 0, Control = 1, Shift = 2, Alt = 4 }

    public sealed class Application : IDisposable
    {
        internal const string WindowClass = "Vokri.Window.1", CanvasClass = "Vokri.Canvas.1";
        private static readonly object Lifetime = new object();
        private static Application current;
        private static readonly Native.WindowProcedure Procedure = Route;
        private readonly Dictionary<IntPtr, Window> windows = new Dictionary<IntPtr, Window>();
        private readonly Dictionary<IntPtr, Canvas> canvases = new Dictionary<IntPtr, Canvas>();
        private readonly Queue<Action> queue = new Queue<Action>();
        private readonly int thread = Thread.CurrentThread.ManagedThreadId;
        private readonly SynchronizationContext previousContext;
        private IntPtr dispatcher, richEdit;
        private bool running, disposed, posted;
        internal readonly IntPtr Instance = Native.GetModuleHandleW(null);
        public event Action<Exception> UnhandledException;

        private sealed class DispatcherContext : SynchronizationContext
        {
            private readonly Application owner;
            internal DispatcherContext(Application owner) { this.owner = owner; }
            public override void Post(SendOrPostCallback callback, object state)
            {
                owner.Post(() => callback(state));
            }
            public override void Send(SendOrPostCallback callback, object state)
            {
                owner.VerifyAccess();
                callback(state);
            }
            public override SynchronizationContext CreateCopy() { return this; }
        }

        public Application()
        {
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
                throw new InvalidOperationException("Vokri requires one application on an STA thread.");
            lock (Lifetime)
            {
                if (current != null) throw new InvalidOperationException("A Vokri application is already running.");
                Marshal.ThrowExceptionForHR(Native.OleInitialize(IntPtr.Zero));
                try
                {
                    Register(WindowClass, new IntPtr(Native.FaceColor + 1));
                    Register(CanvasClass, IntPtr.Zero);
                    dispatcher = Native.Require(Native.CreateWindowExW(0, WindowClass, "", 0, 0, 0, 0, 0,
                        new IntPtr(-3), IntPtr.Zero, Instance, IntPtr.Zero));
                    previousContext = SynchronizationContext.Current;
                    SynchronizationContext.SetSynchronizationContext(new DispatcherContext(this));
                    current = this;
                }
                catch
                {
                    Native.UnregisterClassW(CanvasClass, Instance);
                    Native.UnregisterClassW(WindowClass, Instance);
                    Native.OleUninitialize();
                    throw;
                }
            }
        }

        private void Register(string name, IntPtr background)
        {
            var definition = new Native.WindowClass {
                Size = (uint)Marshal.SizeOf(typeof(Native.WindowClass)), Procedure = Procedure, Name = name,
                Instance = Instance, Cursor = Native.LoadCursorW(IntPtr.Zero, new IntPtr(32512)), Background = background
            };
            if (Native.RegisterClassExW(ref definition) == 0) throw new Win32Exception();
        }

        public void VerifyAccess()
        {
            if (Thread.CurrentThread.ManagedThreadId != thread || disposed)
                throw new InvalidOperationException("This operation requires the active Vokri UI thread.");
        }

        public bool Post(Action callback)
        {
            if (callback == null) throw new ArgumentNullException("callback");
            lock (queue)
            {
                if (dispatcher == IntPtr.Zero || queue.Count >= 4096) return false;
                if (!posted && !Native.PostMessageW(dispatcher, Native.Dispatch, IntPtr.Zero, IntPtr.Zero)) return false;
                posted = true;
                queue.Enqueue(callback);
                return true;
            }
        }

        private void Drain()
        {
            for (int i = 0; i < 64; i++)
            {
                Action callback;
                lock (queue)
                {
                    if (queue.Count == 0) { posted = false; return; }
                    callback = queue.Dequeue();
                }
                try { callback(); } catch (Exception error) { Report(error); }
            }
            lock (queue)
            {
                posted = dispatcher != IntPtr.Zero && Native.PostMessageW(dispatcher, Native.Dispatch, IntPtr.Zero, IntPtr.Zero);
            }
        }

        internal void Report(Exception error)
        {
            var callback = UnhandledException;
            if (callback != null)
            {
                try { callback(error); return; } catch {}
            }
            Native.MessageBoxW(IntPtr.Zero, error.Message, "Vokri", 0x10);
        }

        private static IntPtr Route(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam)
        {
            var app = current;
            if (app != null)
            {
                try
                {
                    if (handle == app.dispatcher && message == Native.Dispatch) { app.Drain(); return IntPtr.Zero; }
                    Window window;
                    if (app.windows.TryGetValue(handle, out window)) return window.Message(message, wParam, lParam);
                    Canvas canvas;
                    if (app.canvases.TryGetValue(handle, out canvas)) return canvas.Message(message, wParam, lParam);
                }
                catch (Exception error) { app.Report(error); return IntPtr.Zero; }
            }
            return Native.DefWindowProcW(handle, message, wParam, lParam);
        }

        internal void Register(Window window) { windows.Add(window.Handle, window); }
        internal void Register(Canvas canvas) { canvases.Add(canvas.Handle, canvas); }
        internal void Remove(Canvas canvas) { canvases.Remove(canvas.Handle); }
        internal void Remove(Window window)
        {
            windows.Remove(window.Handle);
            if (running && windows.Count == 0) Native.PostQuitMessage(0);
        }

        internal void EnsureRichEdit()
        {
            if (richEdit == IntPtr.Zero) richEdit = Native.Require(Native.LoadLibraryExW("msftedit.dll", IntPtr.Zero, 0x800));
        }

        public int Run()
        {
            VerifyAccess();
            if (running || windows.Count == 0) throw new InvalidOperationException("Create a window before running the application.");
            running = true;
            try
            {
                Native.Message message;
                int result;
                while ((result = Native.GetMessageW(out message, IntPtr.Zero, 0, 0)) > 0)
                {
                    Window window;
                    IntPtr root = Native.GetAncestor(message.Window, 2);
                    if (windows.TryGetValue(root, out window) &&
                        (window.Shortcut(message) || Native.IsDialogMessageW(root, ref message))) continue;
                    Native.TranslateMessage(ref message);
                    Native.DispatchMessageW(ref message);
                }
                if (result < 0) throw new Win32Exception();
                return message.WParam.ToInt32();
            }
            finally { running = false; }
        }

        public void Dispose()
        {
            if (disposed) return;
            VerifyAccess();
            if (running) throw new InvalidOperationException("Close the application windows before disposing Vokri.");
            foreach (var window in new List<Window>(windows.Values))
                if (window.Handle != IntPtr.Zero) Native.DestroyWindow(window.Handle);
            lock (queue)
            {
                Native.DestroyWindow(dispatcher);
                dispatcher = IntPtr.Zero;
                queue.Clear();
            }
            lock (Lifetime)
            {
                disposed = true;
                SynchronizationContext.SetSynchronizationContext(previousContext);
                if (richEdit != IntPtr.Zero) Native.FreeLibrary(richEdit);
                Native.UnregisterClassW(CanvasClass, Instance);
                Native.UnregisterClassW(WindowClass, Instance);
                Native.OleUninitialize();
                current = null;
            }
        }
    }

    public sealed class Window
    {
        private readonly Dictionary<IntPtr, Control> controls = new Dictionary<IntPtr, Control>();
        private readonly Dictionary<int, Action> shortcuts = new Dictionary<int, Action>();
        private readonly Size minimum;
        private Element content;
        private int dpi;
        private IntPtr font;
        private IntPtr editorFont;
        public Application Application { get; private set; }
        public IntPtr Handle { get; private set; }
        public int Dpi { get { return dpi; } }
        public event CancelEventHandler Closing;
        public event Action Closed;

        public Window(Application application, string title, Size size, Size minimum, Window owner = null)
        {
            application.VerifyAccess();
            if (size.Width < minimum.Width || size.Height < minimum.Height) throw new ArgumentException("The initial size is below the minimum.");
            if (owner != null && (owner.Application != application || owner.Handle == IntPtr.Zero))
                throw new ArgumentException("Use an open owner in the same application.");
            Application = application;
            this.minimum = minimum;
            Handle = Native.Require(Native.CreateWindowExW(0, Vokri.Application.WindowClass, title,
                Native.OverlappedWindow | Native.ClipChildren, unchecked((int)0x80000000), 0,
                size.Width, size.Height, owner == null ? IntPtr.Zero : owner.Handle, IntPtr.Zero, application.Instance, IntPtr.Zero));
            try
            {
                application.Register(this);
                SetDpi((int)Native.GetDpiForWindow(Handle));
                if (dpi != 96) Native.SetWindowPos(Handle, IntPtr.Zero, 0, 0, Scale(size.Width), Scale(size.Height), 0x16);
            }
            catch { Native.DestroyWindow(Handle); throw; }
        }

        public string Title
        {
            get { VerifyOpen(); var text = new System.Text.StringBuilder(Native.GetWindowTextLengthW(Handle) + 1);
                Native.GetWindowTextW(Handle, text, text.Capacity); return text.ToString(); }
            set { VerifyOpen(); Native.SetWindowTextW(Handle, value ?? ""); }
        }

        internal void VerifyOpen()
        {
            Application.VerifyAccess();
            if (Handle == IntPtr.Zero) throw new ObjectDisposedException("Window");
        }

        public void SetContent(Element root)
        {
            VerifyOpen();
            if (content != null || root == null || root.Parent != null || root.Host != null)
                throw new InvalidOperationException("Attach one unattached content tree to a window.");
            content = root;
            try { root.Attach(this); Layout(); }
            catch { Native.DestroyWindow(Handle); throw; }
        }

        public void Show() { VerifyOpen(); Native.ShowWindow(Handle, 5); }
        public void Close() { VerifyOpen(); Native.Send(Handle, Native.Close, IntPtr.Zero, IntPtr.Zero); }

        public void BindShortcut(int virtualKey, Modifiers modifiers, Action callback)
        {
            VerifyOpen();
            if (virtualKey < 1 || virtualKey > 255 || ((int)modifiers & ~7) != 0 || callback == null)
                throw new ArgumentException("Use a virtual key, modifiers, and callback.");
            shortcuts.Add(virtualKey | (int)modifiers << 8, callback);
        }

        internal bool Shortcut(Native.Message message)
        {
            if (message.Id != Native.KeyDown && message.Id != Native.SysKeyDown) return false;
            int modifiers = (Native.GetKeyState(0x11) < 0 ? 1 : 0) | (Native.GetKeyState(0x10) < 0 ? 2 : 0) |
                (Native.GetKeyState(0x12) < 0 ? 4 : 0);
            Action callback;
            if (!shortcuts.TryGetValue(message.WParam.ToInt32() | modifiers << 8, out callback)) return false;
            if ((message.LParam.ToInt64() & 0x40000000) == 0)
            {
                try { callback(); } catch (Exception error) { Application.Report(error); }
            }
            return true;
        }

        internal int Scale(int value) { return (int)Math.Round(value * (double)dpi / 96); }
        internal int Unscale(int value) { return (int)Math.Floor(value * 96.0 / dpi); }
        internal IntPtr Font(bool mono) { return mono ? editorFont : font; }

        private void SetDpi(int value)
        {
            dpi = value > 0 ? value : 96;
            IntPtr next = Native.Require(Native.CreateFontW(-Scale(14), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI"));
            IntPtr mono = Native.CreateFontW(-Scale(15), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Consolas");
            if (mono == IntPtr.Zero) { Native.DeleteObject(next); throw new Win32Exception(); }
            IntPtr old = font, oldEditor = editorFont;
            font = next;
            editorFont = mono;
            foreach (var control in controls.Values) control.ApplyFont();
            if (old != IntPtr.Zero) Native.DeleteObject(old);
            if (oldEditor != IntPtr.Zero) Native.DeleteObject(oldEditor);
        }

        internal void Register(Control control) { controls.Add(control.Handle, control); }
        internal IntPtr NextControlId { get { return new IntPtr(100 + controls.Count); } }

        private void Layout()
        {
            if (content == null) return;
            Native.Rectangle client;
            if (Native.GetClientRect(Handle, out client))
                content.Arrange(new Rect(0, 0, Unscale(client.Right), Unscale(client.Bottom)));
        }

        internal IntPtr Message(uint message, IntPtr wParam, IntPtr lParam)
        {
            switch (message)
            {
                case Native.Close:
                    var args = new CancelEventArgs();
                    if (Closing != null) Closing(this, args);
                    if (!args.Cancel && Handle != IntPtr.Zero) Native.DestroyWindow(Handle);
                    return IntPtr.Zero;
                case Native.Destroy:
                    // Child HWNDs and their fonts stay valid until Windows sends WM_NCDESTROY.
                    return IntPtr.Zero;
                case 0x0082:
                    IntPtr previous = Handle;
                    Application.Remove(this);
                    foreach (var child in controls.Values) child.Detach();
                    controls.Clear();
                    Handle = IntPtr.Zero;
                    if (font != IntPtr.Zero) Native.DeleteObject(font);
                    if (editorFont != IntPtr.Zero) Native.DeleteObject(editorFont);
                    if (Closed != null) Closed();
                    return Native.DefWindowProcW(previous, message, wParam, lParam);
                case Native.Size:
                    Layout();
                    return IntPtr.Zero;
                case Native.Command:
                    Control control;
                    if (controls.TryGetValue(lParam, out control)) control.Command(Native.High(wParam));
                    return IntPtr.Zero;
                case Native.DpiChanged:
                    SetDpi(Native.Low(wParam));
                    var next = (Native.Rectangle)Marshal.PtrToStructure(lParam, typeof(Native.Rectangle));
                    Native.SetWindowPos(Handle, IntPtr.Zero, next.Left, next.Top, next.Right - next.Left, next.Bottom - next.Top, 0x14);
                    Layout();
                    return IntPtr.Zero;
                case Native.MinMax:
                    var limits = (Native.MinMaxInfo)Marshal.PtrToStructure(lParam, typeof(Native.MinMaxInfo));
                    limits.MinTrack.X = Scale(minimum.Width);
                    limits.MinTrack.Y = Scale(minimum.Height);
                    Marshal.StructureToPtr(limits, lParam, false);
                    return IntPtr.Zero;
                default: return Native.DefWindowProcW(Handle, message, wParam, lParam);
            }
        }
    }
}
