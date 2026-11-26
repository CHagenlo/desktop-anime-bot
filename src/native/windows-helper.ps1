# Fixed local helper. All incoming values are data; there is no command evaluation.
# No execution policy is modified. A system that blocks this script fails closed.
# Capture is selected-window PrintWindow rendering, never a desktop screenshot/crop.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class CompanionBounds {
    public int x { get; set; }
    public int y { get; set; }
    public int width { get; set; }
    public int height { get; set; }
}
public sealed class CompanionWindow {
    public string handle { get; set; }
    public uint pid { get; set; }
    public string exePath { get; set; }
    public string processName { get; set; }
    public string title { get; set; }
    public CompanionBounds bounds { get; set; }
    public bool minimized { get; set; }
}
public sealed class CompanionCapture {
    public string mimeType { get; set; }
    public string base64 { get; set; }
}

public static class CompanionNative {
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }
    private delegate bool EnumCallback(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextW(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextLengthW(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr handle, out RECT rectangle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindowAsync(IntPtr handle, int command);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PrintWindow(IntPtr handle, IntPtr destination, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowDisplayAffinity(IntPtr handle, out uint affinity);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr handle, uint attribute, out int value, int size);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    private static void Error(string code) { throw new InvalidOperationException(code); }

    public static void Initialize() {
        // Win10 per-monitor awareness makes our rectangles and mutations use physical pixels.
        if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) Error("HELPER_START_FAILED");
    }

    private static IntPtr ParseHandle(string text) {
        long number = 0;
        if (String.IsNullOrEmpty(text) || !Int64.TryParse(text, out number) || number <= 0) Error("INVALID_REQUEST");
        return new IntPtr(number);
    }

    private static bool Excluded(uint process, uint[] excluded) {
        if (process == GetCurrentProcessId()) return true;
        if (excluded != null) foreach (uint item in excluded) if (process == item) return true;
        return false;
    }

    private static string ProcessPath(uint processId) {
        IntPtr process = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) Error("TARGET_UNAVAILABLE");
        try {
            uint size = 32768;
            StringBuilder name = new StringBuilder((int)size);
            if (!QueryFullProcessImageNameW(process, 0, name, ref size) || size == 0) Error("TARGET_UNAVAILABLE");
            return name.ToString();
        } finally { CloseHandle(process); }
    }

    private static CompanionWindow InspectInternal(IntPtr handle, uint[] excluded) {
        if (!IsWindow(handle) || !IsWindowVisible(handle) || GetAncestor(handle, 2) != handle) Error("TARGET_UNAVAILABLE");
        uint processId;
        if (GetWindowThreadProcessId(handle, out processId) == 0 || processId == 0) Error("TARGET_UNAVAILABLE");
        if (Excluded(processId, excluded)) Error("TARGET_EXCLUDED");
        int cloaked;
        if (DwmGetWindowAttribute(handle, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) Error("TARGET_UNAVAILABLE");
        int textLength = GetWindowTextLengthW(handle);
        if (textLength < 0 || textLength > 32767) Error("TARGET_UNAVAILABLE");
        StringBuilder title = new StringBuilder(Math.Max(1, textLength + 1));
        GetWindowTextW(handle, title, title.Capacity);
        RECT rectangle;
        if (!GetWindowRect(handle, out rectangle)) Error("TARGET_UNAVAILABLE");
        long width = (long)rectangle.Right - rectangle.Left;
        long height = (long)rectangle.Bottom - rectangle.Top;
        if (width < 1 || height < 1 || width > 32768 || height > 32768) Error("TARGET_UNAVAILABLE");
        string executable = ProcessPath(processId);
        // Check the HWND owner again after the process lookup.
        uint finalProcess;
        if (!IsWindow(handle) || GetWindowThreadProcessId(handle, out finalProcess) == 0 || finalProcess != processId) Error("TARGET_CHANGED");
        return new CompanionWindow {
            handle = handle.ToInt64().ToString(),
            pid = processId,
            exePath = executable,
            processName = Path.GetFileNameWithoutExtension(executable),
            title = title.ToString(),
            bounds = new CompanionBounds { x = rectangle.Left, y = rectangle.Top, width = (int)width, height = (int)height },
            minimized = IsIconic(handle)
        };
    }

    private static CompanionWindow Match(IntPtr handle, uint expectedPid, string expectedPath, string expectedTitle, uint[] excluded) {
        if (expectedPid == 0 || String.IsNullOrEmpty(expectedPath) || expectedTitle == null) Error("INVALID_REQUEST");
        CompanionWindow current = InspectInternal(handle, excluded);
        if (current.pid != expectedPid ||
            !String.Equals(current.exePath, expectedPath, StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(current.title, expectedTitle, StringComparison.Ordinal)) Error("TARGET_CHANGED");
        return current;
    }

    public static CompanionWindow[] List(uint[] excluded) {
        List<CompanionWindow> windows = new List<CompanionWindow>();
        EnumCallback callback = delegate(IntPtr handle, IntPtr parameter) {
            if (windows.Count >= 2048) return false;
            try {
                CompanionWindow window = InspectInternal(handle, excluded);
                if (!String.IsNullOrWhiteSpace(window.title)) windows.Add(window);
            } catch (InvalidOperationException) {
                // Inaccessible or disappearing windows are omitted, not given incomplete identities.
            }
            return true;
        };
        bool completed = EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        if (!completed && windows.Count < 2048) Error("TARGET_UNAVAILABLE");
        return windows.ToArray();
    }

    public static CompanionWindow Inspect(string handle, uint[] excluded) {
        return InspectInternal(ParseHandle(handle), excluded);
    }

    public static CompanionWindow Act(string handleText, uint expectedPid, string expectedPath, string expectedTitle,
        string action, int first, int second, uint[] excluded) {
        IntPtr handle = ParseHandle(handleText);
        CompanionWindow current = Match(handle, expectedPid, expectedPath, expectedTitle, excluded);
        const uint keepOrderAndFocus = 0x0004 | 0x0010 | 0x0200;
        if (action == "move") {
            if (current.minimized) Error("TARGET_MINIMIZED");
            if (Math.Abs((long)first) > 32768 || Math.Abs((long)second) > 32768) Error("INVALID_REQUEST");
            long x = (long)current.bounds.x + first;
            long y = (long)current.bounds.y + second;
            if (x < Int32.MinValue || x > Int32.MaxValue || y < Int32.MinValue || y > Int32.MaxValue) Error("INVALID_REQUEST");
            Match(handle, expectedPid, expectedPath, expectedTitle, excluded);
            if (!SetWindowPos(handle, IntPtr.Zero, (int)x, (int)y, 0, 0, keepOrderAndFocus | 0x0001)) Error("WINDOW_ACTION_FAILED");
        } else if (action == "resize") {
            if (current.minimized) Error("TARGET_MINIMIZED");
            if (first < 64 || first > 8192 || second < 64 || second > 8192) Error("INVALID_REQUEST");
            Match(handle, expectedPid, expectedPath, expectedTitle, excluded);
            if (!SetWindowPos(handle, IntPtr.Zero, 0, 0, first, second, keepOrderAndFocus | 0x0002)) Error("WINDOW_ACTION_FAILED");
        } else if (action == "minimize" || action == "restore") {
            bool shouldMinimize = action == "minimize";
            Match(handle, expectedPid, expectedPath, expectedTitle, excluded);
            if (!ShowWindowAsync(handle, shouldMinimize ? 6 : 9)) Error("WINDOW_ACTION_FAILED");
            bool confirmed = false;
            for (int i = 0; i < 40; i++) {
                CompanionWindow observed = Match(handle, expectedPid, expectedPath, expectedTitle, excluded);
                if (observed.minimized == shouldMinimize) { confirmed = true; break; }
                Thread.Sleep(25);
            }
            if (!confirmed) Error("WINDOW_ACTION_FAILED");
        } else { Error("INVALID_REQUEST"); }
        return Match(handle, expectedPid, expectedPath, expectedTitle, excluded);
    }

    public static CompanionCapture Capture(string handleText, uint expectedPid, string expectedPath, string expectedTitle, uint[] excluded) {
        IntPtr handle = ParseHandle(handleText);
        CompanionWindow current = Match(handle, expectedPid, expectedPath, expectedTitle, excluded);
        if (current.minimized) Error("TARGET_MINIMIZED");
        int width = current.bounds.width, height = current.bounds.height;
        if (width < 2 || height < 2 || width > 8192 || height > 8192 || (long)width * height > 32000000) Error("CAPTURE_TOO_LARGE");
        uint affinity;
        // This query is not supported for every window; a reported restriction is always honored.
        if (GetWindowDisplayAffinity(handle, out affinity) && affinity != 0) Error("CAPTURE_PROTECTED");
        Color untouched = Color.FromArgb(19, 43, 71);
        using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
            using (Graphics graphics = Graphics.FromImage(bitmap)) {
                graphics.Clear(untouched);
                IntPtr destination = graphics.GetHdc();
                bool rendered = false;
                try {
                    Match(handle, expectedPid, expectedPath, expectedTitle, excluded);
                    // The target application renders into this fresh bitmap. No screen DC, BitBlt,
                    // CopyFromScreen, or desktop-capture fallback is used.
                    rendered = PrintWindow(handle, destination, 0);
                } finally { graphics.ReleaseHdc(destination); }
                if (!rendered) Error("CAPTURE_UNSUPPORTED");
            }
            CompanionWindow after = Match(handle, expectedPid, expectedPath, expectedTitle, excluded);
            if (after.minimized || after.bounds.width != width || after.bounds.height != height) Error("TARGET_CHANGED");
            if (GetWindowDisplayAffinity(handle, out affinity) && affinity != 0) Error("CAPTURE_PROTECTED");
            // Conservatively reject blank or untouched content instead of sending misleading imagery.
            int sampleCount = 0, untouchedCount = 0;
            Color firstColor = bitmap.GetPixel(width / 2, height / 2);
            bool varied = false;
            for (int row = 1; row <= 9; row++) for (int column = 1; column <= 9; column++) {
                Color pixel = bitmap.GetPixel(width * column / 10, height * row / 10);
                sampleCount++;
                if (pixel.ToArgb() == untouched.ToArgb()) untouchedCount++;
                if (Math.Abs(pixel.R - firstColor.R) + Math.Abs(pixel.G - firstColor.G) + Math.Abs(pixel.B - firstColor.B) > 12) varied = true;
            }
            if (untouchedCount > sampleCount / 4) Error("CAPTURE_UNSUPPORTED");
            if (!varied) Error("CAPTURE_BLANK");
            double scale = Math.Min(1.0, Math.Min(1600.0 / Math.Max(width, height), Math.Sqrt(2000000.0 / ((double)width * height))));
            int outputWidth = Math.Max(1, (int)Math.Round(width * scale));
            int outputHeight = Math.Max(1, (int)Math.Round(height * scale));
            using (Bitmap output = new Bitmap(outputWidth, outputHeight, PixelFormat.Format24bppRgb)) {
                using (Graphics graphics = Graphics.FromImage(output)) {
                    graphics.Clear(Color.Black);
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.DrawImage(bitmap, new Rectangle(0, 0, outputWidth, outputHeight));
                }
                using (MemoryStream stream = new MemoryStream()) {
                    output.Save(stream, ImageFormat.Png);
                    if (stream.Length > 9000000) Error("CAPTURE_TOO_LARGE");
                    return new CompanionCapture { mimeType = "image/png", base64 = Convert.ToBase64String(stream.ToArray()) };
                }
            }
        }
    }
}
'@

function Send-Packet($packet) {
    [Console]::WriteLine(($packet | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}

try {
    Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies System.Drawing -ErrorAction Stop | Out-Null
    [CompanionNative]::Initialize()
    Send-Packet @{ type = 'ready'; protocol = 1 }
} catch {
    Send-Packet @{ id = $null; ok = $false; error = @{ code = 'HELPER_START_FAILED' } }
    exit 1
}

$knownErrors = @(
    'INVALID_REQUEST', 'TARGET_UNAVAILABLE', 'TARGET_CHANGED', 'TARGET_EXCLUDED',
    'TARGET_MINIMIZED', 'WINDOW_ACTION_FAILED', 'CAPTURE_PROTECTED',
    'CAPTURE_UNSUPPORTED', 'CAPTURE_BLANK', 'CAPTURE_TOO_LARGE'
)

while ($null -ne ($requestLine = [Console]::ReadLine())) {
    $requestId = $null
    $request = $null
    try {
        if ($requestLine.Length -gt 131072) { throw 'INVALID_REQUEST' }
        $request = $requestLine | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $request.id -or $request.id -isnot [ValueType]) { throw 'INVALID_REQUEST' }
        $requestId = [long]$request.id
        if ($requestId -le 0) { throw 'INVALID_REQUEST' }
        [uint32[]]$excluded = @($request.excludedPids | ForEach-Object { [uint32]$_ })
        if ($excluded.Length -gt 512) { throw 'INVALID_REQUEST' }
        $result = $null
        switch -CaseSensitive ($request.command) {
            'list' {
                $result = @([CompanionNative]::List($excluded))
            }
            'inspect' {
                $result = [CompanionNative]::Inspect([string]$request.handle, $excluded)
            }
            'action' {
                if ($null -eq $request.target -or $null -eq $request.action) { throw 'INVALID_REQUEST' }
                $first = 0; $second = 0
                if ($request.action.type -ceq 'move') { $first = [int]$request.action.dx; $second = [int]$request.action.dy }
                if ($request.action.type -ceq 'resize') { $first = [int]$request.action.width; $second = [int]$request.action.height }
                $result = [CompanionNative]::Act(
                    [string]$request.target.handle, [uint32]$request.target.pid,
                    [string]$request.target.exePath, [string]$request.target.title,
                    [string]$request.action.type, $first, $second, $excluded)
            }
            'capture' {
                if ($null -eq $request.target) { throw 'INVALID_REQUEST' }
                $result = [CompanionNative]::Capture(
                    [string]$request.target.handle, [uint32]$request.target.pid,
                    [string]$request.target.exePath, [string]$request.target.title, $excluded)
            }
            default { throw 'INVALID_REQUEST' }
        }
        Send-Packet @{ id = $requestId; ok = $true; result = $result }
    } catch {
        $errorCode = $_.Exception.GetBaseException().Message
        if ($knownErrors -cnotcontains $errorCode) {
            $errorCode = 'INVALID_REQUEST'
            if ($null -ne $request) {
                if ($request.command -ceq 'capture') { $errorCode = 'CAPTURE_UNSUPPORTED' }
                elseif ($request.command -ceq 'action') { $errorCode = 'WINDOW_ACTION_FAILED' }
                elseif ($request.command -ceq 'list' -or $request.command -ceq 'inspect') { $errorCode = 'TARGET_UNAVAILABLE' }
            }
        }
        Send-Packet @{ id = $requestId; ok = $false; error = @{ code = $errorCode } }
    }
}
