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
      if (GetAncestor(WindowFromPoint(p), 2) != h) covered++;
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
    d["foreground"] = GetForegroundWindow() == h;
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
    if (GetAncestor(WindowFromPoint(p), 2) != h) throw new Exception("target_obscured");
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
    if (GetAncestor(WindowFromPoint(p), 2) != h) throw new Exception("target_obscured");
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
    if (GetForegroundWindow() != h) {
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
    if (GetForegroundWindow() != h) {
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
    if (GetForegroundWindow() != h) return false;
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
    uint pidUnused;
    uint thread = GetWindowThreadProcessId(h, out pidUnused);
    var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (GetGUIThreadInfo(thread, ref gi) && gi.hwndFocus != IntPtr.Zero && GetAncestor(gi.hwndFocus, 2) == h) return gi.hwndFocus;
    return h;
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
      if (n % 20 == 0 && GetForegroundWindow() != h) throw new Exception("foreground_lost:" + n);
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
    if (GetAncestor(hit, 2) != h) throw new Exception("target_obscured");
    ScreenToClient(hit, ref p);
    var l = new IntPtr((p.Y << 16) | (p.X & 0xFFFF));
    PostMessageW(hit, 0x0200, IntPtr.Zero, l);
    PostMessageW(hit, 0x0201, new IntPtr(1), l);
    PostMessageW(hit, 0x0202, IntPtr.Zero, l);
    Thread.Sleep(60);
  }

  public static void RequireForeground(IntPtr h) {
    if (!IsWindow(h)) throw new Exception("target_gone");
    if (GetForegroundWindow() != h) throw new Exception("not_foreground");
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
        if (GetForegroundWindow() != h) throw new Exception("foreground_lost:" + done);
        Send(batch); batch.Clear(); done += pending; pending = 0;
        Thread.Sleep(15);
      }
    }
    if (pending > 0) {
      if (GetForegroundWindow() != h) throw new Exception("foreground_lost:" + done);
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
    if (GetAncestor(hit, 2) != h) throw new Exception("target_obscured");
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

public static class KeoUia {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

  // UIA text ranges from browsers can fault (access violation) when the page
  // changes mid-read; these methods catch that instead of crashing the helper.
  [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions]
  [System.Security.SecurityCritical]
  public static string ReadText(IntPtr h) {
    var root = AutomationElement.FromHandle(h);
    var cond = new OrCondition(
      new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
      new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
    var els = root.FindAll(TreeScope.Descendants, cond);
    var sb = new StringBuilder();
    foreach (AutomationElement el in els) {
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
    var res = new Dictionary<string, object>();
    res["nodes"] = list; res["truncated"] = truncated; res["ms"] = sw.ElapsedMilliseconds;
    var wd = new Dictionary<string, object>(); wd["w"] = (int)win.Width; wd["h"] = (int)win.Height; wd["x"] = (int)win.X; wd["y"] = (int)win.Y;
    res["window"] = wd;
    return Json.Serialize(res);
  }

  static AutomationElement Find(IntPtr h, string rid) {
    var root = AutomationElement.FromHandle(h);
    if (Rid(root) == rid) return root;
    return root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.RuntimeIdProperty, ParseRid(rid)));
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
      'uia_snapshot' { RequireUia; ReplyRaw $req.id ([KeoUia]::Snapshot($h, [int]$req.args.maxNodes, [int]$req.args.maxDepth, [int]$req.args.budgetMs)) }
      'uia_describe' { RequireUia; ReplyRaw $req.id ([KeoUia]::Describe($h, [string]$req.args.rid)) }
      'uia_act'      { RequireUia; ReplyRaw $req.id ([KeoUia]::Act($h, [string]$req.args.rid, [string]$req.args.action, [string]$req.args.text)) }
      'uia_center'   { RequireUia; ReplyRaw $req.id ([KeoUia]::Center($h, [string]$req.args.rid)) }
      'uia_texts'    { RequireUia; ReplyRaw $req.id ([KeoUia]::Texts($h, [string]$req.args.rids, [int]$req.args.budgetMs)) }
      'browser_context' { RequireUia; ReplyRaw $req.id ([KeoUia]::BrowserContext($h, [int]$req.args.maxChars)) }
      'proc_windows' { Reply $req.id $true @([KeoWin]::ProcessWindows([uint32]$req.args.pid)) }
      'click_screen' { [KeoWin]::ClickScreen($h, [int]$req.args.x, [int]$req.args.y); Reply $req.id $true @{ clicked = $true } }
      'wheel'        { [KeoWin]::Wheel($h, [int]$req.args.x, [int]$req.args.y, [int]$req.args.notches); Reply $req.id $true @{ scrolled = $true } }
      'keys'  { [KeoWin]::Keys($h, [int[]]@($req.args.mods), [int]$req.args.key); Reply $req.id $true @{ sent = $true } }
      'click' { [KeoWin]::Click($h, [int]$req.args.x, [int]$req.args.y, [string]$req.args.button, [bool]$req.args.double); Reply $req.id $true @{ clicked = $true } }
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
