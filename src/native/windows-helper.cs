// Shared native implementation for the compiled helper and development-only PowerShell loader.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

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

public sealed class CompanionRequest {
    public long id;
    public string command;
    public uint[] excludedPids;
    public string handle;
    public uint expectedPid;
    public string expectedPath;
    public string expectedTitle;
    public string action;
    public int first;
    public int second;
}

public static class CompanionProtocol {
    public const int MaximumRequestLength = 131072;
    private const long MaximumRequestId = 9007199254740991L;
    private static readonly JavaScriptSerializer InputSerializer = new JavaScriptSerializer {
        MaxJsonLength = MaximumRequestLength,
        RecursionLimit = 12
    };
    private static readonly JavaScriptSerializer OutputSerializer = new JavaScriptSerializer {
        MaxJsonLength = 16 * 1024 * 1024,
        RecursionLimit = 16
    };
    private static readonly HashSet<string> KnownErrors = new HashSet<string>(StringComparer.Ordinal) {
        "INVALID_REQUEST", "TARGET_UNAVAILABLE", "TARGET_CHANGED", "TARGET_EXCLUDED",
        "TARGET_MINIMIZED", "WINDOW_ACTION_FAILED", "CAPTURE_PROTECTED",
        "CAPTURE_UNSUPPORTED", "CAPTURE_BLANK", "CAPTURE_TOO_LARGE", "HELPER_START_FAILED"
    };

    private static void Invalid() { throw new InvalidOperationException("INVALID_REQUEST"); }

    private static Dictionary<string, object> ObjectValue(object value) {
        Dictionary<string, object> result = value as Dictionary<string, object>;
        if (result == null) Invalid();
        return result;
    }

    private static object Required(Dictionary<string, object> value, string key) {
        object result;
        if (!value.TryGetValue(key, out result) || result == null) Invalid();
        return result;
    }

    private static void OnlyKeys(Dictionary<string, object> value, params string[] allowed) {
        HashSet<string> keys = new HashSet<string>(allowed, StringComparer.Ordinal);
        foreach (string key in value.Keys) if (!keys.Contains(key)) Invalid();
    }

    private static string Text(object value, int maximum, bool allowEmpty) {
        string result = value as string;
        if (result == null || result.Length > maximum || result.IndexOf('\0') >= 0 || (!allowEmpty && result.Length == 0)) Invalid();
        return result;
    }

    private static long Integer(object value, long minimum, long maximum) {
        // DeserializeObject returns JSON integers as Int32/Int64. Strings, booleans and
        // floating-point values are intentionally not coerced into native arguments.
        if (!(value is int) && !(value is long)) Invalid();
        long result = Convert.ToInt64(value, CultureInfo.InvariantCulture);
        if (result < minimum || result > maximum) Invalid();
        return result;
    }

    private static string Handle(object value) {
        string result = Text(value, 19, false);
        if (result[0] == '0') Invalid();
        for (int i = 0; i < result.Length; i++) if (result[i] < '0' || result[i] > '9') Invalid();
        long number;
        if (!Int64.TryParse(result, NumberStyles.None, CultureInfo.InvariantCulture, out number) || number <= 0) Invalid();
        return result;
    }

