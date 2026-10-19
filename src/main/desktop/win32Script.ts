/**
 * Fixed Win32 helper executed by a dedicated PowerShell process. It accepts
 * only the commands dispatched below (one JSON request per line on stdin) —
 * it is not a shell and never evaluates request content as code.
 *
 * Safety properties enforced here (in addition to the TypeScript layer):
 *  - input/click commands refuse to send anything unless the target window is
 *    the foreground window at that moment (returns code "not_foreground",
 *    nothing dispatched);
 *  - clicks must land inside the target's client area and on the target itself
 *    (not on an overlapping window).
 */
export const WIN32_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class KeoWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);

  // Milliseconds since the user last used the keyboard or mouse (any app).
  public static long IdleMs() {
    var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref i)) return -1;
    return (long)unchecked((uint)Environment.TickCount - i.dwTime);
  }

  // Share (0..1) of sample points inside the window that another window covers.
  // Browsers stop updating a covered page, so its accessibility tree goes stale.
  public static double CoveredShare(IntPtr h) {
    RECT r; if (!GetWindowRect(h, out r) || IsIconic(h)) return 1.0;
    int w = r.Right - r.Left, hh = r.Bottom - r.Top; if (w <= 0 || hh <= 0) return 1.0;
    int covered = 0, total = 0;
    for (int ix = 1; ix <= 3; ix++) for (int iy = 1; iy <= 3; iy++) {
      var p = new POINT(); p.X = r.Left + w * ix / 4; p.Y = r.Top + hh * iy / 4;
      total++;
      if (!PartOfTarget(WindowFromPoint(p), h)) covered++;
    }
    return (double)covered / total;
  }

  public static string ForegroundHwnd() { var h = GetForegroundWindow(); return h == IntPtr.Zero ? "" : h.ToInt64().ToString(); }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int v);

  // Real (physical) pixels on every monitor. Without this, Windows rescales the
  // helper's coordinates per monitor and clicks miss on mixed-scale setups
  // (e.g. a laptop at 100% with an external monitor at 150%+). Must run before
  // any window or UI Automation call.
  public static string EnableDpiAwareness() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per_monitor_v2"; } catch (Exception) { }
    try { if (SetProcessDpiAwareness(2) == 0) return "per_monitor"; } catch (Exception) { }
    try { if (SetProcessDPIAware()) return "system"; } catch (Exception) { }
    return "unaware";
  }

  // Moves the pointer and confirms it really arrived (it can be clamped or
  // rescaled); refuses to click elsewhere.
  static void PointerTo(int x, int y) {
    SetCursorPos(x, y);
    POINT c;
    if (!GetCursorPos(out c) || Math.Abs(c.X - x) > 1 || Math.Abs(c.Y - y) > 1) throw new Exception("pointer_mismatch");
  }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint type);
  [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr exitStatus; public IntPtr peb; public IntPtr affinity; public IntPtr priority; public IntPtr pid; public IntPtr parent; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);

  static uint ParentPid(uint pid) {
    var ph = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (ph == IntPtr.Zero) return 0;
    try {
      var b = new PBI(); int ret;
      if (NtQueryInformationProcess(ph, 0, ref b, Marshal.SizeOf(typeof(PBI)), out ret) != 0) return 0;
      return (uint)b.parent.ToInt64();
    } finally { CloseHandle(ph); }
  }

  // The target app's own surface: the window itself, or a visible top-level window of the same app
  // (same process, or a child process it started) laid over it. WhatsApp Desktop draws its chats in
  // such a WebView2 window, which holds the keyboard focus. Any other window is not the target.
  public static bool PartOfTarget(IntPtr w, IntPtr h) {
    if (w == IntPtr.Zero) return false;
    var top = GetAncestor(w, 2);
    if (top == h) return true;
    if (top == IntPtr.Zero || !IsWindowVisible(top) || IsIconic(h)) return false;
    uint tp, wp; GetWindowThreadProcessId(h, out tp); GetWindowThreadProcessId(top, out wp);
    if (wp == 0 || (wp != tp && ParentPid(wp) != tp)) return false;
    RECT a, b;
    if (!GetWindowRect(h, out a) || !GetWindowRect(top, out b)) return false;
    const int tol = 24;
    return b.Left >= a.Left - tol && b.Top >= a.Top - tol && b.Right <= a.Right + tol && b.Bottom <= a.Bottom + tol && (b.Right - b.Left) * 2 >= (a.Right - a.Left);
  }

  static bool IsFg(IntPtr h) { return PartOfTarget(GetForegroundWindow(), h); }

  static string Text(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
  static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  static string ProcName(uint pid) {
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  public static Dictionary<string, object> Describe(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    RECT r; GetWindowRect(h, out r);
    var d = new Dictionary<string, object>();
    d["hwnd"] = h.ToInt64().ToString();
    d["pid"] = (long)pid;
    d["processName"] = ProcName(pid);
    d["title"] = Text(h);
    d["className"] = Cls(h);
    d["minimized"] = IsIconic(h);
    d["x"] = r.Left; d["y"] = r.Top; d["width"] = r.Right - r.Left; d["height"] = r.Bottom - r.Top;
    d["foreground"] = IsFg(h);
    return d;
  }

  public static List<Dictionary<string, object>> List() {
    var list = new List<Dictionary<string, object>>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;            // owned popup
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;       // WS_EX_TOOLWINDOW
      if (Cloaked(h)) return true;
      if (Text(h).Length == 0) return true;
      list.Add(Describe(h));
      return true;
    }, IntPtr.Zero);
    return list;
  }

  // All visible windows of one process, including owned popups/dialogs.
  public static List<Dictionary<string, object>> ProcessWindows(uint pid) {
    var list = new List<Dictionary<string, object>>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h) || Cloaked(h)) return true;
      var d = Describe(h);
      d["owner"] = GetWindow(h, 4).ToInt64().ToString();
      list.Add(d);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static Dictionary<string, object> CursorTo(int x, int y) {
    SetCursorPos(x, y);
    var d = new Dictionary<string, object>(); d["x"] = x; d["y"] = y; return d;
  }

  public static void Wheel(IntPtr h, int sx, int sy, int notches) {
    RequireForeground(h);
    var p = new POINT(); p.X = sx; p.Y = sy;
    if (!PartOfTarget(WindowFromPoint(p), h)) throw new Exception("target_obscured");
    PointerTo(sx, sy);
    var inputs = new List<INPUT>();
    int n = Math.Abs(notches);
    for (int i = 0; i < n; i++) {
      var a = new INPUT(); a.type = 0; a.U.mi.dwFlags = 0x0800; a.U.mi.mouseData = (uint)(notches < 0 ? 120 : -120); inputs.Add(a);
    }
    Send(inputs);
  }

  public static void ClickScreen(IntPtr h, int sx, int sy) {
    RequireForeground(h);
    var p = new POINT(); p.X = sx; p.Y = sy;
    if (!PartOfTarget(WindowFromPoint(p), h)) throw new Exception("target_obscured");
    PointerTo(sx, sy);
    var a = new INPUT(); a.type = 0; a.U.mi.dwFlags = 0x0002;
    var b = new INPUT(); b.type = 0; b.U.mi.dwFlags = 0x0004;
    Send(new List<INPUT> { a, b });
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; return i;
  }

  static void Send(List<INPUT> inputs) {
    var arr = inputs.ToArray();
    uint sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
    // Nothing inserted: Windows (or security software) refuses simulated input from Keo.
    if (sent == 0) throw new Exception("input_blocked:" + Marshal.GetLastWin32Error());
    if (sent != arr.Length) throw new Exception("partial_input:" + sent + "/" + arr.Length);
  }

  public static bool Focus(IntPtr h) {
    if (!IsWindow(h)) throw new Exception("target_gone");
    if (IsIconic(h)) ShowWindow(h, 9);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    Thread.Sleep(60);
    if (!IsFg(h)) {
      // An ALT tap lets this process take foreground rights (documented
      // SetForegroundWindow rule). A bare ALT release would open the menu of
      // whichever window receives it (and swallow the next keys typed), so an
      // unassigned key (VK 0xE8) is pressed in between to mask it.
      // Best effort: some PCs accept only part of injected input here (security
      // software, another program's input block). That must not fail the focus
      // or leave ALT held down, which would turn every typed key into a shortcut.
      var tap = new List<INPUT> { Key(0x12, 0, 0), Key(0xE8, 0, 0), Key(0xE8, 0, 2), Key(0x12, 0, 2) }.ToArray();
      SendInput((uint)tap.Length, tap, Marshal.SizeOf(typeof(INPUT)));
      ReleaseModifiers();
      BringWindowToTop(h);
      SetForegroundWindow(h);
      Thread.Sleep(100);
    }
    if (!IsFg(h)) {
      // Fallback: share input state with the current foreground thread, which
      // Windows permits to hand over the foreground.
      uint pidUnused;
      uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pidUnused);
      uint targetThread = GetWindowThreadProcessId(h, out pidUnused);
      uint me = GetCurrentThreadId();
      AttachThreadInput(me, fgThread, true);
      AttachThreadInput(me, targetThread, true);
      BringWindowToTop(h);
      ShowWindow(h, 5);
      SetForegroundWindow(h);
      AttachThreadInput(me, targetThread, false);
      AttachThreadInput(me, fgThread, false);
      Thread.Sleep(150);
    }
    if (!IsFg(h)) return false;
    LeaveMenuMode(h);
    return true;
  }

  // If the window is in menu mode (its menu or system menu was activated),
  // close it so typed keys reach the document instead of menu shortcuts.
  // Escape is sent only when Windows reports menu mode.
  static void LeaveMenuMode(IntPtr h) {
    uint pidUnused;
    uint thread = GetWindowThreadProcessId(h, out pidUnused);
    for (int i = 0; i < 2; i++) {
      var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
      if (!GetGUIThreadInfo(thread, ref gi)) return;
      // GUI_INMENUMODE 0x4, GUI_SYSTEMMENUMODE 0x8, GUI_POPUPMENUMODE 0x10
      if ((gi.flags & 0x1C) == 0) return;
      Send(new List<INPUT> { Key(0x1B, 0, 0), Key(0x1B, 0, 2) });
      Thread.Sleep(60);
    }
  }

  // ---- Direct delivery: used only when Windows refuses simulated input. The
  // same characters/keys/clicks are posted as window messages to the focused
  // control of the verified foreground target (never to a background window).
  static IntPtr FocusOf(IntPtr h) {
    var fg = GetForegroundWindow();
    var surface = fg != IntPtr.Zero && GetAncestor(fg, 2) != h && PartOfTarget(fg, h) ? GetAncestor(fg, 2) : h;
    uint pidUnused;
    uint thread = GetWindowThreadProcessId(surface, out pidUnused);
    var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (GetGUIThreadInfo(thread, ref gi) && gi.hwndFocus != IntPtr.Zero && GetAncestor(gi.hwndFocus, 2) == surface) return gi.hwndFocus;
    return surface;
  }

  static IntPtr KeyL(uint vk, bool up) {
    uint scan = MapVirtualKeyW(vk, 0);
    long l = 1 | ((long)scan << 16);
    if (up) l |= 0xC0000000L;
    return new IntPtr(l);
  }

  public static int PostText(IntPtr h, string text) {
    RequireForeground(h);
    var f = FocusOf(h);
    int n = 0;
    foreach (char c in text) {
      if (c == '\r') { n++; continue; }
      if (n % 20 == 0 && !IsFg(h)) throw new Exception("foreground_lost:" + n);
      if (c == '\n') {
        PostMessageW(f, 0x0100, new IntPtr(0x0D), KeyL(0x0D, false));
        PostMessageW(f, 0x0102, new IntPtr(13), KeyL(0x0D, false));
        PostMessageW(f, 0x0101, new IntPtr(0x0D), KeyL(0x0D, true));
      } else PostMessageW(f, 0x0102, new IntPtr(c), new IntPtr(1));
      n++;
      if (n % 20 == 0) Thread.Sleep(10);
    }
    Thread.Sleep(60);
    return n;
  }

  public static void PostKey(IntPtr h, int vk) {
    RequireForeground(h);
    var f = FocusOf(h);
    PostMessageW(f, 0x0100, new IntPtr(vk), KeyL((uint)vk, false));
    int ch = vk == 0x0D ? 13 : vk == 0x09 ? 9 : vk == 0x08 ? 8 : vk == 0x1B ? 27 : 0;
    if (ch != 0) PostMessageW(f, 0x0102, new IntPtr(ch), KeyL((uint)vk, false));
    PostMessageW(f, 0x0101, new IntPtr(vk), KeyL((uint)vk, true));
    Thread.Sleep(60);
  }

  public static int PostPaste(IntPtr h) {
    string text = null;
    for (int i = 0; i < 5 && text == null; i++) {
      if (OpenClipboard(IntPtr.Zero)) {
        try {
          var data = GetClipboardData(13); // CF_UNICODETEXT
          if (data != IntPtr.Zero) { var ptr = GlobalLock(data); if (ptr != IntPtr.Zero) { text = Marshal.PtrToStringUni(ptr); GlobalUnlock(data); } }
          if (text == null) text = "";
        } finally { CloseClipboard(); }
      } else Thread.Sleep(30);
    }
    if (text == null) throw new Exception("clipboard_busy");
    return PostText(h, text);
  }

  public static void PostClickScreen(IntPtr h, int sx, int sy) {
    RequireForeground(h);
    var p = new POINT(); p.X = sx; p.Y = sy;
    var hit = WindowFromPoint(p);
    if (!PartOfTarget(hit, h)) throw new Exception("target_obscured");
    ScreenToClient(hit, ref p);
    var l = new IntPtr((p.Y << 16) | (p.X & 0xFFFF));
    PostMessageW(hit, 0x0200, IntPtr.Zero, l);
    PostMessageW(hit, 0x0201, new IntPtr(1), l);
    PostMessageW(hit, 0x0202, IntPtr.Zero, l);
    Thread.Sleep(60);
  }

  // ---- Drawing: strokes with the left button held. Points are screen coordinates; the pair
  // (PEN_UP, PEN_UP) ends a stroke. Every point must lie inside the target window and on the
  // target itself (or its own overlay); the target must stay in the foreground throughout.
  public const int PEN_UP = 2147483647;
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

  static List<POINT> StrokePoints(IntPtr h, int[] pts) {
    RECT wr; if (!GetWindowRect(h, out wr)) throw new Exception("target_gone");
    var list = new List<POINT>();
    for (int i = 0; i + 1 < pts.Length; i += 2) {
      var p = new POINT(); p.X = pts[i]; p.Y = pts[i + 1];
      if (p.X == PEN_UP) { list.Add(p); continue; }
      if (p.X < wr.Left || p.Y < wr.Top || p.X >= wr.Right || p.Y >= wr.Bottom) throw new Exception("outside_client_area");
      if (!PartOfTarget(WindowFromPoint(p), h)) throw new Exception("target_obscured");
      list.Add(p);
    }
    return list;
  }

  static INPUT MouseAbs(int x, int y, uint extra) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    var a = new INPUT(); a.type = 0;
    a.U.mi.dx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    a.U.mi.dy = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    a.U.mi.dwFlags = 0x0001 | 0x8000 | 0x4000 | extra; // MOVE | ABSOLUTE | VIRTUALDESK
    return a;
  }

  public static int Draw(IntPtr h, int[] pts) {
    RequireForeground(h);
    ReleaseModifiers();
    var list = StrokePoints(h, pts);
    bool down = false; int n = 0; var last = new POINT();
    try {
      foreach (var p in list) {
        if (p.X == PEN_UP) { if (down) { Send(new List<INPUT> { MouseAbs(last.X, last.Y, 0x0004) }); down = false; Thread.Sleep(20); } continue; }
        if (!IsFg(h)) throw new Exception("foreground_lost:" + n);
        if (!down) {
          Send(new List<INPUT> { MouseAbs(p.X, p.Y, 0) }); Thread.Sleep(15);
          Send(new List<INPUT> { MouseAbs(p.X, p.Y, 0x0002) }); Thread.Sleep(15);
          down = true; last = p; n++; continue;
        }
        int dx = p.X - last.X, dy = p.Y - last.Y;
        int steps = Math.Max(1, (int)(Math.Sqrt(dx * dx + dy * dy) / 5));
        for (int k = 1; k <= steps; k++) { Send(new List<INPUT> { MouseAbs(last.X + dx * k / steps, last.Y + dy * k / steps, 0) }); Thread.Sleep(2); }
        last = p; n++;
      }
    } finally {
      if (down) { try { Send(new List<INPUT> { MouseAbs(last.X, last.Y, 0x0004) }); } catch { } }
    }
    return n;
  }

  // Synthetic pen (Windows 10 1809+): a separate input path that drawing apps take as a pen.
  // Used for drawing when Windows refuses simulated mouse input.
  [StructLayout(LayoutKind.Sequential)] struct SP_INFO {
    public int pointerType; public uint pointerId; public uint frameId; public int pointerFlags;
    public IntPtr sourceDevice; public IntPtr hwndTarget;
    public POINT ptPixelLocation; public POINT ptHimetricLocation; public POINT ptPixelLocationRaw; public POINT ptHimetricLocationRaw;
    public uint dwTime; public uint historyCount; public int InputData; public uint dwKeyStates; public ulong PerformanceCount; public int ButtonChangeType;
  }
  [StructLayout(LayoutKind.Sequential)] struct SP_PEN { public SP_INFO info; public int penFlags; public int penMask; public uint pressure; public uint rotation; public int tiltX; public int tiltY; }
  [StructLayout(LayoutKind.Explicit, Size = 152)] struct SP_TYPE { [FieldOffset(0)] public int type; [FieldOffset(8)] public SP_PEN pen; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr CreateSyntheticPointerDevice(int type, uint max, int mode);
  [DllImport("user32.dll", SetLastError = true)] static extern bool InjectSyntheticPointerInput(IntPtr dev, SP_TYPE[] info, uint count);
  [DllImport("user32.dll")] static extern void DestroySyntheticPointerDevice(IntPtr dev);

  static void PenFrame(IntPtr dev, POINT p, int flags) {
    var t = new SP_TYPE(); t.type = 3;
    t.pen.info.pointerType = 3; t.pen.info.pointerFlags = flags; t.pen.info.ptPixelLocation = p;
    t.pen.penMask = 0x1; t.pen.pressure = (flags & 0x4) != 0 ? 512u : 0u;
    if (!InjectSyntheticPointerInput(dev, new[] { t }, 1)) throw new Exception("pen_rejected:" + Marshal.GetLastWin32Error());
  }

  public static int PenDraw(IntPtr h, int[] pts) {
    RequireForeground(h);
    var list = StrokePoints(h, pts);
    IntPtr dev;
    try { dev = CreateSyntheticPointerDevice(3, 1, 1); } catch (EntryPointNotFoundException) { throw new Exception("pen_unavailable"); }
    if (dev == IntPtr.Zero) throw new Exception("pen_unavailable:" + Marshal.GetLastWin32Error());
    const int RANGE = 0x2, CONTACT = 0x4, DOWN = 0x10000, UPDATE = 0x20000, UP = 0x40000;
    bool down = false; int n = 0; var last = new POINT();
    try {
      foreach (var p in list) {
        if (p.X == PEN_UP) { if (down) { PenFrame(dev, last, RANGE | UP); PenFrame(dev, last, UPDATE); down = false; Thread.Sleep(20); } continue; }
        if (!IsFg(h)) throw new Exception("foreground_lost:" + n);
        if (!down) {
          PenFrame(dev, p, RANGE | UPDATE); Thread.Sleep(15);
          PenFrame(dev, p, RANGE | CONTACT | DOWN); Thread.Sleep(10);
          down = true; last = p; n++; continue;
        }
        int dx = p.X - last.X, dy = p.Y - last.Y;
        int steps = Math.Max(1, (int)(Math.Sqrt(dx * dx + dy * dy) / 5));
        for (int k = 1; k <= steps; k++) {
          var q = new POINT(); q.X = last.X + dx * k / steps; q.Y = last.Y + dy * k / steps;
          PenFrame(dev, q, RANGE | CONTACT | UPDATE); Thread.Sleep(3);
        }
        last = p; n++;
      }
    } finally {
      if (down) { try { PenFrame(dev, last, RANGE | UP); PenFrame(dev, last, UPDATE); } catch { } }
      DestroySyntheticPointerDevice(dev);
    }
    return n;
  }

  // Direct delivery for drawing (simulated input refused): button and move messages posted to the
  // window under each stroke, in its own client coordinates. Apps that read the pointer device
  // directly may ignore these.
  public static int PostDraw(IntPtr h, int[] pts) {
    RequireForeground(h);
    var list = StrokePoints(h, pts);
    IntPtr hit = IntPtr.Zero; bool down = false; int n = 0; var last = new POINT();
    foreach (var p in list) {
      if (p.X == PEN_UP) { if (down) { PostMouse(hit, 0x0202, 0, last); down = false; } continue; }
      if (!down) {
        hit = WindowFromPoint(p);
        PostMouse(hit, 0x0200, 0, p); PostMouse(hit, 0x0201, 1, p);
        down = true; last = p; n++; continue;
      }
      int dx = p.X - last.X, dy = p.Y - last.Y;
      int steps = Math.Max(1, (int)(Math.Sqrt(dx * dx + dy * dy) / 5));
      for (int k = 1; k <= steps; k++) {
        var q = new POINT(); q.X = last.X + dx * k / steps; q.Y = last.Y + dy * k / steps;
        PostMouse(hit, 0x0200, 1, q);
        if (k % 8 == 0) Thread.Sleep(2);
      }
      last = p; n++;
    }
    if (down) PostMouse(hit, 0x0202, 0, last);
    Thread.Sleep(60);
    return n;
  }

  static void PostMouse(IntPtr w, uint msg, int keys, POINT screen) {
    var c = screen; ScreenToClient(w, ref c);
    PostMessageW(w, msg, new IntPtr(keys), new IntPtr(((c.Y & 0xFFFF) << 16) | (c.X & 0xFFFF)));
  }

  public static void RequireForeground(IntPtr h) {
    if (!IsWindow(h)) throw new Exception("target_gone");
    if (!IsFg(h)) throw new Exception("not_foreground");
  }

  public static Dictionary<string, object> Move(IntPtr h, int x, int y, int w, int hh) {
    if (!IsWindow(h)) throw new Exception("target_gone");
    if (IsIconic(h)) ShowWindow(h, 9);
    SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0004 | 0x0010);
    Thread.Sleep(80);
    return Describe(h);
  }

  // Releases modifier keys the system believes are held (a stuck Shift/Ctrl/Alt/Win
  // would otherwise turn typed characters into shortcuts or symbols).
  public static void ReleaseModifiers() {
    int[] vks = { 0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C };
    var ups = new List<INPUT>();
    foreach (var vk in vks) if ((GetAsyncKeyState(vk) & 0x8000) != 0) ups.Add(Key((ushort)vk, 0, 2));
    if (ups.Count > 0) { Send(ups); Thread.Sleep(30); }
  }

  // Types in small chunks so the target can keep up, re-checking before each
  // chunk that the target is still the foreground window.
  public static int TypeText(IntPtr h, string text) {
    RequireForeground(h);
    ReleaseModifiers();
    var batch = new List<INPUT>();
    int done = 0, pending = 0;
    foreach (char c in text) {
      if (c == '\r') { done++; continue; }
      if (c == '\n') { batch.Add(Key(0x0D, 0, 0)); batch.Add(Key(0x0D, 0, 2)); }
      else { batch.Add(Key(0, c, 4)); batch.Add(Key(0, c, 4 | 2)); }
      pending++;
      if (pending >= 20) {
        if (!IsFg(h)) throw new Exception("foreground_lost:" + done);
        Send(batch); batch.Clear(); done += pending; pending = 0;
        Thread.Sleep(15);
      }
    }
    if (pending > 0) {
      if (!IsFg(h)) throw new Exception("foreground_lost:" + done);
      Send(batch); done += pending;
    }
    return done;
  }

  // Pastes the clipboard (Ctrl+V) into the foreground target.
  public static void Paste(IntPtr h) {
    RequireForeground(h);
    ReleaseModifiers();
    Send(new List<INPUT> { Key(0x11, 0, 0), Key(0x56, 0, 0), Key(0x56, 0, 2), Key(0x11, 0, 2) });
  }

  public static void Keys(IntPtr h, int[] mods, int key) {
    RequireForeground(h);
    ReleaseModifiers();
    var inputs = new List<INPUT>();
    foreach (var m in mods) inputs.Add(Key((ushort)m, 0, 0));
    inputs.Add(Key((ushort)key, 0, 0)); inputs.Add(Key((ushort)key, 0, 2));
    for (int i = mods.Length - 1; i >= 0; i--) inputs.Add(Key((ushort)mods[i], 0, 2));
    Send(inputs);
  }

  public static void Click(IntPtr h, int cx, int cy, string button, bool dbl) {
    RequireForeground(h);
    RECT cr; GetClientRect(h, out cr);
    if (cx < 0 || cy < 0 || cx >= cr.Right || cy >= cr.Bottom) throw new Exception("outside_client_area");
    var p = new POINT(); p.X = cx; p.Y = cy;
    ClientToScreen(h, ref p);
    var hit = WindowFromPoint(p);
    if (!PartOfTarget(hit, h)) throw new Exception("target_obscured");
    PointerTo(p.X, p.Y);
    uint down = button == "right" ? 0x0008u : 0x0002u;
    uint up = button == "right" ? 0x0010u : 0x0004u;
    var inputs = new List<INPUT>();
    int n = dbl ? 2 : 1;
    for (int i = 0; i < n; i++) {
      var a = new INPUT(); a.type = 0; a.U.mi.dwFlags = down; inputs.Add(a);
      var b = new INPUT(); b.type = 0; b.U.mi.dwFlags = up; inputs.Add(b);
    }
    Send(inputs);
  }
}
'@

