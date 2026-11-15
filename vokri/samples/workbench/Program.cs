using System;
using System.Globalization;
using Vokri;

internal static class Program
{
    private const int Documents = 100000;

    [STAThread]
    private static int Main()
    {
        using (var app = new Application())
        {
            var window = new Window(app, "VOKRI SDK Workbench", new Size(920, 620), new Size(560, 360));
            window.Appearance = Appearance.IrisInkDark;

            var library = new VirtualList("Documents", new Size(232, 300));
            var caption = new Label("Source editor", new Size(200, 24));
            var editor = new TextEditor(new Size(400, 320));
            var status = new Label("100,000 sample documents", new Size(450, 24));
            var changeAppearance = new Button("Switch appearance", new Size(148, 33), false);
            var locate = new Button("Last document", new Size(130, 33), true);
            var resize = new Button("Text size", new Size(92, 33), false);
            var previous = new Button("Previous page", new Size(112, 29), false) { Enabled = false };
            var next = new Button("Next page", new Size(92, 29), false);
            var progress = new Canvas("Status indicator", new Size(86, 5));
            IDisposable animation = null;
            bool large = false;
            double position = 0;

            var actions = new Grid(new[] { Track.Star(), Track.Auto, Track.Auto, Track.Auto }, new[] { Track.Star() }, 8)
                .Add(caption, 0, 0).Add(resize, 1, 0).Add(changeAppearance, 2, 0).Add(locate, 3, 0);
            var output = new Grid(new[] { Track.Auto, Track.Auto, Track.Star(), Track.Auto }, new[] { Track.Star() }, 8)
                .Add(previous, 0, 0).Add(next, 1, 0).Add(status, 2, 0).Add(progress, 3, 0);
            var layout = new Grid(new[] { Track.Star(1), Track.Star(3) },
                new[] { Track.Fixed(34), Track.Star(), Track.Fixed(29) }, 10, 16)
                .Add(actions, 0, 0, 2).Add(library, 0, 1).Add(editor, 1, 1).Add(output, 0, 2, 2);

            Func<int, string> document = index => string.Format(CultureInfo.InvariantCulture, "Field notes {0:000000}", index + 1);
            library.SetRows(Documents, document);
            library.SelectionChanged += () =>
            {
                int index = library.SelectedIndex;
                if (index < 0) return;
                editor.Text = "// " + document(index) + "\n\nconst station = \"North Ridge\";\nconst observations = [12, 14, 15];\n";
                previous.Enabled = library.FirstPageIndex > 0;
                next.Enabled = library.FirstPageIndex + VirtualList.PageSize < library.Count;
                status.Text = document(index) + " opened";
            };
            previous.Clicked += () => { library.MovePage(-1); library.Focus(); };
            next.Clicked += () => { library.MovePage(1); library.Focus(); };
            locate.Clicked += () =>
            {
                library.Select(Documents - 1);
                library.Focus();
                if (animation != null) animation.Dispose();
                animation = window.Animate(elapsed =>
                {
                    position = elapsed == TimeSpan.Zero ? 1 : Math.Min(1, elapsed.TotalMilliseconds / 420);
                    progress.Invalidate();
                    if (position == 1 && animation != null) animation.Dispose();
                });
            };
            changeAppearance.Clicked += () =>
            {
                window.Appearance = window.Appearance == Appearance.IrisInkDark ? Appearance.IrisInkLight :
                    window.Appearance == Appearance.IrisInkLight ? Appearance.MidnightAtelier : Appearance.IrisInkDark;
                progress.Invalidate();
            };
            resize.Clicked += () => { large = !large; window.SetFontSizes(large ? 18 : 14, large ? 21 : 15); };
            progress.Paint += draw =>
            {
                var height = draw.Bounds.Height;
                var width = draw.Bounds.Width;
                draw.Fill(new Rect(0, height / 2, width, 3), window.Colors.Surface);
                draw.Fill(new Rect(0, height / 2, (int)(width * position), 3), window.Colors.Accent);
            };
            window.BindShortcut(0x75, Modifiers.None, () => editor.Focus()); // F6
            window.BindShortcut(0x76, Modifiers.None, () => library.Focus()); // F7
            window.SetContent(layout);
            window.Show();
            library.Select(0);
            library.Focus();
            return app.Run();
        }
    }
}