    public static CompanionRequest Parse(string line) {
        if (line == null || line.Length == 0 || line.Length > MaximumRequestLength) Invalid();
        Dictionary<string, object> packet = ObjectValue(InputSerializer.DeserializeObject(line));
        CompanionRequest request = new CompanionRequest();
        request.id = Integer(Required(packet, "id"), 1, MaximumRequestId);
        request.command = Text(Required(packet, "command"), 16, false);
        object excludedObject;
        if (!packet.TryGetValue("excludedPids", out excludedObject)) excludedObject = new object[0];
        IList excluded = excludedObject as IList;
        if (excluded == null || excluded.Count > 512) Invalid();
        request.excludedPids = new uint[excluded.Count];
        for (int i = 0; i < excluded.Count; i++) request.excludedPids[i] = (uint)Integer(excluded[i], 1, UInt32.MaxValue);

        if (request.command == "list") {
            OnlyKeys(packet, "id", "command", "excludedPids");
        } else if (request.command == "inspect") {
            OnlyKeys(packet, "id", "command", "excludedPids", "handle");
            request.handle = Handle(Required(packet, "handle"));
        } else if (request.command == "action" || request.command == "capture") {
            if (request.command == "action") OnlyKeys(packet, "id", "command", "excludedPids", "target", "action");
            else OnlyKeys(packet, "id", "command", "excludedPids", "target");
            Dictionary<string, object> target = ObjectValue(Required(packet, "target"));
            OnlyKeys(target, "handle", "pid", "exePath", "title");
            request.handle = Handle(Required(target, "handle"));
            request.expectedPid = (uint)Integer(Required(target, "pid"), 1, UInt32.MaxValue);
            request.expectedPath = Text(Required(target, "exePath"), 32768, false);
            request.expectedTitle = Text(Required(target, "title"), 32768, true);
            if (!Path.IsPathRooted(request.expectedPath)) Invalid();
            if (request.command == "action") {
                Dictionary<string, object> action = ObjectValue(Required(packet, "action"));
                request.action = Text(Required(action, "type"), 16, false);
                if (request.action == "move") {
                    OnlyKeys(action, "type", "dx", "dy");
                    request.first = (int)Integer(Required(action, "dx"), -32768, 32768);
                    request.second = (int)Integer(Required(action, "dy"), -32768, 32768);
                } else if (request.action == "resize") {
                    OnlyKeys(action, "type", "width", "height");
                    request.first = (int)Integer(Required(action, "width"), 64, 8192);
                    request.second = (int)Integer(Required(action, "height"), 64, 8192);
                } else if (request.action == "minimize" || request.action == "restore") {
                    OnlyKeys(action, "type");
                } else { Invalid(); }
            }
        } else { Invalid(); }
        return request;
    }

    public static object Dispatch(CompanionRequest request) {
        if (request.command == "list") return CompanionNative.List(request.excludedPids);
        if (request.command == "inspect") return CompanionNative.Inspect(request.handle, request.excludedPids);
        if (request.command == "action") return CompanionNative.Act(request.handle, request.expectedPid,
            request.expectedPath, request.expectedTitle, request.action, request.first, request.second, request.excludedPids);
        if (request.command == "capture") return CompanionNative.Capture(request.handle, request.expectedPid,
            request.expectedPath, request.expectedTitle, request.excludedPids);
        Invalid();
        return null;
    }

    public static string Serialize(object packet) { return OutputSerializer.Serialize(packet); }

    public static void Send(object packet) {
        Console.Out.WriteLine(Serialize(packet));
        Console.Out.Flush();
    }

    public static string ErrorCode(Exception exception, CompanionRequest request) {
        string code = exception.GetBaseException().Message;
        if (KnownErrors.Contains(code)) return code;
        if (request != null) {
            if (request.command == "capture") return "CAPTURE_UNSUPPORTED";
            if (request.command == "action") return "WINDOW_ACTION_FAILED";
            if (request.command == "list" || request.command == "inspect") return "TARGET_UNAVAILABLE";
        }
        return "INVALID_REQUEST";
    }

    public static string ReadLine(TextReader reader) {
        StringBuilder line = new StringBuilder(256);
        while (true) {
            int next = reader.Read();
            if (next < 0) return line.Length == 0 ? null : line.ToString();
            if (next == '\n') {
                if (line.Length > 0 && line[line.Length - 1] == '\r') line.Length--;
                return line.ToString();
            }
            if (line.Length >= MaximumRequestLength) Invalid();
            line.Append((char)next);
        }
    }

    private static void ExpectInvalid(string json) {
        try { Parse(json); }
        catch (Exception) { return; }
        throw new InvalidOperationException("SELF_TEST_FAILED");
    }

