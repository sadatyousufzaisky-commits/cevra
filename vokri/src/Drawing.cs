using System;

namespace Vokri
{
    public struct Color
    {
        internal readonly uint Value;
        private Color(uint value) { Value = value; }
        public static Color Rgb(byte red, byte green, byte blue) { return new Color((uint)(red | green << 8 | blue << 16)); }
        public static Color Window { get { return new Color(Native.GetSysColor(Native.WindowColor)); } }
        public static Color Text { get { return new Color(Native.GetSysColor(Native.WindowTextColor)); } }
    }

    public sealed class DrawingContext
    {
        private readonly Window host;
        private IntPtr dc;
        public Rect Bounds { get; private set; }
        internal DrawingContext(Window host, IntPtr dc, Rect bounds) { this.host = host; this.dc = dc; Bounds = bounds; }
        internal void Expire() { dc = IntPtr.Zero; }

        private void Check()
        {
            host.VerifyOpen();
            if (dc == IntPtr.Zero) throw new InvalidOperationException("Draw during the canvas Paint event.");
        }

        private Native.Rectangle Pixels(Rect bounds)
        {
            return new Native.Rectangle { Left = host.Scale(bounds.X), Top = host.Scale(bounds.Y),
                Right = host.Scale(bounds.X + bounds.Width), Bottom = host.Scale(bounds.Y + bounds.Height) };
        }

        public void Fill(Rect bounds, Color color)
        {
            Check();
            var rectangle = Pixels(bounds);
            IntPtr brush = Native.Require(Native.CreateSolidBrush(color.Value));
            try { Native.FillRect(dc, ref rectangle, brush); }
            finally { Native.DeleteObject(brush); }
        }

        public void Line(int x1, int y1, int x2, int y2, Color color, int width = 1)
        {
            Check();
            if (width < 1 || width > 256) throw new ArgumentOutOfRangeException("width");
            IntPtr pen = Native.Require(Native.CreatePen(0, Math.Max(1, host.Scale(width)), color.Value));
            IntPtr previous = Native.SelectObject(dc, pen);
            try
            {
                Native.MoveToEx(dc, host.Scale(x1), host.Scale(y1), IntPtr.Zero);
                Native.LineTo(dc, host.Scale(x2), host.Scale(y2));
            }
            finally { Native.SelectObject(dc, previous); Native.DeleteObject(pen); }
        }

        public void Text(string text, Rect bounds, Color color)
        {
            Check();
            if (text == null) throw new ArgumentNullException("text");
            var rectangle = Pixels(bounds);
            IntPtr previous = Native.SelectObject(dc, host.Font(false));
            try
            {
                Native.SetBkMode(dc, 1);
                Native.SetTextColor(dc, color.Value);
                Native.DrawTextW(dc, text, text.Length, ref rectangle, 0x0800 | 0x0010);
            }
            finally { Native.SelectObject(dc, previous); }
        }
    }

    public sealed class Canvas : Control
    {
        private readonly string name;
        public Canvas(string name, Size preferred) : base(preferred)
        {
            if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("Give the canvas an accessible name.");
            this.name = name;
        }
        internal override string ClassName { get { return Application.CanvasClass; } }
        internal override string Caption { get { return name; } }
        internal override void Created() { Host.Application.Register(this); }
        public event Action<DrawingContext> Paint;
        public event Action<int, int> Pressed;
        public void Invalidate()
        {
            VerifyAccess();
            if (Handle != IntPtr.Zero) Native.InvalidateRect(Handle, IntPtr.Zero, false);
        }

        internal IntPtr Message(uint message, IntPtr wParam, IntPtr lParam)
        {
            switch (message)
            {
                case Native.Paint:
                    Native.PaintInfo paint;
                    IntPtr dc = Native.BeginPaint(Handle, out paint);
                    var context = new DrawingContext(Host, dc, new Rect(0, 0, Bounds.Width, Bounds.Height));
                    try
                    {
                        context.Fill(context.Bounds, Color.Window);
                        if (Paint != null) Paint(context);
                    }
                    finally { context.Expire(); Native.EndPaint(Handle, ref paint); }
                    return IntPtr.Zero;
                case Native.MouseDown:
                    if (Pressed != null) Pressed(Host.Unscale((short)Native.Low(lParam)), Host.Unscale((short)Native.High(lParam)));
                    return IntPtr.Zero;
                case 0x0082:
                    Host.Application.Remove(this);
                    break;
            }
            return Native.DefWindowProcW(Handle, message, wParam, lParam);
        }
    }
}
