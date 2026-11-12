using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Accessibility;
using Vokri;

internal static class VokriFrameworkChecks
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid type,
        [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Bounds bounds);

    [StructLayout(LayoutKind.Sequential)]
    private struct Bounds { internal int Left, Top, Right, Bottom; }

    private static void Check(bool condition, string detail)
    {
        if (!condition) throw new InvalidOperationException(detail);
    }

    private static async Task CheckService(string node, string script)
    {
        using (var client = new ServiceClient(node, new[] { script, "literal \"argument\" \\" }, Path.GetDirectoryName(script),
            new Dictionary<string, string> { { "VOKRI_QA_CONTEXT", "café" }, { "NODE_OPTIONS", null } }))
        {
            var eventReceived = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            client.Notification += (name, data) =>
            {
                if (name == "echo") eventReceived.TrySetResult((string)data["environment"]);
            };
            var replies = new Task<IDictionary<string, object>>[12];
            for (int i = 0; i < replies.Length; i++)
            {
                int index = i;
                replies[i] = Task.Run(() => client.Request("echo", new Dictionary<string, object> { { "index", index } }));
            }
            var packets = await Task.WhenAll(replies);
            for (int i = 0; i < packets.Length; i++)
            {
                Check((int)packets[i]["index"] == i, "Concurrent request IDs lost their responses.");
                Check((string)packets[i]["argument"] == "literal \"argument\" \\", "Windows command-line quoting changed an argument.");
            }
            Check(await eventReceived.Task == "café", "The service did not receive its Unicode environment.");
            bool rejected = false;
            try { await client.Request("unknown"); }
            catch (ServiceException error) { rejected = error.Code == "UNKNOWN_OPERATION"; }
            Check(rejected, "An unknown operation did not return a structured error.");
            bool timedOut = false;
            try { await client.Request("hang", timeoutMilliseconds: 300); }
            catch (ServiceException error) { timedOut = error.Code == "SERVICE_TIMEOUT"; }
            Check(timedOut, "A service deadline did not expire.");
            bool closed = false;
            try { await client.Request("echo"); }
            catch (ServiceException error) { closed = error.Code == "SERVICE_CLOSED"; }
            Check(closed, "The timed-out connection stayed open.");
        }
    }

    [STAThread]
    private static int Main(string[] arguments)
    {
        try
        {
            using (var app = new Application())
            {
                var window = new Window(app, "Vokri framework checks", new Size(820, 540), new Size(360, 270));
                var tool = new Window(app, "Owned window", new Size(360, 200), new Size(240, 160), window);
                var label = new Label("Name", new Size(100, 25));
                var entry = new TextField(new Size(160, 25));
                var button = new Button("Apply", new Size(90, 30));
                var editor = new TextEditor(new Size(320, 200));
                var list = new ListBox(new Size(100, 80));
                var canvas = new Canvas("Preview chart", new Size(150, 130));
                var grid = new Grid(new[] { Track.Fixed(140), Track.Star(2), Track.Star() },
                    new[] { Track.Auto, Track.Star(), Track.Fixed(28) }, 6, 10);
                grid.Add(label, 0, 0).Add(entry, 1, 0).Add(button, 2, 0)
                    .Add(list, 0, 1).Add(editor, 1, 1).Add(canvas, 2, 1)
                    .Add(new Label("Ready", new Size(150, 25)), 0, 2, 3);
                bool rejected = false;
                try { grid.Add(new Label("Duplicate", new Size(10, 10)), 2, 1); }
                catch (ArgumentException) { rejected = true; }
                Check(rejected, "Overlapping cells must be rejected.");
                int clicks = 0, paints = 0, presses = 0, shortcuts = 0;
                DrawingContext expired = null;
                canvas.Paint += context =>
                {
                    paints++;
                    context.Fill(new Rect(3, 3, 40, 26), Color.Rgb(30, 104, 130));
                    context.Line(2, 34, 42, 34, Color.Text);
                    context.Text("Preview", new Rect(4, 36, 120, 24), Color.Text);
                    expired = context;
                };
                canvas.Pressed += (x, y) => { if (x >= 0 && y >= 0) presses++; };
                button.Clicked += () => clicks++;
                window.BindShortcut(0x75, Modifiers.None, () => shortcuts++);
                window.SetContent(grid);
                window.Show();
                bool cancel = true;
                window.Closing += (_sender, args) => { args.Cancel = cancel; };
                window.Close();
                Check(window.Handle != IntPtr.Zero, "The closing event should veto destruction.");
                var failure = new TaskCompletionSource<Exception>();
                app.UnhandledException += error =>
                {
                    failure.TrySetResult(error);
                    cancel = false;
                    if (window.Handle != IntPtr.Zero) window.Close();
                };
                var caller = new Thread(() =>
                {
                    try
                    {
                        bool denied = false;
                        try { entry.Text = "wrong thread"; }
                        catch (InvalidOperationException) { denied = true; }
                        Check(denied, "Cross-thread native control access must fail.");
                        Check(app.Post(() =>
                        {
                            tool.Close();
                            Check(window.Handle != IntPtr.Zero, "Closing an owned window must preserve the parent.");
                            entry.Text = "café";
                            Check(entry.Text == "café", "Unicode text field round trip failed.");
                            editor.Text = "first\nsecond 😀\n";
                            Check(editor.Text == "first\nsecond 😀\n", "Unicode multiline editor round trip failed.");
                            editor.GoTo(2, 3);
                            int caret = SendMessageW(editor.Handle, 0x00b0, IntPtr.Zero, IntPtr.Zero).ToInt32() & 0xffff;
                            Check(caret == 8, "Line and column selection did not set the native caret.");
                            list.SetItems(new[] { "first", "second" });
                            list.SelectedIndex = 1;
                            Check(list.SelectedIndex == 1, "Native list selection failed.");
                            SendMessageW(button.Handle, 0x00f5, IntPtr.Zero, IntPtr.Zero);
                            Check(clicks == 1, "The native button did not dispatch its Clicked event.");
                            button.Enabled = false;
                            SendMessageW(button.Handle, 0x00f5, IntPtr.Zero, IntPtr.Zero);
                            Check(clicks == 1, "A disabled button dispatched a click.");
                            Guid type = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
                            IAccessible accessible;
                            Marshal.ThrowExceptionForHR(AccessibleObjectFromWindow(button.Handle, 0xfffffffc, ref type, out accessible));
                            Check(accessible.get_accName(0) == "Apply", "Windows accessibility did not expose the button name.");
                            Check(Convert.ToInt32(accessible.get_accRole(0)) == 43, "Windows accessibility did not expose the button role.");
                            Marshal.FinalReleaseComObject(accessible);
                            Check(editor.Bounds.Width >= canvas.Bounds.Width * 2 - 2 && editor.Bounds.Width > canvas.Bounds.Width,
                                "Weighted layout did not allocate the expected widths.");
                            int originalWidth = editor.Bounds.Width;
                            SetWindowPos(window.Handle, IntPtr.Zero, 0, 0, 990, 600, 0x16);
                            Check(editor.Bounds.Width > originalWidth, "The editor did not grow on a native resize.");
                            Bounds physical;
                            GetWindowRect(window.Handle, out physical);
                            physical.Right = physical.Left + 1120;
                            physical.Bottom = physical.Top + 700;
                            IntPtr suggested = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Bounds)));
                            try
                            {
                                Marshal.StructureToPtr(physical, suggested, false);
                                SendMessageW(window.Handle, 0x02e0, new IntPtr(144 | 144 << 16), suggested);
                            }
                            finally { Marshal.FreeHGlobal(suggested); }
                            Check(window.Dpi == 144 && editor.Bounds.Width > 0, "DPI relayout did not update logical geometry.");
                            SendMessageW(canvas.Handle, 0x0201, IntPtr.Zero, new IntPtr(16 | 18 << 16));
                            Check(presses == 1, "Canvas input did not dispatch.");
                            SendMessageW(canvas.Handle, 0x000f, IntPtr.Zero, IntPtr.Zero);
                            Check(paints > 0 && expired != null, "The drawing surface did not paint.");
                            bool paintClosed = false;
                            try { expired.Fill(new Rect(0, 0, 3, 3), Color.Text); }
                            catch (InvalidOperationException) { paintClosed = true; }
                            Check(paintClosed, "A paint context remained live after its callback.");
                            if (Environment.GetEnvironmentVariable("CEVRA_TEST_CLIPBOARD") == "1")
                            {
                                Clipboard.WriteText(window, "Vokri clipboard fixture café");
                                Check(Clipboard.ReadText(window) == "Vokri clipboard fixture café", "Native clipboard round trip failed.");
                            }
                            PostMessageW(editor.Handle, 0x0100, new IntPtr(0x75), new IntPtr(1));
                            Check(app.Post(() =>
                            {
                                // Queue the assertion after the posted keyboard message.
                                var next = new Timer(_ => app.Post(() =>
                                {
                                    Check(shortcuts == 1, "The window shortcut was not routed.");
                                    cancel = false;
                                    window.Close();
                                }), null, 40, Timeout.Infinite);
                                window.Closed += next.Dispose;
                            }), "The closing assertion was not queued.");
                        }), "The dispatcher refused a worker callback.");
                    }
                    catch (Exception error)
                    {
                        failure.TrySetResult(error);
                        app.Post(() => { cancel = false; window.Close(); });
                    }
                });
                caller.Start();
                Check(app.Run() == 0, "The native message loop exited with an error.");
                caller.Join();
                if (failure.Task.IsCompleted) throw failure.Task.Result;
                Check(window.Handle == IntPtr.Zero && editor.Handle == IntPtr.Zero, "The window did not dispose its child controls.");
                Check(clicks == 1 && paints > 0 && presses == 1 && shortcuts == 1, "Not all native callbacks ran.");
            }
            CheckService(arguments[0], arguments[1]).GetAwaiter().GetResult();
            Console.WriteLine("Vokri native window, layout, controls, drawing, accessibility and dispatch checks passed.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
