using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using Accessibility;
using Vokri;

internal static class NativeSurfaceChecks
{
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")]
    private static extern bool UpdateWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern uint GetGuiResources(IntPtr process, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr SendMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid type, out IAccessible accessible);

    private static void Require(bool result, string issue)
    {
        if (!result) throw new InvalidOperationException(issue);
    }

    private static void Inspect(Control control, Action<IAccessible> inspect)
    {
        Guid type = typeof(IAccessible).GUID;
        IAccessible accessible;
        Marshal.ThrowExceptionForHR(AccessibleObjectFromWindow(control.Handle, 0xfffffffc, ref type, out accessible));
        try { inspect(accessible); }
        finally { Marshal.FinalReleaseComObject(accessible); }
    }

    [STAThread]
    private static int Main()
    {
        try
        {
            using (var app = new Application())
            using (var process = Process.GetCurrentProcess())
            {
                var window = new Window(app, "Native surface checks", new Size(760, 520), new Size(440, 320));
                var list = new VirtualList("Documents", new Size(200, 380));
                var action = new Button("Review changes", new Size(160, 36), true);
                var text = new TextEditor(new Size(420, 240)) { Text = "café　かな 😀" };
                var canvas = new Canvas("Frame sample", new Size(400, 100));
                int reads = 0, activated = 0, paints = 0, timerFaults = 0;
                bool complete = false;
                Exception failure = null;
                var samples = new List<double>();
                list.SetRows(100000, index => { reads++; return "Document " + (index + 1); });
                action.Clicked += () => activated++;
                app.UnhandledException += error =>
                {
                    if (error.Message == "Expected frame fault") timerFaults++;
                    else { failure = error; if (window.Handle != IntPtr.Zero) window.Close(); }
                };
                canvas.Paint += draw =>
                {
                    paints++;
                    draw.Fill(new Rect(0, 0, draw.Bounds.Width, draw.Bounds.Height), window.Colors.Surface);
                    draw.Line(0, 25, draw.Bounds.Width, 25, window.Colors.Accent, 2);
                    draw.Text("Native rendering", new Rect(12, 0, 220, 24), window.Colors.Text);
                };
                window.Appearance = Appearance.IrisInkDark;
                window.SetContent(new Grid(new[] { Track.Star(), Track.Star(2) },
                    new[] { Track.Fixed(36), Track.Star(3), Track.Star() }, 8, 12)
                    .Add(action, 1, 0).Add(list, 0, 1, 1, 2).Add(text, 1, 1).Add(canvas, 1, 2));
                window.Show();
                var owned = new Window(app, "Owned settings", new Size(380, 220), new Size(320, 180), window);
                owned.SetContent(new Label("Native owned window", new Size(260, 28)));
                owned.Show();
                owned.Close();
                Require(owned.Handle == IntPtr.Zero, "Owned window did not dispose.");
                list.Select(99999);
                Require(list.SelectedIndex == 99999 && list.Count == 100000, "Virtual selection failed.");
                Inspect(list, acc =>
                {
                    Require(acc.accChildCount >= 100000, "The system list provider hid virtual rows.");
                    Require(acc.get_accName(100000) == "Document 100000", "The final row lacked its accessible label.");
                });
                Inspect(action, acc =>
                {
                    Require(acc.get_accName(0) == "Review changes" && Convert.ToInt32(acc.get_accRole(0)) == 43,
                        "The styled action lost its system button name or role.");
                    acc.accDoDefaultAction(0);
                });
                SendMessageW(list.Handle, 0x0100, new IntPtr(0x26), new IntPtr(1));
                Require(list.SelectedIndex == 99998, "The virtual list did not handle the Up key.");
                Require(text.Text == "café　かな 😀", "The native editor altered Unicode.");

                var baseline = GetGuiResources(process.Handle, 0);
                uint midpoint = baseline;
                var work = Stopwatch.StartNew();
                for (int i = 0; i < 180; i++)
                {
                    long start = Stopwatch.GetTimestamp();
                    Require(SetWindowPos(window.Handle, IntPtr.Zero, 0, 0, 700 + i % 70, 430 + i % 95, 0x16),
                        "Native resize failed.");
                    if (i % 30 == 0)
                    {
                        window.SetFontSizes(14 + i % 3, i % 60 == 0 ? 15 : 22);
                        window.Appearance = i % 60 == 0 ? Appearance.IrisInkLight : Appearance.IrisInkDark;
                    }
                    canvas.Invalidate();
                    UpdateWindow(canvas.Handle);
                    UpdateWindow(list.Handle);
                    samples.Add((Stopwatch.GetTimestamp() - start) * 1000.0 / Stopwatch.Frequency);
                    if (i == 89) midpoint = GetGuiResources(process.Handle, 0);
                }
                work.Stop();
                var after = GetGuiResources(process.Handle, 0);
                Require(after <= midpoint + 4, "Resize and appearance leaked GDI objects: " + midpoint + " -> " + after);
                Require(reads > 0 && reads < list.Count, "Native painting materialized the virtual list: " + reads);
                Require(paints >= 180, "The native stress loop failed to draw its frames.");
                Require(text.Text == "café　かな 😀", "Font and appearance changes corrupted editor state.");
                samples.Sort();
                bool animate = window.AnimationsEnabled;
                int callbacks = 0;
                IDisposable animation = null;
                if (animate) window.Animate(_ => { throw new InvalidOperationException("Expected frame fault"); });
                animation = window.Animate(_ =>
                {
                    if (++callbacks < 4) return;
                    animation.Dispose();
                    complete = true;
                    window.Close();
                });
                if (!animate)
                {
                    Require(callbacks == 1, "Reduced motion did not produce one static frame.");
                    app.Post(() => { complete = true; window.Close(); });
                }
                using (var deadline = new Timer(_ => PostMessageW(window.Handle, 0x0010, IntPtr.Zero, IntPtr.Zero),
                    null, 5000, Timeout.Infinite))
                {
                    Require(app.Run() == 0, "Windows dispatch failed.");
                }
                animation.Dispose();
                if (failure != null) throw failure;
                Require(activated == 1 && complete && (!animate || timerFaults == 1) && list.Handle == IntPtr.Zero,
                    "Native invocation, timer fault isolation or window disposal failed.");
                Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                    "Vokri native surface: frames={0} p50Ms={1:F3} p95Ms={2:F3} maxMs={3:F3} elapsedMs={4} rows={5} rowReads={6} gdiBefore={7} gdiAfter={8} animation={9}",
                    samples.Count, samples[89], samples[170], samples[179], work.ElapsedMilliseconds, list.Count, reads, baseline, after, animate));
                return 0;
            }
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
