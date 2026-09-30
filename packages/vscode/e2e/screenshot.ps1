# Captures the VS Code window whose title contains -TitleMatch to -Out (PNG), optionally
# cropped to -Crop "x,y,w,h" in window pixels. PrintWindow with PW_RENDERFULLCONTENT (2)
# reads Chromium's composited surface, so the window need not be unobscured.
param(
  [Parameter(Mandatory)] [string] $Out,
  [string] $TitleMatch = "Extension Development Host",
  [string] $Crop = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[void][Win]::SetProcessDPIAware()
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$TitleMatch*" } | Select-Object -First 1
if (-not $proc) { throw "no window titled like '$TitleMatch'" }
$rect = New-Object Win+RECT
[void][Win]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
$w = $rect.R - $rect.L; $h = $rect.B - $rect.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][Win]::PrintWindow($proc.MainWindowHandle, $dc, 2)
$g.ReleaseHdc($dc); $g.Dispose()
if ($Crop) {
  $c = $Crop.Split(",") | ForEach-Object { [int]$_ }
  $region = New-Object System.Drawing.Rectangle $c[0], $c[1], $c[2], $c[3]
  $cropped = $bmp.Clone($region, $bmp.PixelFormat)
  $bmp.Dispose(); $bmp = $cropped
}
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "$Out ${w}x${h}"
