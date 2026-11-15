using System;
using System.Runtime.InteropServices;

namespace Vokri
{
    public enum Appearance { System, IrisInkDark, IrisInkLight, MidnightAtelier }

    public sealed class Palette
    {
        public Color Background { get; private set; }
        public Color Surface { get; private set; }
        public Color Border { get; private set; }
        public Color Text { get; private set; }
        public Color Muted { get; private set; }
        public Color Accent { get; private set; }
        public Color AccentText { get; private set; }
        public Color Error { get; private set; }
        public Color Pressed { get; private set; }
        public Color Hover { get; private set; }
        public Color PrimaryHover { get; private set; }
        public Color PrimaryPressed { get; private set; }
        public Color DisabledFill { get; private set; }
        public Color DisabledText { get; private set; }

        private static readonly Palette InkDark = new Palette {
            Background = Color.Rgb(19, 19, 23), Surface = Color.Rgb(32, 32, 39), Border = Color.Rgb(141, 136, 165),
            Text = Color.Rgb(240, 243, 251), Muted = Color.Rgb(171, 177, 202),
            Accent = Color.Rgb(176, 166, 255), AccentText = Color.Rgb(33, 24, 62), Error = Color.Rgb(255, 162, 158),
            Pressed = Color.Rgb(61, 54, 88), PrimaryPressed = Color.Rgb(154, 141, 242),
            Hover = Color.Rgb(48, 48, 70), PrimaryHover = Color.Rgb(197, 189, 255),
            DisabledFill = Color.Rgb(34, 34, 49), DisabledText = Color.Rgb(133, 133, 158),
        };
        private static readonly Palette InkLight = new Palette {
            Background = Color.Rgb(255, 255, 255), Surface = Color.Rgb(233, 232, 239), Border = Color.Rgb(109, 100, 139),
            Text = Color.Rgb(34, 33, 58), Muted = Color.Rgb(84, 84, 110),
            Accent = Color.Rgb(87, 64, 184), AccentText = Color.Rgb(255, 255, 255), Error = Color.Rgb(146, 44, 53),
            Pressed = Color.Rgb(206, 196, 233), PrimaryPressed = Color.Rgb(55, 36, 123),
            Hover = Color.Rgb(221, 217, 239), PrimaryHover = Color.Rgb(68, 48, 149),
            DisabledFill = Color.Rgb(233, 232, 241), DisabledText = Color.Rgb(103, 103, 124),
        };
        private static readonly Palette Midnight = CreateMidnight();

        private static Palette CreateMidnight()
        {
            var palette = (Palette)InkDark.MemberwiseClone();
            palette.Background = Color.Rgb(17, 17, 28);
            palette.Surface = Color.Rgb(37, 37, 57);
            return palette;
        }

        public static bool HighContrast
        {
            get
            {
                var settings = new Native.HighContrast { Size = (uint)Marshal.SizeOf(typeof(Native.HighContrast)) };
                return Native.ReadHighContrast(0x0042, settings.Size, ref settings, 0) && (settings.Flags & 1) != 0;
            }
        }

        public static Palette Resolve(Appearance appearance)
        {
            if (!Enum.IsDefined(typeof(Appearance), appearance)) throw new ArgumentOutOfRangeException("appearance");
            if (appearance == Appearance.System || HighContrast)
            {
                return new Palette {
                    Background = Color.Window, Surface = Color.System(15), Border = Color.System(18),
                    Text = Color.Text, Muted = Color.Text, Accent = Color.System(13), AccentText = Color.System(14),
                    Error = Color.Text, Pressed = Color.System(15), PrimaryPressed = Color.System(13),
                    Hover = Color.System(15), PrimaryHover = Color.System(13),
                    DisabledFill = Color.System(15), DisabledText = Color.System(17),
                };
            }
            if (appearance == Appearance.IrisInkLight) return InkLight;
            if (appearance == Appearance.MidnightAtelier) return Midnight;
            return InkDark;
        }
    }
}
