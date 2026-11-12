using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Vokri
{
    public abstract class Control : Element
    {
        private bool enabled = true, visible = true;
        private readonly Size preferred;
        public IntPtr Handle { get; private set; }
        public override Size PreferredSize { get { return preferred; } }

        protected Control(Size preferred) { this.preferred = preferred; }
        internal abstract string ClassName { get; }
        internal virtual uint Style { get { return 0; } }
        internal virtual uint Extended { get { return 0; } }
        internal virtual string Caption { get { return ""; } }
        internal virtual bool Monospace { get { return false; } }

        protected void VerifyAccess() { if (Host != null) Host.VerifyOpen(); }

        public bool Enabled
        {
            get { return enabled; }
            set { VerifyAccess(); enabled = value; if (Handle != IntPtr.Zero) Native.EnableWindow(Handle, enabled); }
        }

        public bool Visible
        {
            get { return visible; }
            set { VerifyAccess(); visible = value; if (Handle != IntPtr.Zero) UpdateVisibility(); }
        }

        public void Focus() { VerifyAccess(); if (Handle != IntPtr.Zero && enabled) Native.SetFocus(Handle); }

        internal override void OnAttach()
        {
            BeforeCreate();
            Handle = Native.Require(Native.CreateWindowExW(Extended, ClassName, Caption,
                Native.Child | Native.ClipSiblings | Style, 0, 0, 0, 0,
                Host.Handle, Host.NextControlId, Host.Application.Instance, IntPtr.Zero));
            Host.Register(this);
            Native.EnableWindow(Handle, enabled);
            ApplyFont();
            Created();
        }

        internal virtual void BeforeCreate() {}
        internal virtual void Created() {}
        internal virtual void Command(int code) {}
        internal void Detach() { Handle = IntPtr.Zero; }
        internal void ApplyFont() { Native.Send(Handle, Native.SetFont, Host.Font(Monospace), new IntPtr(1)); }

        private void UpdateVisibility()
        {
            Native.ShowWindow(Handle, visible && Bounds.Width > 0 && Bounds.Height > 0 ? 5 : 0);
        }

        internal override void OnArrange(Rect bounds)
        {
            int x = Host.Scale(bounds.X), y = Host.Scale(bounds.Y);
            Native.SetWindowPos(Handle, IntPtr.Zero, x, y,
                Host.Scale(bounds.X + bounds.Width) - x, Host.Scale(bounds.Y + bounds.Height) - y, 0x14);
            UpdateVisibility();
        }

        protected void SetText(string text)
        {
            VerifyAccess();
            if (Handle != IntPtr.Zero && !Native.SetWindowTextW(Handle, text)) throw new Win32Exception();
        }

        protected string GetText()
        {
            VerifyAccess();
            var value = new StringBuilder(Native.GetWindowTextLengthW(Handle) + 1);
            Native.GetWindowTextW(Handle, value, value.Capacity);
            return value.ToString();
        }
    }

    public sealed class Label : Control
    {
        private string text;
        public Label(string text, Size preferred) : base(preferred) { this.text = text ?? ""; }
        internal override string ClassName { get { return "STATIC"; } }
        internal override uint Style { get { return 0x0080 | 0x000c; } } // SS_NOPREFIX | SS_LEFTNOWORDWRAP
        internal override string Caption { get { return text; } }
        public string Text
        {
            get { return text; }
            set { SetText(value ?? ""); text = value ?? ""; }
        }
    }

    public sealed class Button : Control
    {
        private string text;
        public Button(string text, Size preferred) : base(preferred) { this.text = text ?? ""; }
        internal override string ClassName { get { return "BUTTON"; } }
        internal override uint Style { get { return Native.TabStop; } }
        internal override string Caption { get { return text; } }
        public event Action Clicked;
        public string Text
        {
            get { return text; }
            set { SetText(value ?? ""); text = value ?? ""; }
        }
        internal override void Command(int code)
        {
            if (code == 0 && Enabled && Visible && Clicked != null) Clicked();
        }
    }

    public sealed class TextField : Control
    {
        private string initial = "";
        private readonly int limit;
        public TextField(Size preferred, int limit = 4096) : base(preferred)
        {
            if (limit < 1 || limit > 65535) throw new ArgumentOutOfRangeException("limit");
            this.limit = limit;
        }
        internal override string ClassName { get { return "EDIT"; } }
        internal override uint Style { get { return Native.TabStop | 0x0080; } }
        internal override uint Extended { get { return 0x0200; } }
        internal override string Caption { get { return initial; } }
        internal override void Created() { Native.Send(Handle, 0x00c5, new IntPtr(limit), IntPtr.Zero); }
        public event Action Changed;
        public string Text
        {
            get { return Handle == IntPtr.Zero ? initial : GetText(); }
            set
            {
                value = value ?? "";
                if (value.Length > limit || value.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0)
                    throw new ArgumentException("Use a single line within the text limit.");
                SetText(value);
                initial = value;
            }
        }
        internal override void Command(int code) { if (code == 0x0300 && Changed != null) Changed(); }
    }

    public sealed class TextEditor : Control
    {
        private const int Limit = 2 * 1024 * 1024;
        private string initial = "";
        private bool readOnly;
        public TextEditor(Size preferred, bool readOnly = false) : base(preferred) { this.readOnly = readOnly; }
        internal override string ClassName { get { return "RICHEDIT50W"; } }
        internal override uint Style { get { return Native.TabStop | Native.HScroll | Native.VScroll | 0x01c4; } }
        internal override uint Extended { get { return 0x0200; } }
        internal override bool Monospace { get { return true; } }
        internal override void BeforeCreate() { Host.Application.EnsureRichEdit(); }
        internal override void Created()
        {
            Native.Send(Handle, 0x0459, new IntPtr(5), IntPtr.Zero); // EM_SETTEXTMODE, plaintext with multi-level undo
            Native.Send(Handle, 0x0435, IntPtr.Zero, new IntPtr(Limit));
            Native.Send(Handle, 0x0445, IntPtr.Zero, new IntPtr(1)); // ENM_CHANGE
            ReadOnly = readOnly;
            if (initial.Length != 0) Text = initial;
        }

        public bool ReadOnly
        {
            get { return readOnly; }
            set
            {
                VerifyAccess();
                readOnly = value;
                if (Handle != IntPtr.Zero) Native.Send(Handle, 0x00cf, value ? new IntPtr(1) : IntPtr.Zero, IntPtr.Zero);
            }
        }

        public event Action Changed;
        public string Text
        {
            get
            {
                if (Handle == IntPtr.Zero) return initial;
                VerifyAccess();
                var length = new Native.TextLength { Flags = 0x000a, CodePage = 1200 };
                int count = Native.SendTextLength(Handle, 0x045f, ref length, IntPtr.Zero).ToInt32();
                if (count < 0 || count > Limit) throw new InvalidOperationException("The text control returned an invalid length.");
                var options = new Native.TextBuffer { Bytes = (uint)((count + 1) * 2), CodePage = 1200 };
                IntPtr buffer = Marshal.AllocHGlobal((int)options.Bytes);
                try
                {
                    int written = Native.SendTextBuffer(Handle, 0x045e, ref options, buffer).ToInt32();
                    if (written < 0 || written > count) throw new InvalidOperationException("The text control returned invalid text.");
                    return Marshal.PtrToStringUni(buffer, written).Replace('\r', '\n');
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            set
            {
                value = (value ?? "").Replace("\r\n", "\n").Replace('\r', '\n');
                if (value.Length > Limit || value.IndexOf('\0') >= 0) throw new ArgumentException("Use text within the editor limit.");
                SetText(value.Replace("\n", "\r\n"));
                initial = value;
            }
        }

        public void GoTo(int line, int column)
        {
            VerifyAccess();
            if (Handle == IntPtr.Zero) return;
            if (line < 1 || column < 1) throw new ArgumentOutOfRangeException("location");
            string text = Text;
            int start = 0;
            for (int row = 1; row < line && start < text.Length; row++)
            {
                int next = text.IndexOf('\n', start);
                start = next < 0 ? text.Length : next + 1;
            }
            int end = text.IndexOf('\n', start);
            if (end < 0) end = text.Length;
            int offset = start + Math.Min(column - 1, end - start);
            Native.Send(Handle, 0x00b1, new IntPtr(offset), new IntPtr(offset));
            Native.Send(Handle, 0x00b7, IntPtr.Zero, IntPtr.Zero);
            Focus();
        }

        internal override void Command(int code) { if (code == 0x0300 && Changed != null) Changed(); }
    }

    public sealed class ListBox : Control
    {
        private string[] items = new string[0];
        public ListBox(Size preferred) : base(preferred) {}
        internal override string ClassName { get { return "LISTBOX"; } }
        internal override uint Style { get { return Native.TabStop | Native.VScroll | 0x0101; } }
        internal override uint Extended { get { return 0x0200; } }
        public event Action SelectionChanged;
        public event Action Activated;
        internal override void Created() { Update(); }

        public void SetItems(IEnumerable<string> entries)
        {
            VerifyAccess();
            if (entries == null) throw new ArgumentNullException("entries");
            var next = new List<string>();
            foreach (var item in entries)
            {
                if (next.Count == 4096 || item == null || item.Length > 2048 || item.IndexOf('\0') >= 0)
                    throw new ArgumentException("Use up to 4,096 valid list labels.");
                next.Add(item);
            }
            items = next.ToArray();
            if (Handle != IntPtr.Zero) Update();
        }

        private void Update()
        {
            Native.Send(Handle, 0x000b, IntPtr.Zero, IntPtr.Zero);
            try
            {
                Native.Send(Handle, 0x0184, IntPtr.Zero, IntPtr.Zero);
                foreach (string item in items)
                    if (Native.SendString(Handle, 0x0180, IntPtr.Zero, item).ToInt64() < 0)
                        throw new InvalidOperationException("The list could not display an item.");
            }
            finally
            {
                Native.Send(Handle, 0x000b, new IntPtr(1), IntPtr.Zero);
                Native.InvalidateRect(Handle, IntPtr.Zero, true);
            }
        }

        public int SelectedIndex
        {
            get { VerifyAccess(); return Handle == IntPtr.Zero ? -1 : Native.Send(Handle, 0x0188, IntPtr.Zero, IntPtr.Zero).ToInt32(); }
            set
            {
                VerifyAccess();
                if (value < -1 || value >= items.Length) throw new ArgumentOutOfRangeException("value");
                if (Handle != IntPtr.Zero) Native.Send(Handle, 0x0186, new IntPtr(value), IntPtr.Zero);
            }
        }

        internal override void Command(int code)
        {
            if (!Enabled || !Visible) return;
            if (code == 1 && SelectionChanged != null) SelectionChanged();
            if (code == 2 && Activated != null) Activated();
        }
    }
}