$script:dpiMode = [KeoWin]::EnableDpiAwareness()

# Optional: reading text back for verification (UI Automation). Compiled
# separately so a failure here only disables verification.
$script:uiaReady = $false
try {
  Add-Type -Language CSharp -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;

public static class KeoUia {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  public delegate bool ChildProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, ChildProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

  // Embedded web content (WebView2 in apps such as the WhatsApp app, Electron,
  // Chromium) lives in child windows, sometimes in another process. Some hosts
  // (e.g. WinUI 3 frames) do not lead the classic UI Automation walker into
  // that content, so it is read from these child windows directly as well.
  // Chromium render widgets, WebView2 hosts (also windowless ones inside WinUI 3, such as the
  // WhatsApp app: their accessibility tree switches on only when their own window is asked),
  // WinUI 3 content bridges and UWP core windows.
  public static bool IsContentClass(string cls) {
    return cls == "Chrome_RenderWidgetHostHWND" || cls == "Chrome_WidgetWin_0" || cls == "Chrome_WidgetWin_1" || cls == "Microsoft.UI.Content.DesktopChildSiteBridge" || cls == "Windows.UI.Core.CoreWindow";
  }

  public static List<IntPtr> ContentChildren(IntPtr h) {
    var list = new List<IntPtr>();
    EnumChildWindows(h, (c, l) => {
      if (list.Count >= 8) return false;
      var sb = new StringBuilder(128); GetClassName(c, sb, sb.Capacity);
      var cls = sb.ToString();
      if (IsWindowVisible(c) && IsContentClass(cls)) list.Add(c);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  /** Class names of the window's child windows (diagnostics only; no titles). */
  public static string ChildClasses(IntPtr h) {
    var counts = new Dictionary<string, int>();
    EnumChildWindows(h, (c, l) => {
      var sb = new StringBuilder(128); GetClassName(c, sb, sb.Capacity);
      var k = sb.ToString() + (IsWindowVisible(c) ? "" : " (hidden)");
      int n; counts.TryGetValue(k, out n); counts[k] = n + 1;
      return counts.Count < 40;
    }, IntPtr.Zero);
    return Json.Serialize(counts);
  }

  // UIA text ranges from browsers can fault (access violation) when the page
  // changes mid-read; these methods catch that instead of crashing the helper.
  [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions]
  [System.Security.SecurityCritical]
  public static string ReadText(IntPtr h) {
    var root = AutomationElement.FromHandle(h);
    var cond = new OrCondition(
      new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
      new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
    var all = new List<AutomationElement>();
    foreach (AutomationElement el in root.FindAll(TreeScope.Descendants, cond)) all.Add(el);
    if (all.Count == 0) {
      // Embedded web content the walker cannot reach from the frame (see ContentChildren).
      foreach (var child in ContentChildren(h)) {
        try { foreach (AutomationElement el in AutomationElement.FromHandle(child).FindAll(TreeScope.Subtree, cond)) all.Add(el); } catch { }
      }
    }
    var sb = new StringBuilder();
    foreach (AutomationElement el in all) {
      object p;
      if (el.Current.IsPassword) continue;
      try {
        if (el.TryGetCurrentPattern(TextPattern.Pattern, out p)) { sb.Append(((TextPattern)p).DocumentRange.GetText(400000)); sb.Append('\n'); }
        else if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) { sb.Append(((ValuePattern)p).Current.Value); sb.Append('\n'); }
      } catch (Exception) { }
      if (sb.Length > 400000) break;
    }
    return sb.ToString();
  }

  static string Rid(AutomationElement e) {
    var r = e.GetRuntimeId();
    if (r == null) return "";
    var parts = new string[r.Length];
    for (int i = 0; i < r.Length; i++) parts[i] = r[i].ToString();
    return string.Join(".", parts);
  }

  static int[] ParseRid(string s) {
    var parts = s.Split('.');
    var r = new int[parts.Length];
    for (int i = 0; i < parts.Length; i++) r[i] = int.Parse(parts[i]);
    return r;
  }

  static string Short(ControlType t) {
    var n = t.ProgrammaticName; int i = n.LastIndexOf('.');
    return (i >= 0 ? n.Substring(i + 1) : n).ToLowerInvariant();
  }

  static string Clip(string s, int n) {
    if (s == null) return "";
    s = s.Replace("\r", " ").Replace("\n", " ").Trim();
    return s.Length > n ? s.Substring(0, n) + "…" : s;
  }

  static Dictionary<string, object> Node(AutomationElement e, Rect win, int depth, int parent) {
    var c = e.Current;
    var d = new Dictionary<string, object>();
    d["rid"] = Rid(e);
    d["role"] = Short(c.ControlType);
    var lct = c.LocalizedControlType;
    if (!string.IsNullOrEmpty(lct)) d["lct"] = Clip(lct, 40);
    d["name"] = Clip(c.Name, 200);
    if (!string.IsNullOrEmpty(c.AutomationId)) d["aid"] = Clip(c.AutomationId, 80);
    var r = c.BoundingRectangle;
    if (!r.IsEmpty && !double.IsInfinity(r.X) && !double.IsNaN(r.X)) { d["x"] = (int)(r.X - win.X); d["y"] = (int)(r.Y - win.Y); d["w"] = (int)r.Width; d["h"] = (int)r.Height; }
    d["depth"] = depth; d["parent"] = parent;
    if (!c.IsEnabled) d["disabled"] = true;
    if (c.IsOffscreen) d["offscreen"] = true;
    if (c.HasKeyboardFocus) d["focused"] = true;
    if (c.IsPassword) d["password"] = true;
    var pats = new List<string>();
    object p;
    if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) pats.Add("invoke");
    if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { pats.Add("toggle"); d["toggle"] = ((TogglePattern)p).Current.ToggleState.ToString().ToLowerInvariant(); }
    if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { pats.Add("select"); if (((SelectionItemPattern)p).Current.IsSelected) d["selected"] = true; }
    if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { pats.Add("expand"); d["expanded"] = ((ExpandCollapsePattern)p).Current.ExpandCollapseState.ToString().ToLowerInvariant(); }
    if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
      pats.Add("value");
      var vp = (ValuePattern)p;
      if (vp.Current.IsReadOnly) d["readonly"] = true;
      if (!c.IsPassword) d["value"] = Clip(vp.Current.Value, 400);
    }
    if (e.TryGetCurrentPattern(ScrollPattern.Pattern, out p)) pats.Add("scroll");
    if (e.TryGetCurrentPattern(TextPattern.Pattern, out p)) pats.Add("text");
    if (pats.Count > 0) d["patterns"] = pats;
    return d;
  }

  public static string Snapshot(IntPtr h, int maxNodes, int maxDepth, int budgetMs) {
    var sw = Stopwatch.StartNew();
    var root = AutomationElement.FromHandle(h);
    var win = root.Current.BoundingRectangle;
    var list = new List<Dictionary<string, object>>();
    var walker = TreeWalker.ControlViewWalker;
    var stack = new Stack<Tuple<AutomationElement, int, int>>();
    stack.Push(Tuple.Create(root, 0, -1));
    bool truncated = false;
    while (stack.Count > 0) {
      if (list.Count >= maxNodes || sw.ElapsedMilliseconds > budgetMs) { truncated = true; break; }
      var t = stack.Pop();
      Dictionary<string, object> n;
      try { n = Node(t.Item1, win, t.Item2, t.Item3); } catch { continue; }
      int idx = list.Count; n["i"] = idx; list.Add(n);
      if (t.Item2 >= maxDepth) continue;
      var kids = new List<AutomationElement>();
      try {
        var ch = walker.GetFirstChild(t.Item1);
        while (ch != null && kids.Count < 300) { kids.Add(ch); ch = walker.GetNextSibling(ch); }
      } catch { }
      for (int k = kids.Count - 1; k >= 0; k--) stack.Push(Tuple.Create(kids[k], t.Item2 + 1, idx));
    }
    var seen = new HashSet<string>();
    foreach (var n in list) seen.Add((string)n["rid"]);
    int extraRoots = 0;
    foreach (var child in ContentChildren(h)) {
      if (truncated) break;
      AutomationElement croot;
      try { croot = AutomationElement.FromHandle(child); } catch { continue; }
      var cstack = new Stack<Tuple<AutomationElement, int, int>>();
      cstack.Push(Tuple.Create(croot, 1, 0));
      bool added = false;
      while (cstack.Count > 0) {
        if (list.Count >= maxNodes || sw.ElapsedMilliseconds > budgetMs) { truncated = true; break; }
        var t = cstack.Pop();
        Dictionary<string, object> n;
        try { n = Node(t.Item1, win, t.Item2, t.Item3); } catch { continue; }
        var r = (string)n["rid"];
        // An element already seen (e.g. the host pane, empty when reached from the frame) is
        // not added again, but its children are read from here.
        int idx;
        if (seen.Contains(r)) idx = -1; else { seen.Add(r); idx = list.Count; n["i"] = idx; list.Add(n); added = true; }
        if (t.Item2 >= maxDepth) continue;
        var kids = new List<AutomationElement>();
        try {
          var ch = walker.GetFirstChild(t.Item1);
          while (ch != null && kids.Count < 300) { kids.Add(ch); ch = walker.GetNextSibling(ch); }
        } catch { }
        int parentIdx = idx >= 0 ? idx : t.Item3;
        for (int k = kids.Count - 1; k >= 0; k--) cstack.Push(Tuple.Create(kids[k], t.Item2 + 1, parentIdx));
      }
      if (added) extraRoots++;
    }
    var res = new Dictionary<string, object>();
    res["nodes"] = list; res["truncated"] = truncated; res["ms"] = sw.ElapsedMilliseconds; res["contentRoots"] = extraRoots;
    var wd = new Dictionary<string, object>(); wd["w"] = (int)win.Width; wd["h"] = (int)win.Height; wd["x"] = (int)win.X; wd["y"] = (int)win.Y;
    res["window"] = wd;
    return Json.Serialize(res);
  }

  static AutomationElement Find(IntPtr h, string rid) {
    var root = AutomationElement.FromHandle(h);
    if (Rid(root) == rid) return root;
    var cond = new PropertyCondition(AutomationElement.RuntimeIdProperty, ParseRid(rid));
    var hit = root.FindFirst(TreeScope.Descendants, cond);
    if (hit != null) return hit;
    foreach (var child in ContentChildren(h)) {
      try {
        var croot = AutomationElement.FromHandle(child);
        if (Rid(croot) == rid) return croot;
        hit = croot.FindFirst(TreeScope.Descendants, cond);
        if (hit != null) return hit;
      } catch { }
    }
    return null;
  }

  // Names inside each element through the RAW view: web pages often hide
  // their text from the control view (e.g. WhatsApp Web message bubbles).
  // Bounded per element; password fields are skipped.
  public static string Texts(IntPtr h, string rids, int budgetMs) {
    var sw = Stopwatch.StartNew();
    var walker = TreeWalker.RawViewWalker;
    var res = new List<object>();
    foreach (var rid in rids.Split('|')) {
      var names = new List<string>();
      AutomationElement e = null;
      try { if (sw.ElapsedMilliseconds < budgetMs) e = Find(h, rid); } catch (Exception) { }
      if (e != null) {
        var stack = new Stack<AutomationElement>();
        stack.Push(e);
        int seen = 0;
        while (stack.Count > 0 && seen < 300 && names.Count < 60 && sw.ElapsedMilliseconds < budgetMs) {
          var x = stack.Pop(); seen++;
          try {
            var c = x.Current;
            if (c.IsPassword) continue;
            var nm = c.Name;
            // Message text lives in Text elements; other controls only contribute short labels (sender, status, time).
            bool keep = c.ControlType == ControlType.Text || nm.Length <= 24;
            if (keep && !string.IsNullOrEmpty(nm) && x != e && (names.Count == 0 || names[names.Count - 1] != nm)) names.Add(nm.Length > 1000 ? nm.Substring(0, 1000) : nm);
            var kids = new List<AutomationElement>();
            var ch = walker.GetFirstChild(x);
            while (ch != null && kids.Count < 100) { kids.Add(ch); ch = walker.GetNextSibling(ch); }
            for (int k = kids.Count - 1; k >= 0; k--) stack.Push(kids[k]);
          } catch (Exception) { }
        }
      }
      res.Add(names);
    }
    return Json.Serialize(res);
  }

  public static string Describe(IntPtr h, string rid) {
    var e = Find(h, rid);
    if (e == null) return "null";
    var win = AutomationElement.FromHandle(h).Current.BoundingRectangle;
    return Json.Serialize(Node(e, win, 0, -1));
  }

  public static string Center(IntPtr h, string rid) {
    var e = Find(h, rid);
    if (e == null) throw new Exception("element_gone");
    var r = e.Current.BoundingRectangle;
    if (r.IsEmpty || e.Current.IsOffscreen) throw new Exception("element_offscreen");
    var d = new Dictionary<string, object>(); d["x"] = (int)(r.X + r.Width / 2); d["y"] = (int)(r.Y + r.Height / 2);
    return Json.Serialize(d);
  }

  static AutomationElement ScrollTarget(AutomationElement e) {
    var walker = TreeWalker.ControlViewWalker;
    var cur = e;
    for (int i = 0; i < 12 && cur != null; i++) {
      object p;
      if (cur.TryGetCurrentPattern(ScrollPattern.Pattern, out p) && ((ScrollPattern)p).Current.VerticallyScrollable) return cur;
      cur = walker.GetParent(cur);
    }
    return null;
  }

  public static string Act(IntPtr h, string rid, string action, string text) {
    var e = Find(h, rid);
    if (e == null) throw new Exception("element_gone");
    if (!e.Current.IsEnabled) throw new Exception("element_disabled");
    object p; string method = "";
    switch (action) {
      case "invoke":
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); method = "invoke"; }
        else if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); method = "select"; }
        else if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); method = "toggle"; }
        else if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); method = "expand"; }
        else throw new Exception("no_invoke_pattern");
        break;
      case "toggle":
        if (!e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) throw new Exception("unsupported_action");
        ((TogglePattern)p).Toggle(); method = "toggle"; break;
      case "select":
        if (!e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) throw new Exception("unsupported_action");
        ((SelectionItemPattern)p).Select(); method = "select"; break;
      case "expand":
        if (!e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) throw new Exception("unsupported_action");
        ((ExpandCollapsePattern)p).Expand(); method = "expand"; break;
      case "collapse":
        if (!e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) throw new Exception("unsupported_action");
        ((ExpandCollapsePattern)p).Collapse(); method = "collapse"; break;
      case "focus":
        // Chromium refuses UIA focus for some web controls; report it instead of a raw exception.
        try { e.SetFocus(); } catch (Exception) { throw new Exception("not_focusable"); }
        method = "focus"; break;
      case "set_value":
        if (e.Current.IsPassword) throw new Exception("password_field");
        if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out p) || ((ValuePattern)p).Current.IsReadOnly) throw new Exception("no_value_pattern");
        try { ((ValuePattern)p).SetValue(text); } catch (Exception) { throw new Exception("value_rejected"); }
        method = "value"; break;
      case "scroll_down": case "scroll_up": case "page_down": case "page_up": {
        var st = ScrollTarget(e);
        if (st == null) throw new Exception("no_scroll_pattern");
        var sp = (ScrollPattern)st.GetCurrentPattern(ScrollPattern.Pattern);
        var amt = action == "scroll_down" ? ScrollAmount.SmallIncrement : action == "scroll_up" ? ScrollAmount.SmallDecrement : action == "page_down" ? ScrollAmount.LargeIncrement : ScrollAmount.LargeDecrement;
        sp.ScrollVertical(amt); method = "scroll"; break;
      }
      default: throw new Exception("unsupported_action");
    }
    var d = new Dictionary<string, object>(); d["method"] = method;
    return Json.Serialize(d);
  }

  // Fallback page text: names of text-bearing controls in tree order (no text ranges).
  static string CollectText(AutomationElement root, int maxChars, int budgetMs) {
    var sw = Stopwatch.StartNew();
    var sb = new StringBuilder();
    var walker = TreeWalker.ControlViewWalker;
    var stack = new Stack<AutomationElement>();
    stack.Push(root);
    while (stack.Count > 0 && sb.Length < maxChars && sw.ElapsedMilliseconds < budgetMs) {
      var e = stack.Pop();
      try {
        var c = e.Current;
        if (!c.IsPassword && !c.IsOffscreen) {
          var t = c.ControlType;
          if ((t == ControlType.Text || t == ControlType.Hyperlink || t == ControlType.ListItem || t == ControlType.DataItem || t == ControlType.Header || t == ControlType.HeaderItem) && !string.IsNullOrEmpty(c.Name)) { sb.Append(c.Name.Trim()); sb.Append('\n'); }
        }
        var kids = new List<AutomationElement>();
        var ch = walker.GetFirstChild(e);
        while (ch != null && kids.Count < 400) { kids.Add(ch); ch = walker.GetNextSibling(ch); }
        for (int k = kids.Count - 1; k >= 0; k--) stack.Push(kids[k]);
      } catch (Exception) { }
    }
    var s = sb.ToString();
    return s.Length > maxChars ? s.Substring(0, maxChars) : s;
  }

  // Current tab context from a browser window: address bar value, the
  // selection and readable text of the page document (no cookies, no history).
  [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions]
  [System.Security.SecurityCritical]
  public static string BrowserContext(IntPtr h, int maxChars) {
    var root = AutomationElement.FromHandle(h);
    string url = null;
    var edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
    foreach (AutomationElement ed in edits) {
      var nm = (ed.Current.Name ?? "").ToLowerInvariant();
      if (ed.Current.IsPassword) continue;
      if (nm.Contains("address") || nm.Contains("url") || nm.Contains("search or enter") || nm.Contains("search with")) {
        object vp;
        if (ed.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) { url = ((ValuePattern)vp).Current.Value; break; }
      }
    }
    string selection = "", page = "", docName = "";
    bool textAvailable = false;
    // Pages change while being read (text ranges become invalid), so retry once.
    for (int attempt = 0; attempt < 2 && page.Trim().Length == 0; attempt++) {
      if (attempt > 0) System.Threading.Thread.Sleep(250);
      AutomationElementCollection docs;
      try { docs = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document)); } catch { continue; }
      foreach (AutomationElement d in docs) {
        try {
          object tp;
          if (!d.TryGetCurrentPattern(TextPattern.Pattern, out tp)) continue;
          textAvailable = true;
          var t = (TextPattern)tp;
          try {
            selection = "";
            foreach (var r in t.GetSelection()) { selection += r.GetText(20000); if (selection.Length > 20000) break; }
          } catch (Exception) { selection = ""; }
          page = t.DocumentRange.GetText(maxChars);
          docName = d.Current.Name ?? "";
          if (page.Trim().Length > 0) break;
        } catch (Exception) { page = ""; }
      }
    }
    string method = "text_pattern";
    if (page.Trim().Length == 0) {
      page = CollectText(root, maxChars, 6000);
      method = "control_names";
    }
    var res = new Dictionary<string, object>();
    res["url"] = url; res["documentName"] = Clip(docName, 300); res["textAvailable"] = textAvailable || page.Length > 0; res["selection"] = selection; res["page"] = page; res["method"] = method;
    return Json.Serialize(res);
  }
}
'@
  $script:uiaReady = $true
} catch { $script:uiaReady = $false }


