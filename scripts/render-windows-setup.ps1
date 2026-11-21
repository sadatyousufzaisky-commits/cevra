param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$brand = [Drawing.Image]::FromFile((Join-Path $PSScriptRoot '../assets/brand/vc.png'))
$ink = [Drawing.Color]::FromArgb(28, 24, 51)
$iris = [Drawing.Color]::FromArgb(65, 48, 108)
$paper = [Drawing.Color]::FromArgb(250, 249, 253)

function Save-Art([string]$Name, [int]$Height, [Drawing.Rectangle]$Panel, [Drawing.Rectangle]$Mark) {
    $bitmap = [Drawing.Bitmap]::new(493, $Height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $brush = [Drawing.Drawing2D.LinearGradientBrush]::new($Panel, $ink, $iris, 52.0)
    try {
        $graphics.Clear($paper)
        $graphics.FillRectangle($brush, $Panel)
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($brand, $Mark)
        $bitmap.Save((Join-Path $Output $Name), [Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $brush.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}
try {
    Save-Art 'banner.bmp' 58 ([Drawing.Rectangle]::new(414, 0, 79, 58)) ([Drawing.Rectangle]::new(431, 7, 45, 45))
    Save-Art 'dialog.bmp' 312 ([Drawing.Rectangle]::new(0, 0, 163, 312)) ([Drawing.Rectangle]::new(23, 97, 117, 117))
} finally { $brand.Dispose() }
