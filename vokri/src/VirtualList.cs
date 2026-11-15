using System;
using System.Runtime.InteropServices;

namespace Vokri
{
    public sealed class VirtualList : Control
    {
        private const int MaxRows = 100000000;
        private readonly string heading;
        private int count, selected = -1;
        private Func<int, string> row;
        private bool changing;

        [StructLayout(LayoutKind.Sequential)]
        private struct Column
        {
            internal uint Mask;
            internal int Format, Width;
            internal IntPtr Text;
            internal int Capacity, SubItem, Image, Order, MinWidth, DefaultWidth, IdealWidth;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Item
        {
            internal uint Mask;
            internal int Index, SubItem;
            internal uint State, StateMask;
            internal IntPtr Text;
            internal int Capacity, Image;
            internal IntPtr Param;
            internal int Indent, Group;
            internal uint ColumnCount;
            internal IntPtr Columns, Formats;
            internal int GroupIndex;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DisplayInfo { internal Native.NotifyHeader Header; internal Item Item; }

        public VirtualList(string heading, Size preferred) : base(preferred)
        {
            if (string.IsNullOrWhiteSpace(heading) || heading.IndexOf('\0') >= 0)
                throw new ArgumentException("Give the list a column heading.", "heading");
            this.heading = heading;
        }

        internal override string ClassName { get { return "SysListView32"; } }
        internal override string Caption { get { return heading; } }
        internal override uint Style { get { return Native.TabStop | 0x900d; } } // Report, single selection, show selection, owner data, fixed header.
        internal override void BeforeCreate() { Host.Application.EnsureListView(); }

        internal override void Created()
        {
            Native.Send(Handle, 0x2005, new IntPtr(1), IntPtr.Zero); // CCM_SETUNICODEFORMAT
            Native.Send(Handle, 0x1036, new IntPtr(0x10020), new IntPtr(0x10020)); // Full-row selection and double buffering.
            IntPtr title = Marshal.StringToHGlobalUni(heading);
            try
            {
                var column = new Column { Mask = 6, Width = Host.Scale(PreferredSize.Width), Text = title };
                if (SendData(0x1061, IntPtr.Zero, column).ToInt64() < 0)
                    throw new InvalidOperationException("Could not create the virtual list column.");
            }
            finally { Marshal.FreeHGlobal(title); }
            AppearanceChanged();
            UpdateCount();
        }

        public event Action SelectionChanged;
        public int Count { get { return count; } }
        public int SelectedIndex { get { VerifyAccess(); return selected; } }

        public void SetRows(int count, Func<int, string> row)
        {
            VerifyAccess();
            if (count < 0 || count > MaxRows) throw new ArgumentOutOfRangeException("count");
            if (row == null) throw new ArgumentNullException("row");
            if (changing) throw new InvalidOperationException("Do not mutate the list while handling a list notification.");
            this.count = count;
            this.row = row;
            selected = -1;
            if (Handle != IntPtr.Zero) UpdateCount();
        }

        private void UpdateCount()
        {
            changing = true;
            try
            {
                SendData(0x102b, new IntPtr(-1), new Item { StateMask = 3 });
                if (Native.Send(Handle, 0x102f, new IntPtr(count), IntPtr.Zero) == IntPtr.Zero)
                    throw new InvalidOperationException("Could not set the virtual list row count.");
                Native.InvalidateRect(Handle, IntPtr.Zero, false);
            }
            finally { changing = false; }
        }

        public void Select(int index)
        {
            VerifyAccess();
            if (index < 0 || index >= count) throw new ArgumentOutOfRangeException("index");
            if (Handle == IntPtr.Zero || changing) throw new InvalidOperationException("Select a row after attaching the list.");
            changing = true;
            try
            {
                SendData(0x102b, new IntPtr(index), new Item { State = 3, StateMask = 3 });
                Native.Send(Handle, 0x1013, new IntPtr(index), IntPtr.Zero); // LVM_ENSUREVISIBLE
            }
            finally { changing = false; }
            ReadSelection();
        }

        private void ReadSelection()
        {
            if (changing) return;
            int index = Native.Send(Handle, 0x100c, new IntPtr(-1), new IntPtr(2)).ToInt32(); // LVNI_SELECTED
            if (index == selected) return;
            selected = index;
            if (SelectionChanged != null) SelectionChanged();
        }

        internal override IntPtr Notify(int code, IntPtr data)
        {
            if (code == -101 || code == -115) ReadSelection();
            if (code == -179) return new IntPtr(-1); // No implicit search through an arbitrarily large data source.
            if (code == -177)
            {
                var info = (DisplayInfo)Marshal.PtrToStructure(data, typeof(DisplayInfo));
                var item = info.Item;
                if ((item.Mask & 1) != 0 && item.Text != IntPtr.Zero && item.Capacity > 0)
                {
                    Marshal.WriteInt16(item.Text, 0);
                    string text = item.Index >= 0 && item.Index < count && row != null ? row(item.Index) ?? "" : "";
                    int length = Math.Min(text.Length, item.Capacity - 1);
                    if (length > 0 && char.IsHighSurrogate(text[length - 1])) length--;
                    for (int i = 0; i < length; i++) Marshal.WriteInt16(item.Text, i * 2, unchecked((short)text[i]));
                    Marshal.WriteInt16(item.Text, length * 2, 0);
                }
            }
            return IntPtr.Zero;
        }

        internal override void OnArrange(Rect bounds)
        {
            base.OnArrange(bounds);
            Native.Send(Handle, 0x101e, IntPtr.Zero, new IntPtr(-2)); // LVSCW_AUTOSIZE_USEHEADER fills the final column.
        }

        internal override void AppearanceChanged()
        {
            var colors = Host.Colors;
            Native.Send(Handle, 0x1001, IntPtr.Zero, new IntPtr(colors.Background.Value));
            Native.Send(Handle, 0x1024, IntPtr.Zero, new IntPtr(colors.Text.Value));
            Native.Send(Handle, 0x1026, IntPtr.Zero, new IntPtr(colors.Background.Value));
            Native.InvalidateRect(Handle, IntPtr.Zero, false);
        }

        private IntPtr SendData<T>(uint message, IntPtr index, T value) where T : struct
        {
            IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T)));
            try
            {
                Marshal.StructureToPtr(value, buffer, false);
                return Native.Send(Handle, message, index, buffer);
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }
}