function ReplyRaw($id, $json) {
  [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"result":' + $json + '}')
  [Console]::Out.Flush()
}

function RequireUia() { if (-not $script:uiaReady) { throw 'uia_unavailable' } }

function Reply($id, $ok, $payload) {
  $o = @{ id = $id; ok = $ok }
  if ($ok) { $o.result = $payload } else { $o.error = $payload }
  [Console]::Out.WriteLine((ConvertTo-Json $o -Compress -Depth 6))
  [Console]::Out.Flush()
}

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $req = $null
  try {
    $req = ConvertFrom-Json $line
    $h = [IntPtr]::Zero
    if ($req.args -and $req.args.hwnd) { $h = [IntPtr][long]$req.args.hwnd }
    switch ($req.cmd) {
      'list'  { Reply $req.id $true @([KeoWin]::List()) }
      'info'  { if ([KeoWin]::IsWindow($h)) { Reply $req.id $true ([KeoWin]::Describe($h)) } else { Reply $req.id $true $null } }
      'focus' { Reply $req.id $true @{ foreground = [KeoWin]::Focus($h) } }
      'move'  { Reply $req.id $true ([KeoWin]::Move($h, [int]$req.args.x, [int]$req.args.y, [int]$req.args.width, [int]$req.args.height)) }
      'type'  { Reply $req.id $true @{ chars = [KeoWin]::TypeText($h, [string]$req.args.text) } }
      'paste' { [KeoWin]::Paste($h); Reply $req.id $true @{ pasted = $true } }
      'post_text' { Reply $req.id $true @{ chars = [KeoWin]::PostText($h, [string]$req.args.text) } }
      'post_key' { [KeoWin]::PostKey($h, [int]$req.args.key); Reply $req.id $true @{ sent = $true } }
      'post_paste' { Reply $req.id $true @{ chars = [KeoWin]::PostPaste($h) } }
      'post_click_screen' { [KeoWin]::PostClickScreen($h, [int]$req.args.x, [int]$req.args.y); Reply $req.id $true @{ clicked = $true } }
      'readtext' {
        if (-not $script:uiaReady) { Reply $req.id $true @{ available = $false; text = '' } }
        elseif (-not [KeoWin]::IsWindow($h)) { Reply $req.id $false @{ code = 'helper_error'; message = 'target_gone' } }
        else { Reply $req.id $true @{ available = $true; text = [KeoUia]::ReadText($h) } }
      }
      'child_classes' { RequireUia; ReplyRaw $req.id ([KeoUia]::ChildClasses($h)) }
      'uia_snapshot' { RequireUia; ReplyRaw $req.id ([KeoUia]::Snapshot($h, [int]$req.args.maxNodes, [int]$req.args.maxDepth, [int]$req.args.budgetMs)) }
      'uia_describe' { RequireUia; ReplyRaw $req.id ([KeoUia]::Describe($h, [string]$req.args.rid)) }
      'uia_act'      { RequireUia; ReplyRaw $req.id ([KeoUia]::Act($h, [string]$req.args.rid, [string]$req.args.action, [string]$req.args.text)) }
      'uia_center'   { RequireUia; ReplyRaw $req.id ([KeoUia]::Center($h, [string]$req.args.rid)) }
      'uia_texts'    { RequireUia; ReplyRaw $req.id ([KeoUia]::Texts($h, [string]$req.args.rids, [int]$req.args.budgetMs)) }
      'browser_context' { RequireUia; ReplyRaw $req.id ([KeoUia]::BrowserContext($h, [int]$req.args.maxChars)) }
      'proc_windows' { Reply $req.id $true @([KeoWin]::ProcessWindows([uint32]$req.args.pid)) }
      'click_screen' { [KeoWin]::ClickScreen($h, [int]$req.args.x, [int]$req.args.y); Reply $req.id $true @{ clicked = $true } }
      'draw'      { Reply $req.id $true @{ points = [KeoWin]::Draw($h, [int[]]@($req.args.points)) } }
      'post_draw' {
        # The synthetic pen first (drawing apps take it); posted mouse messages if there is no pen device.
        $pts = [int[]]@($req.args.points)
        try { Reply $req.id $true @{ points = [KeoWin]::PenDraw($h, $pts); via = 'pen' } }
        catch { if ("$($_.Exception.InnerException.Message)$($_.Exception.Message)" -match 'pen_unavailable') { Reply $req.id $true @{ points = [KeoWin]::PostDraw($h, $pts); via = 'messages' } } else { throw } }
      }
      'wheel'        { [KeoWin]::Wheel($h, [int]$req.args.x, [int]$req.args.y, [int]$req.args.notches); Reply $req.id $true @{ scrolled = $true } }
      'keys'  { [KeoWin]::Keys($h, [int[]]@($req.args.mods), [int]$req.args.key); Reply $req.id $true @{ sent = $true } }
      'click' { [KeoWin]::Click($h, [int]$req.args.x, [int]$req.args.y, [string]$req.args.button, [bool]$req.args.double); Reply $req.id $true @{ clicked = $true } }
      'clipboard_files' {
        # One existing file, as if copied in Explorer (for attaching it with Ctrl+V).
        $p = [string]$req.args.path
        if (-not [System.IO.File]::Exists($p)) { throw 'file_missing' }
        Add-Type -AssemblyName System.Windows.Forms
        if ([bool]$req.args.image) {
          # A picture goes on as the image itself (bitmap + PNG): web-based apps such as WhatsApp
          # Desktop take a pasted image (with a caption box) but not a pasted file.
          Add-Type -AssemblyName System.Drawing
          $bytes = [System.IO.File]::ReadAllBytes($p)
          $img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(,$bytes)))
          $png = New-Object System.IO.MemoryStream
          $img.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
          $do = New-Object System.Windows.Forms.DataObject
          $do.SetImage($img)
          $do.SetData('PNG', $false, $png)
          [System.Windows.Forms.Clipboard]::SetDataObject($do, $true)
          Reply $req.id $true @{ set = $true; image = $true }
        } else {
          $c = New-Object System.Collections.Specialized.StringCollection
          [void]$c.Add($p)
          [System.Windows.Forms.Clipboard]::SetFileDropList($c)
          Reply $req.id $true @{ set = $true }
        }
      }
      'ping'  { Reply $req.id $true @{ pong = $true; dpi = $script:dpiMode } }
      'idle'  { Reply $req.id $true @{ idleMs = [KeoWin]::IdleMs(); foreground = [KeoWin]::ForegroundHwnd() } }
      'covered' { Reply $req.id $true @{ share = [KeoWin]::CoveredShare($h) } }
      default { Reply $req.id $false @{ code = 'unknown_command'; message = 'Unknown command' } }
    }
  } catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    $rid = 0
    if ($req) { $rid = $req.id }
    Reply $rid $false @{ code = 'helper_error'; message = [string]$msg }
  }
}
`;

/**
 * Second helper, only for the modern (COM) UI Automation client. It must run in
 * its own process: once the classic .NET client has been used in a process,
 * the COM client there also sees WinUI 3 / WebView2 apps (the WhatsApp app) as
 * an empty frame. Started on first need; same line-based JSON protocol.
 */
export const MODERN_UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
Add-Type -Language CSharp -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

// Modern UI Automation (the COM client Narrator and Inspect use). The classic
// .NET client sees WinUI 3 apps that host web content without a child window
// (e.g. the WhatsApp app) as empty; this one reads them. Used only for windows
// the classic reader returns empty, with the same JSON shapes.
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoUia {
  void CompareElements(); void CompareRuntimeIds(); void GetRootElement();
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaElement ElementFromHandle(IntPtr hwnd);
  void ElementFromPoint(); void GetFocusedElement(); void GetRootElementBuildCache(); void ElementFromHandleBuildCache();
  void ElementFromPointBuildCache(); void GetFocusedElementBuildCache(); void CreateTreeWalker();
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaWalker GetControlViewWalker();
  void GetContentViewWalker();
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaWalker GetRawViewWalker();
  void GetRawViewCondition();
  [return: MarshalAs(UnmanagedType.IUnknown)] object GetControlViewCondition();
  void GetContentViewCondition();
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaCacheRequest CreateCacheRequest();
}

[ComImport, Guid("b32a92b5-bc25-4078-9c08-d7ee95c48e03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoUiaCacheRequest {
  void AddProperty(int propertyId);
  void AddPattern(int patternId);
  void Clone();
  void GetTreeScope();
  void SetTreeScope(int scope);
  void GetTreeFilter();
  void SetTreeFilter([MarshalAs(UnmanagedType.IUnknown)] object filter);
}

[ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoUiaElementArray {
  int GetLength();
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaElement GetElement(int index);
}

[ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoUiaWalker {
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaElement GetParentElement([MarshalAs(UnmanagedType.Interface)] IKeoUiaElement e);
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaElement GetFirstChildElement([MarshalAs(UnmanagedType.Interface)] IKeoUiaElement e);
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaElement GetLastChildElement([MarshalAs(UnmanagedType.Interface)] IKeoUiaElement e);
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaElement GetNextSiblingElement([MarshalAs(UnmanagedType.Interface)] IKeoUiaElement e);
}

[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoUiaElement {
  void SetFocus();
  [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)] int[] GetRuntimeId();
  void FindFirst(); void FindAll(); void FindFirstBuildCache(); void FindAllBuildCache();
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaElement BuildUpdatedCache([MarshalAs(UnmanagedType.Interface)] IKeoUiaCacheRequest request);
  [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int propertyId);
  void GetCurrentPropertyValueEx();
  [return: MarshalAs(UnmanagedType.Struct)] object GetCachedPropertyValue(int propertyId);
  void GetCachedPropertyValueEx(); void GetCurrentPatternAs(); void GetCachedPatternAs();
  [return: MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int patternId);
  void GetCachedPattern(); void GetCachedParent();
  [return: MarshalAs(UnmanagedType.Interface)] IKeoUiaElementArray GetCachedChildren();
}

[ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoInvoke { void Invoke(); }
[ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoValue { void SetValue([MarshalAs(UnmanagedType.BStr)] string v); }
[ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoToggle { void Toggle(); }
[ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoSelectionItem { void Select(); }
[ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoExpandCollapse { void Expand(); void Collapse(); }
[ComImport, Guid("88f4d42a-e881-459d-a77c-73bbbb7e02dc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKeoScroll { void Scroll(int horizontal, int vertical); }

public static class KeoUia3 {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  public delegate bool ChildProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, ChildProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

  // Same embedded-content windows as the classic reader (WebView2 hosts, WinUI 3 bridges, ...).
  static List<IntPtr> ContentChildren(IntPtr h) {
    var list = new List<IntPtr>();
    EnumChildWindows(h, (c, l) => {
      if (list.Count >= 8) return false;
      var sb = new StringBuilder(128); GetClassName(c, sb, sb.Capacity);
      var cls = sb.ToString();
      if (IsWindowVisible(c) && (cls == "Chrome_RenderWidgetHostHWND" || cls == "Chrome_WidgetWin_0" || cls == "Chrome_WidgetWin_1" || cls == "Microsoft.UI.Content.DesktopChildSiteBridge" || cls == "Windows.UI.Core.CoreWindow")) list.Add(c);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  static IKeoUia uia;
  static IKeoUia U() {
    if (uia == null) uia = (IKeoUia)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e")));
    return uia;
  }

  // Elements of the latest snapshot per window, so actions find them without a new walk.
  static readonly Dictionary<string, IKeoUiaElement> last = new Dictionary<string, IKeoUiaElement>();
  static IntPtr lastWindow = IntPtr.Zero;

  const int P_RECT = 30001, P_TYPE = 30003, P_LCT = 30004, P_NAME = 30005, P_FOCUS = 30008, P_ENABLED = 30010, P_AID = 30011,
    P_PASSWORD = 30019, P_OFFSCREEN = 30022, P_HAS_EXPAND = 30028, P_HAS_INVOKE = 30031, P_HAS_SCROLL = 30034, P_HAS_SELITEM = 30036,
    P_HAS_TEXT = 30040, P_HAS_TOGGLE = 30041, P_HAS_VALUE = 30043, P_VALUE = 30045, P_VALUE_RO = 30046, P_EXPSTATE = 30070,
    P_SELECTED = 30079, P_TOGGLESTATE = 30086;
  const int PAT_INVOKE = 10000, PAT_SCROLL = 10004, PAT_EXPAND = 10005, PAT_VALUE = 10002, PAT_SELITEM = 10010, PAT_TOGGLE = 10015;

  /** Roles whose patterns/values matter for actions; others get name, type and position only. */
  static readonly HashSet<string> Interactive = new HashSet<string> { "button", "edit", "combobox", "checkbox", "radiobutton", "listitem", "dataitem", "treeitem", "tabitem", "menuitem", "hyperlink", "document", "splitbutton", "slider", "spinner", "list", "tree", "tab", "datagrid", "table", "scrollbar" };

  static readonly Dictionary<int, string> Types = new Dictionary<int, string> {
    {50000,"button"},{50001,"calendar"},{50002,"checkbox"},{50003,"combobox"},{50004,"edit"},{50005,"hyperlink"},{50006,"image"},
    {50007,"listitem"},{50008,"list"},{50009,"menu"},{50010,"menubar"},{50011,"menuitem"},{50012,"progressbar"},{50013,"radiobutton"},
    {50014,"scrollbar"},{50015,"slider"},{50016,"spinner"},{50017,"statusbar"},{50018,"tab"},{50019,"tabitem"},{50020,"text"},
    {50021,"toolbar"},{50022,"tooltip"},{50023,"tree"},{50024,"treeitem"},{50025,"custom"},{50026,"group"},{50027,"thumb"},
    {50028,"datagrid"},{50029,"dataitem"},{50030,"document"},{50031,"splitbutton"},{50032,"window"},{50033,"pane"},{50034,"header"},
    {50035,"headeritem"},{50036,"table"},{50037,"titlebar"},{50038,"separator"},{50039,"semanticzoom"},{50040,"appbar"} };

  // Reads come from the element's cache when it was filled in one batch (see Snapshot), else live.
  [ThreadStatic] static bool useCache;
  static object Prop(IKeoUiaElement e, int id) { try { return useCache ? e.GetCachedPropertyValue(id) : e.GetCurrentPropertyValue(id); } catch { return null; } }
  static bool B(IKeoUiaElement e, int id) { var v = Prop(e, id); return v is bool && (bool)v; }
  static string S(IKeoUiaElement e, int id) { var v = Prop(e, id) as string; return v ?? ""; }
  static string CachedRid(IKeoUiaElement e) {
    var r = Prop(e, 30000) as int[];
    if (r == null) return Rid(e);
    var parts = new string[r.Length];
    for (int i = 0; i < r.Length; i++) parts[i] = r[i].ToString();
    return string.Join(".", parts);
  }

  static readonly int[] CachedProps = { 30000, 30001, 30003, 30004, 30005, 30008, 30010, 30011, 30019, 30022, 30028, 30031, 30034, 30036, 30040, 30041, 30043, 30045, 30046, 30070, 30079, 30086 };

  /**
   * One cross-process call per element that returns the element AND its
   * children with every property Keo needs (instead of ~20 calls per
   * element). Caching a whole subtree at once fails on large web pages.
   */
  static bool Duplicate(Dictionary<string, object> n, HashSet<string> containers) {
    if (!IsContainer(n)) return false;
    object x, y, w, h;
    n.TryGetValue("x", out x); n.TryGetValue("y", out y); n.TryGetValue("w", out w); n.TryGetValue("h", out h);
    var key = n["role"] + "|" + n["name"] + "|" + x + "|" + y + "|" + w + "|" + h;
    if (((string)n["name"]).Length == 0) return false; // unnamed wrappers are too common to compare
    return !containers.Add(key);
  }

  static bool IsContainer(Dictionary<string, object> n) {
    var role = (string)n["role"];
    if (role != "pane" && role != "document" && role != "group" && role != "window" && role != "custom") return false;
    object w, h;
    return n.TryGetValue("w", out w) && n.TryGetValue("h", out h) && (int)w >= 40 && (int)h >= 40;
  }

  static IKeoUiaCacheRequest levelReq;
  static IKeoUiaCacheRequest LevelRequest() {
    if (levelReq != null) return levelReq;
    var req = U().CreateCacheRequest();
    foreach (var id in CachedProps) req.AddProperty(id);
    req.SetTreeScope(1); // the element itself
    return levelReq = req;
  }

  /**
   * Adds a subtree to the list (depth-first, bounded), skipping elements already seen.
   * Structure comes from the live walker (it reaches embedded web content); each
   * element's properties arrive in ONE batched call instead of ~20.
   */
  static bool AddCached(IKeoUiaElement root, double wx, double wy, int depth, int parent, List<Dictionary<string, object>> list, HashSet<string> seen, int maxNodes, int maxDepth, Stopwatch sw, int budgetMs) {
    var req = LevelRequest();
    var walker = U().GetControlViewWalker();
    var stack = new Stack<Tuple<IKeoUiaElement, int, int>>();
    stack.Push(Tuple.Create(root, depth, parent));
    bool truncated = false;
    while (stack.Count > 0) {
      if (list.Count >= maxNodes || sw.ElapsedMilliseconds > budgetMs) { truncated = true; break; }
      var t = stack.Pop();
      IKeoUiaElement filled;
      try { filled = t.Item1.BuildUpdatedCache(req); } catch { continue; }
      Dictionary<string, object> n;
      try { n = Node(filled, wx, wy, t.Item2, t.Item3); } catch { continue; }
      var r = (string)n["rid"];
      int idx;
      if (seen.Contains(r)) idx = -1; else { seen.Add(r); idx = list.Count; n["i"] = idx; list.Add(n); last[r] = t.Item1; }
      if (t.Item2 >= maxDepth) continue;
      int parentIdx = idx >= 0 ? idx : t.Item3;
      var kids = new List<IKeoUiaElement>();
      try { var ch = walker.GetFirstChildElement(t.Item1); while (ch != null && kids.Count < 300) { kids.Add(ch); ch = walker.GetNextSiblingElement(ch); } } catch { }
      for (int k = kids.Count - 1; k >= 0; k--) stack.Push(Tuple.Create(kids[k], t.Item2 + 1, parentIdx));
    }
    return truncated;
  }

  static string Rid(IKeoUiaElement e) {
    var r = e.GetRuntimeId();
    if (r == null) return "";
    var parts = new string[r.Length];
    for (int i = 0; i < r.Length; i++) parts[i] = r[i].ToString();
    return string.Join(".", parts);
  }

  static string Clip(string s, int n) {
    if (s == null) return "";
    s = s.Replace("\r", " ").Replace("\n", " ").Trim();
    return s.Length > n ? s.Substring(0, n) + "…" : s;
  }

  static double[] Rect(IKeoUiaElement e) { return Prop(e, P_RECT) as double[]; }

  static Dictionary<string, object> Node(IKeoUiaElement e, double wx, double wy, int depth, int parent) {
    var d = new Dictionary<string, object>();
    d["rid"] = useCache ? CachedRid(e) : Rid(e);
    var t = Prop(e, P_TYPE);
    string role; d["role"] = (t is int && Types.TryGetValue((int)t, out role)) ? role : "custom";
    var roleName = (string)d["role"];
    bool interactive = Interactive.Contains(roleName);
    if (interactive) { var lct = S(e, P_LCT); if (lct.Length > 0) d["lct"] = Clip(lct, 40); }
    d["name"] = Clip(S(e, P_NAME), 200);
    var aid = S(e, P_AID); if (aid.Length > 0) d["aid"] = Clip(aid, 80);
    var r = Rect(e);
    if (r != null && r.Length == 4 && !double.IsInfinity(r[0]) && !double.IsNaN(r[0]) && r[2] > 0) { d["x"] = (int)(r[0] - wx); d["y"] = (int)(r[1] - wy); d["w"] = (int)r[2]; d["h"] = (int)r[3]; }
    d["depth"] = depth; d["parent"] = parent;
    if (B(e, P_OFFSCREEN)) d["offscreen"] = true;
    if (!interactive) return d; // text, panes and groups: name, type and position are enough
    if (!B(e, P_ENABLED)) d["disabled"] = true;
    if (B(e, P_FOCUS)) d["focused"] = true;
    bool pw = B(e, P_PASSWORD); if (pw) d["password"] = true;
    var pats = new List<string>();
    if (B(e, P_HAS_INVOKE)) pats.Add("invoke");
    if (B(e, P_HAS_TOGGLE)) { pats.Add("toggle"); var ts = Prop(e, P_TOGGLESTATE); d["toggle"] = ts is int ? ((int)ts == 1 ? "on" : (int)ts == 2 ? "indeterminate" : "off") : "off"; }
    if (B(e, P_HAS_SELITEM)) { pats.Add("select"); if (B(e, P_SELECTED)) d["selected"] = true; }
    if (B(e, P_HAS_EXPAND)) { pats.Add("expand"); var es = Prop(e, P_EXPSTATE); d["expanded"] = es is int ? ((int)es == 1 ? "expanded" : (int)es == 2 ? "partiallyexpanded" : (int)es == 3 ? "leafnode" : "collapsed") : "collapsed"; }
    if (B(e, P_HAS_VALUE)) {
      pats.Add("value");
      if (B(e, P_VALUE_RO)) d["readonly"] = true;
      if (!pw) d["value"] = Clip(S(e, P_VALUE), 400);
    }
    if (B(e, P_HAS_SCROLL)) pats.Add("scroll");
    if (B(e, P_HAS_TEXT)) pats.Add("text");
    if (pats.Count > 0) d["patterns"] = pats;
    return d;
  }

  public static string Snapshot(IntPtr h, int maxNodes, int maxDepth, int budgetMs) {
    // Batched (cached) reads hang on some WebView2 elements, so the live walk is used,
    // reading pattern details only for elements that can be interacted with (see Node).
    return SnapshotWalk(h, maxNodes, maxDepth, budgetMs);
  }

  static string SnapshotCached(IntPtr h, int maxNodes, int maxDepth, int budgetMs) {
    var sw = Stopwatch.StartNew();
    var root = U().ElementFromHandle(h);
    var wr = Rect(root) ?? new double[] { 0, 0, 0, 0 };
    IKeoUiaElement croot = root;
    try { LevelRequest(); } catch { return null; }
    var list = new List<Dictionary<string, object>>();
    var seen = new HashSet<string>();
    last.Clear(); lastWindow = h;
    bool truncated;
    int extraRoots = 0;
    useCache = true;
    try {
      truncated = AddCached(croot, wr[0], wr[1], 0, -1, list, seen, maxNodes, maxDepth, sw, budgetMs);
      foreach (var child in ContentChildren(h)) {
        if (truncated) break;
        IKeoUiaElement c;
        try { c = U().ElementFromHandle(child); } catch { c = null; }
        if (c == null) continue;
        int before = list.Count;
        truncated = AddCached(c, wr[0], wr[1], 1, 0, list, seen, maxNodes, maxDepth, sw, budgetMs);
        if (list.Count > before) extraRoots++;
      }
    } finally { useCache = false; }
    var res = new Dictionary<string, object>();
    res["nodes"] = list; res["truncated"] = truncated; res["ms"] = sw.ElapsedMilliseconds; res["engine"] = "uia3-batched"; res["contentRoots"] = extraRoots;
    var wd = new Dictionary<string, object>(); wd["w"] = (int)wr[2]; wd["h"] = (int)wr[3]; wd["x"] = (int)wr[0]; wd["y"] = (int)wr[1];
    res["window"] = wd;
    return Json.Serialize(res);
  }

  static string SnapshotWalk(IntPtr h, int maxNodes, int maxDepth, int budgetMs) {
    var sw = Stopwatch.StartNew();
    var containers = new HashSet<string>();
    var root = U().ElementFromHandle(h);
    var wr = Rect(root) ?? new double[] { 0, 0, 0, 0 };
    var walker = U().GetControlViewWalker();
    var list = new List<Dictionary<string, object>>();
    last.Clear(); lastWindow = h;
    var stack = new Stack<Tuple<IKeoUiaElement, int, int>>();
    stack.Push(Tuple.Create(root, 0, -1));
    bool truncated = false;
    while (stack.Count > 0) {
      if (list.Count >= maxNodes || sw.ElapsedMilliseconds > budgetMs) { truncated = true; break; }
      var t = stack.Pop();
      Dictionary<string, object> n;
      try { n = Node(t.Item1, wr[0], wr[1], t.Item2, t.Item3); } catch { continue; }
      int idx = list.Count; n["i"] = idx; list.Add(n);
      last[(string)n["rid"]] = t.Item1;
      if (t.Item2 >= maxDepth) continue;
      // Scrolled-out parts (old messages, far chats) cannot be acted on: their insides are skipped.
      if (n.ContainsKey("offscreen") && t.Item2 > 1) continue;
      // The same web page can be reachable twice (the host's copy and the browser's own):
      // a large container identical in type, name and place to one already read is not read again.
      if (Duplicate(n, containers)) continue;
      var kids = new List<IKeoUiaElement>();
      try {
        var ch = walker.GetFirstChildElement(t.Item1);
        while (ch != null && kids.Count < 300) { kids.Add(ch); ch = walker.GetNextSiblingElement(ch); }
      } catch { }
      for (int k = kids.Count - 1; k >= 0; k--) stack.Push(Tuple.Create(kids[k], t.Item2 + 1, idx));
    }
    // Embedded web content read from its own windows (see KeoUia.ContentChildren).
    var seen = new HashSet<string>();
    foreach (var n in list) seen.Add((string)n["rid"]);
    int extraRoots = 0;
    var children = ContentChildren(h);
    foreach (var child in children) {
      if (truncated) break;
      IKeoUiaElement croot;
      try { croot = U().ElementFromHandle(child); } catch { continue; }
      var cstack = new Stack<Tuple<IKeoUiaElement, int, int>>();
      cstack.Push(Tuple.Create(croot, 1, 0));
      bool added = false;
      while (cstack.Count > 0) {
        if (list.Count >= maxNodes || sw.ElapsedMilliseconds > budgetMs) { truncated = true; break; }
        var t = cstack.Pop();
        Dictionary<string, object> n;
        try { n = Node(t.Item1, wr[0], wr[1], t.Item2, t.Item3); } catch { continue; }
        var r = (string)n["rid"];
        int idx;
        if (seen.Contains(r)) { idx = -1; } else { seen.Add(r); idx = list.Count; n["i"] = idx; list.Add(n); last[r] = t.Item1; added = true; }
        if (t.Item2 >= maxDepth) continue;
        if (n.ContainsKey("offscreen") && t.Item2 > 1) continue;
        if (Duplicate(n, containers)) continue;
        var kids = new List<IKeoUiaElement>();
        try { var ch = walker.GetFirstChildElement(t.Item1); while (ch != null && kids.Count < 300) { kids.Add(ch); ch = walker.GetNextSiblingElement(ch); } } catch { }
        int parentIdx = idx >= 0 ? idx : t.Item3;
        for (int k = kids.Count - 1; k >= 0; k--) cstack.Push(Tuple.Create(kids[k], t.Item2 + 1, parentIdx));
      }
      if (added) extraRoots++;
    }
    var res = new Dictionary<string, object>();
    res["nodes"] = list; res["truncated"] = truncated; res["ms"] = sw.ElapsedMilliseconds; res["engine"] = "uia3"; res["contentRoots"] = extraRoots;
    var wd = new Dictionary<string, object>(); wd["w"] = (int)wr[2]; wd["h"] = (int)wr[3]; wd["x"] = (int)wr[0]; wd["y"] = (int)wr[1];
    res["window"] = wd;
    return Json.Serialize(res);
  }

  static IKeoUiaElement Find(IntPtr h, string rid) {
    IKeoUiaElement e;
    if (lastWindow == h && last.TryGetValue(rid, out e)) {
      try { if (Rid(e) == rid) return e; } catch { }
    }
    // Bounded walk for an element of an older observation.
    var walker = U().GetControlViewWalker();
    var stack = new Stack<IKeoUiaElement>();
    stack.Push(U().ElementFromHandle(h));
    var sw = Stopwatch.StartNew(); int seen = 0;
    while (stack.Count > 0 && seen < 5000 && sw.ElapsedMilliseconds < 4000) {
      var cur = stack.Pop(); seen++;
      try { if (Rid(cur) == rid) return cur; } catch { continue; }
      try { var ch = walker.GetFirstChildElement(cur); while (ch != null) { stack.Push(ch); ch = walker.GetNextSiblingElement(ch); } } catch { }
    }
    return null;
  }

  public static string Describe(IntPtr h, string rid) {
    var e = Find(h, rid);
    if (e == null) return "null";
    var wr = Rect(U().ElementFromHandle(h)) ?? new double[] { 0, 0, 0, 0 };
    var n = Node(e, wr[0], wr[1], 0, -1);
    return Json.Serialize(n);
  }

  public static string Center(IntPtr h, string rid) {
    var e = Find(h, rid);
    if (e == null) throw new Exception("element_gone");
    if (B(e, P_OFFSCREEN)) throw new Exception("element_offscreen");
    var r = Rect(e);
    if (r == null || r[2] <= 0 || r[3] <= 0) throw new Exception("element_offscreen");
    var d = new Dictionary<string, object>(); d["x"] = (int)(r[0] + r[2] / 2); d["y"] = (int)(r[1] + r[3] / 2);
    return Json.Serialize(d);
  }

  static T Pat<T>(IKeoUiaElement e, int id) where T : class { try { return e.GetCurrentPattern(id) as T; } catch { return null; } }

  public static string Act(IntPtr h, string rid, string action, string text) {
    var e = Find(h, rid);
    if (e == null) throw new Exception("element_gone");
    if (!B(e, P_ENABLED)) throw new Exception("element_disabled");
    string method = "";
    switch (action) {
      case "invoke": {
        var inv = Pat<IKeoInvoke>(e, PAT_INVOKE);
        if (inv != null) { inv.Invoke(); method = "invoke"; break; }
        var sel = Pat<IKeoSelectionItem>(e, PAT_SELITEM);
        if (sel != null) { sel.Select(); method = "select"; break; }
        var tg = Pat<IKeoToggle>(e, PAT_TOGGLE);
        if (tg != null) { tg.Toggle(); method = "toggle"; break; }
        var ex = Pat<IKeoExpandCollapse>(e, PAT_EXPAND);
        if (ex != null) { ex.Expand(); method = "expand"; break; }
        throw new Exception("no_invoke_pattern");
      }
      case "toggle": { var p = Pat<IKeoToggle>(e, PAT_TOGGLE); if (p == null) throw new Exception("unsupported_action"); p.Toggle(); method = "toggle"; break; }
      case "select": { var p = Pat<IKeoSelectionItem>(e, PAT_SELITEM); if (p == null) throw new Exception("unsupported_action"); p.Select(); method = "select"; break; }
      case "expand": { var p = Pat<IKeoExpandCollapse>(e, PAT_EXPAND); if (p == null) throw new Exception("unsupported_action"); p.Expand(); method = "expand"; break; }
      case "collapse": { var p = Pat<IKeoExpandCollapse>(e, PAT_EXPAND); if (p == null) throw new Exception("unsupported_action"); p.Collapse(); method = "collapse"; break; }
      case "focus": try { e.SetFocus(); } catch (Exception) { throw new Exception("not_focusable"); } method = "focus"; break;
      case "set_value": {
        if (B(e, P_PASSWORD)) throw new Exception("password_field");
        var p = Pat<IKeoValue>(e, PAT_VALUE);
        if (p == null || B(e, P_VALUE_RO)) throw new Exception("no_value_pattern");
        try { p.SetValue(text); } catch (Exception) { throw new Exception("value_rejected"); }
        method = "value"; break;
      }
      case "scroll_down": case "scroll_up": case "page_down": case "page_up": {
        // ScrollAmount: 0 LargeDecrement, 1 SmallDecrement, 2 NoAmount, 3 LargeIncrement, 4 SmallIncrement
        IKeoScroll sp = null; var walker = U().GetControlViewWalker(); var cur = e;
        for (int i = 0; i < 12 && cur != null && sp == null; i++) { if (B(cur, P_HAS_SCROLL)) sp = Pat<IKeoScroll>(cur, PAT_SCROLL); if (sp == null) { try { cur = walker.GetParentElement(cur); } catch { cur = null; } } }
        if (sp == null) throw new Exception("no_scroll_pattern");
        int amt = action == "scroll_down" ? 4 : action == "scroll_up" ? 1 : action == "page_down" ? 3 : 0;
        sp.Scroll(2, amt); method = "scroll"; break;
      }
      default: throw new Exception("unsupported_action");
    }
    var d = new Dictionary<string, object>(); d["method"] = method;
    return Json.Serialize(d);
  }

  /** Names inside each element through the RAW view (bounded); password fields skipped. */
  public static string Texts(IntPtr h, string rids, int budgetMs) {
    var sw = Stopwatch.StartNew();
    var walker = U().GetRawViewWalker();
    var outer = new List<List<string>>();
    foreach (var rid in rids.Split('|')) {
      var names = new List<string>();
      IKeoUiaElement e = null;
      try { if (sw.ElapsedMilliseconds < budgetMs) e = Find(h, rid); } catch { }
      if (e != null) {
        var stack = new Stack<IKeoUiaElement>(); stack.Push(e); int seen = 0;
        while (stack.Count > 0 && seen < 200 && sw.ElapsedMilliseconds < budgetMs) {
          var cur = stack.Pop(); seen++;
          if (B(cur, P_PASSWORD)) continue;
          var nm = S(cur, P_NAME); if (nm.Length > 0 && names.Count < 40) names.Add(Clip(nm, 400));
          try { var ch = walker.GetFirstChildElement(cur); var tmp = new List<IKeoUiaElement>(); while (ch != null && tmp.Count < 100) { tmp.Add(ch); ch = walker.GetNextSiblingElement(ch); } for (int k = tmp.Count - 1; k >= 0; k--) stack.Push(tmp[k]); } catch { }
        }
      }
      outer.Add(names);
    }
    return Json.Serialize(outer);
  }

  /** Document/edit values (for read-back), from the latest snapshot's elements or a fresh one. */
  public static string ReadText(IntPtr h) {
    if (lastWindow != h || last.Count == 0) Snapshot(h, 1500, 60, 6000);
    var sb = new StringBuilder();
    foreach (var e in last.Values) {
      try {
        var t = Prop(e, P_TYPE);
        if (!(t is int) || ((int)t != 50004 && (int)t != 50030)) continue;
        if (B(e, P_PASSWORD)) continue;
        var v = S(e, P_VALUE); if (v.Length == 0) v = S(e, P_NAME);
        sb.Append(v); sb.Append('\n');
      } catch { }
      if (sb.Length > 400000) break;
    }
    return sb.ToString();
  }
}
'@

function ReplyRaw($id, $json) {
  [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"result":' + $json + '}')
  [Console]::Out.Flush()
}
function Reply($id, $ok, $payload) {
  $o = @{ id = $id; ok = $ok }
  if ($ok) { $o.result = $payload } else { $o.error = $payload }
  [Console]::Out.WriteLine((ConvertTo-Json $o -Compress -Depth 6))
  [Console]::Out.Flush()
}

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $req = $null
  try {
    $req = ConvertFrom-Json $line
    $h = [IntPtr]::Zero
    if ($req.args -and $req.args.hwnd) { $h = [IntPtr][long]$req.args.hwnd }
    switch ($req.cmd) {
      'uia3_snapshot' { ReplyRaw $req.id ([KeoUia3]::Snapshot($h, [int]$req.args.maxNodes, [int]$req.args.maxDepth, [int]$req.args.budgetMs)) }
      'uia3_describe' { ReplyRaw $req.id ([KeoUia3]::Describe($h, [string]$req.args.rid)) }
      'uia3_act'      { ReplyRaw $req.id ([KeoUia3]::Act($h, [string]$req.args.rid, [string]$req.args.action, [string]$req.args.text)) }
      'uia3_center'   { ReplyRaw $req.id ([KeoUia3]::Center($h, [string]$req.args.rid)) }
      'uia3_texts'    { ReplyRaw $req.id ([KeoUia3]::Texts($h, [string]$req.args.rids, [int]$req.args.budgetMs)) }
      'uia3_readtext' { Reply $req.id $true @{ available = $true; text = [KeoUia3]::ReadText($h) } }
      'ping'          { Reply $req.id $true @{ pong = $true } }
      default { Reply $req.id $false @{ code = 'unknown_command'; message = 'Unknown command' } }
    }
  } catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    $rid = 0
    if ($req) { $rid = $req.id }
    Reply $rid $false @{ code = 'helper_error'; message = [string]$msg }
  }
}
`;
