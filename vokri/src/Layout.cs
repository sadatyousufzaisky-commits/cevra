using System;
using System.Collections.Generic;

namespace Vokri
{
    public struct Size
    {
        public readonly int Width, Height;
        public Size(int width, int height)
        {
            if (width < 0 || height < 0 || width > 65535 || height > 65535) throw new ArgumentOutOfRangeException("size");
            Width = width;
            Height = height;
        }
    }

    public struct Rect
    {
        public readonly int X, Y, Width, Height;
        public Rect(int x, int y, int width, int height)
        {
            X = x;
            Y = y;
            Width = Math.Max(0, width);
            Height = Math.Max(0, height);
        }
    }

    public struct Track
    {
        internal readonly int Kind, Value;
        private Track(int kind, int value) { Kind = kind; Value = value; }
        public static Track Auto { get { return new Track(0, 0); } }
        public static Track Fixed(int dip)
        {
            if (dip < 0 || dip > 65535) throw new ArgumentOutOfRangeException("dip");
            return new Track(1, dip);
        }
        public static Track Star(int weight = 1)
        {
            if (weight < 1 || weight > 1000) throw new ArgumentOutOfRangeException("weight");
            return new Track(2, weight);
        }
    }

    public abstract class Element
    {
        internal Element Parent;
        internal Window Host { get; private set; }
        public Rect Bounds { get; private set; }
        public abstract Size PreferredSize { get; }

        internal void Attach(Window window)
        {
            if (Host != null) throw new InvalidOperationException("The element already belongs to a window.");
            Host = window;
            OnAttach();
        }

        internal void Arrange(Rect bounds)
        {
            Bounds = bounds;
            OnArrange(bounds);
        }

        internal abstract void OnAttach();
        internal abstract void OnArrange(Rect bounds);
    }

    public sealed class Grid : Element
    {
        private sealed class Cell
        {
            internal Element Content;
            internal int Column, Row, ColumnSpan, RowSpan;
        }

        private readonly Track[] columns, rows;
        private readonly List<Cell> cells = new List<Cell>();
        private readonly int gap, padding;

        public Grid(Track[] columns, Track[] rows, int gap = 0, int padding = 0)
        {
            if (columns == null || rows == null || columns.Length < 1 || rows.Length < 1 ||
                columns.Length > 128 || rows.Length > 128) throw new ArgumentException("A grid requires 1–128 rows and columns.");
            if (gap < 0 || gap > 256 || padding < 0 || padding > 256) throw new ArgumentOutOfRangeException("spacing");
            this.columns = (Track[])columns.Clone();
            this.rows = (Track[])rows.Clone();
            this.gap = gap;
            this.padding = padding;
        }

        public Grid Add(Element content, int column, int row, int columnSpan = 1, int rowSpan = 1)
        {
            if (Host != null) throw new InvalidOperationException("Build the grid before attaching it.");
            if (content == null || content.Parent != null || content.Host != null) throw new ArgumentException("Use an unattached element.");
            for (Element ancestor = this; ancestor != null; ancestor = ancestor.Parent)
                if (ancestor == content) throw new ArgumentException("A grid cannot contain itself.");
            if (column < 0 || row < 0 || columnSpan < 1 || rowSpan < 1 ||
                columnSpan > columns.Length - column || rowSpan > rows.Length - row)
                throw new ArgumentOutOfRangeException("cell");
            foreach (var cell in cells)
                if (column < cell.Column + cell.ColumnSpan && cell.Column < column + columnSpan &&
                    row < cell.Row + cell.RowSpan && cell.Row < row + rowSpan)
                    throw new ArgumentException("Grid cells cannot overlap.");
            content.Parent = this;
            cells.Add(new Cell { Content = content, Column = column, Row = row, ColumnSpan = columnSpan, RowSpan = rowSpan });
            return this;
        }

        private int[] Preferred(bool horizontal)
        {
            Track[] tracks = horizontal ? columns : rows;
            var sizes = new int[tracks.Length];
            for (int i = 0; i < sizes.Length; i++)
                if (tracks[i].Kind == 1) sizes[i] = tracks[i].Value;
            foreach (var cell in cells)
            {
                int start = horizontal ? cell.Column : cell.Row;
                int count = horizontal ? cell.ColumnSpan : cell.RowSpan;
                if (count != 1 || tracks[start].Kind == 1) continue;
                var preferred = cell.Content.PreferredSize;
                sizes[start] = Math.Max(sizes[start], horizontal ? preferred.Width : preferred.Height);
            }
            return sizes;
        }

        private int Sum(int[] tracks, int first, int span)
        {
            int value = gap * (span - 1);
            for (int i = first; i < first + span; i++) value += tracks[i];
            return value;
        }

        public override Size PreferredSize
        {
            get
            {
                return new Size(Math.Min(65535, padding * 2 + Sum(Preferred(true), 0, columns.Length)),
                    Math.Min(65535, padding * 2 + Sum(Preferred(false), 0, rows.Length)));
            }
        }

        private int[] Allocate(bool horizontal, int available)
        {
            Track[] tracks = horizontal ? columns : rows;
            int[] sizes = Preferred(horizontal);
            int remaining = Math.Max(0, available - padding * 2 - gap * (tracks.Length - 1));
            int weights = 0;
            for (int i = 0; i < tracks.Length; i++)
            {
                if (tracks[i].Kind == 2) { weights += tracks[i].Value; continue; }
                sizes[i] = Math.Min(sizes[i], remaining);
                remaining -= sizes[i];
            }
            long consumed = 0;
            int used = 0;
            for (int i = 0; i < tracks.Length; i++)
            {
                if (tracks[i].Kind != 2) continue;
                consumed += tracks[i].Value;
                int end = (int)(remaining * consumed / weights);
                sizes[i] = end - used;
                used = end;
            }
            return sizes;
        }

        internal override void OnAttach()
        {
            foreach (var cell in cells) cell.Content.Attach(Host);
        }

        internal override void OnArrange(Rect bounds)
        {
            int[] widths = Allocate(true, bounds.Width);
            int[] heights = Allocate(false, bounds.Height);
            foreach (var cell in cells)
            {
                int x = bounds.X + padding + (cell.Column == 0 ? 0 : Sum(widths, 0, cell.Column) + gap);
                int y = bounds.Y + padding + (cell.Row == 0 ? 0 : Sum(heights, 0, cell.Row) + gap);
                int width = Math.Min(Sum(widths, cell.Column, cell.ColumnSpan), Math.Max(0, bounds.X + bounds.Width - padding - x));
                int height = Math.Min(Sum(heights, cell.Row, cell.RowSpan), Math.Max(0, bounds.Y + bounds.Height - padding - y));
                cell.Content.Arrange(new Rect(x, y, width, height));
            }
        }
    }
}
