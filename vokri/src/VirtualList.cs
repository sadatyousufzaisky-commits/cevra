using System;
using System.Runtime.InteropServices;

namespace Vokri
{
    public sealed class VirtualList : Control
    {
        private const int MaxRows = 100000000;
        public const int PageSize = 64;
        private readonly string heading;
        private readonly Native.SubclassProcedure keyboard;
        private int count, pageStart, selected = -1;
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
            keyboard = KeyboardMessage;
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
            if (!Native.SetWindowSubclass(Handle, keyboard, UIntPtr.Zero, UIntPtr.Zero))
                throw new InvalidOperationException("Could not register virtual-list input.");
            AppearanceChanged();
            LoadPage(0);
        }

        public event Action SelectionChanged;
        public int Count { get { return count; } }
        public int FirstPageIndex { get { return pageStart; } }
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
            if (Handle != IntPtr.Zero) LoadPage(0);
        }

        private void LoadPage(int first)
        {
            bool wasChanging = changing;
            changing = true;
            try
            {
                pageStart = first;
                SetNativeCount(0); // Drops selection, cached rows, and scroll position.
                SetNativeCount(Math.Min(PageSize, count - first));
                Native.InvalidateRect(Handle, IntPtr.Zero, false);
            }
            finally { changing = wasChanging; }
        }

        private void SetNativeCount(int visibleCount)
        {
            if (Native.Send(Handle, 0x102f, new IntPtr(visibleCount), IntPtr.Zero) == IntPtr.Zero)
                throw new InvalidOperationException("Could not set the virtual list row count.");
        }

        public void Select(int index)
        {
            VerifyAccess();
            if (index < 0 || index >= count) throw new ArgumentOutOfRangeException("index");
            if (Handle == IntPtr.Zero || changing) throw new InvalidOperationException("Select a row after attaching the list.");
            changing = true;
            try
            {
                int first = index / PageSize * PageSize;
                if (first != pageStart) LoadPage(first);
                var localIndex = new IntPtr(index - pageStart);
                if (SendData(0x102b, localIndex, new Item { State = 3, StateMask = 3 }) == IntPtr.Zero)
                    throw new InvalidOperationException("Could not select the virtual list row.");
                Native.Send(Handle, 0x1013, localIndex, IntPtr.Zero); // LVM_ENSUREVISIBLE
            }
            finally { changing = false; }
            ReadSelection();
        }

        private void ReadSelection()
        {
            if (changing) return;
            int local = Native.Send(Handle, 0x100c, new IntPtr(-1), new IntPtr(2)).ToInt32(); // LVNI_SELECTED
            int index = local < 0 ? -1 : pageStart + local;
            if (index == selected) return;
            selected = index;
            if (SelectionChanged != null) SelectionChanged();
        }

        public void MovePage(int direction)
        {
            VerifyAccess();
            if (direction != -1 && direction != 1) throw new ArgumentOutOfRangeException("direction");
            int next = pageStart + direction * PageSize;
            if (next >= 0 && next < count) Select(next);
        }

        private IntPtr KeyboardMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, UIntPtr id, UIntPtr data)
        {
            if (message == Native.KeyDown && count > 0)
            {
                int key = wParam.ToInt32();
                int lastInPage = Math.Min(count, pageStart + PageSize) - 1;
                int destination = -1;
                if (key == 0x24) destination = 0; // Home
                else if (key == 0x23) destination = count - 1; // End
                else if (key == 0x28 && selected == lastInPage && selected < count - 1) destination = selected + 1;
                else if (key == 0x26 && selected == pageStart && pageStart > 0) destination = selected - 1;
                else if (key == 0x22 && selected == lastInPage && lastInPage + 1 < count) destination = lastInPage + 1;
                else if (key == 0x21 && selected == pageStart && pageStart > 0) destination = pageStart - 1;
                if (destination >= 0)
                {
                    try { Select(destination); } catch (Exception error) { Host.Application.Report(error); }
                    return IntPtr.Zero;
                }
            }
            else if (message == 0x0082) Native.RemoveWindowSubclass(window, keyboard, id);
            return Native.DefSubclassProc(window, message, wParam, lParam);
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
                    int index = pageStart + item.Index;
                    string text = item.Index >= 0 && item.Index < PageSize && index < count && row != null ? row(index) ?? "" : "";
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