    public static void SelfTest() {
        CompanionRequest list = Parse("{\"id\":1,\"command\":\"list\",\"excludedPids\":[]}");
        if (list.command != "list" || list.id != 1 || list.excludedPids.Length != 0) throw new InvalidOperationException("SELF_TEST_FAILED");
        string title = "Unicode \u96ea; quotes \" and $(data)";
        Dictionary<string, object> target = new Dictionary<string, object> {
            { "handle", "123" }, { "pid", 42 }, { "exePath", "C:\\Apps\\Example.exe" }, { "title", title }
        };
        Dictionary<string, object> packet = new Dictionary<string, object> {
            { "id", 2 }, { "command", "action" }, { "excludedPids", new uint[] { 1, 2 } },
            { "target", target }, { "action", new Dictionary<string, object> { { "type", "move" }, { "dx", -12 }, { "dy", 5 } } }
        };
        CompanionRequest action = Parse(Serialize(packet));
        if (action.expectedTitle != title || action.first != -12 || action.second != 5 || action.expectedPid != 42) throw new InvalidOperationException("SELF_TEST_FAILED");
        ExpectInvalid("{\"id\":1,\"command\":\"shell\",\"excludedPids\":[]}");
        ExpectInvalid("{\"id\":1.5,\"command\":\"list\",\"excludedPids\":[]}");
        ExpectInvalid("{\"id\":1,\"command\":\"list\",\"excludedPids\":[\"2\"]}");
        packet["action"] = new Dictionary<string, object> { { "type", "close" } };
        ExpectInvalid(Serialize(packet));
        packet["action"] = new Dictionary<string, object> { { "type", "move" }, { "dx", 1 } };
        ExpectInvalid(Serialize(packet));
        packet["action"] = new Dictionary<string, object> { { "type", "resize" }, { "width", 99999 }, { "height", 200 } };
        ExpectInvalid(Serialize(packet));
        using (StringReader reader = new StringReader("first\r\nsecond\n")) {
            if (ReadLine(reader) != "first" || ReadLine(reader) != "second" || ReadLine(reader) != null) throw new InvalidOperationException("SELF_TEST_FAILED");
        }
        Dictionary<string, object> reply = ObjectValue(InputSerializer.DeserializeObject(
            Serialize(new { id = 2, ok = true, result = new CompanionWindow[] { new CompanionWindow {
                handle = "123", pid = 42, exePath = "C:\\Apps\\Example.exe", processName = "Example",
                title = title, bounds = new CompanionBounds { x = -10, y = 20, width = 800, height = 600 }, minimized = false
            } } })));
        if (!(reply["result"] is IList) || ((IList)reply["result"]).Count != 1) throw new InvalidOperationException("SELF_TEST_FAILED");
    }
}

public static class CompanionHelperProgram {
    [STAThread]
    public static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false, true);
        Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
        Thread.CurrentThread.CurrentUICulture = CultureInfo.InvariantCulture;
        if (args.Length == 1 && args[0] == "--self-test") {
            try {
                CompanionProtocol.SelfTest();
                CompanionProtocol.Send(new { type = "self-test", protocol = 1, ok = true });
                return 0;
            } catch {
                CompanionProtocol.Send(new { type = "self-test", protocol = 1, ok = false });
                return 1;
            }
        }
        if (args.Length != 0) {
            Console.Error.WriteLine("Usage: desktop-window-helper.exe [--self-test]");
            return 2;
        }
        return Run();
    }

    public static int Run() {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false, true);
        Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
        Thread.CurrentThread.CurrentUICulture = CultureInfo.InvariantCulture;
        try {
            CompanionNative.Initialize();
            CompanionProtocol.Send(new { type = "ready", protocol = 1 });
        } catch {
            CompanionProtocol.Send(new { id = (object)null, ok = false, error = new { code = "HELPER_START_FAILED" } });
            return 1;
        }
        while (true) {
            string line;
            try { line = CompanionProtocol.ReadLine(Console.In); }
            catch {
                CompanionProtocol.Send(new { id = (object)null, ok = false, error = new { code = "INVALID_REQUEST" } });
                return 2;
            }
            if (line == null) return 0;
            if (line.Length == 0) continue;
            CompanionRequest request = null;
            try {
                request = CompanionProtocol.Parse(line);
                object result = CompanionProtocol.Dispatch(request);
                CompanionProtocol.Send(new { id = request.id, ok = true, result = result });
            } catch (Exception exception) {
                CompanionProtocol.Send(new {
                    id = request == null ? null : (object)request.id,
                    ok = false,
                    error = new { code = CompanionProtocol.ErrorCode(exception, request) }
                });
                if (request == null) return 2;
            }
        }
    }
}
