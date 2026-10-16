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
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

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

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; return i;
  }

  static void Send(List<INPUT> inputs) {
    var arr = inputs.ToArray();
    uint sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
    if (sent != arr.Length) throw new Exception("partial_input:" + sent + "/" + arr.Length);
  }

  public static bool Focus(IntPtr h) {
    if (!IsWindow(h)) throw new Exception("target_gone");
    if (IsIconic(h)) ShowWindow(h, 9);
    // A bare ALT tap lets this process take foreground rights (documented SetForegroundWindow rule).
    Send(new List<INPUT> { Key(0x12, 0, 0), Key(0x12, 0, 2) });
    BringWindowToTop(h);
    SetForegroundWindow(h);
    Thread.Sleep(100);
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
    return GetForegroundWindow() == h;
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
    SetCursorPos(p.X, p.Y);
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

# Optional: reading text back for verification (UI Automation). Compiled
# separately so a failure here only disables verification.
$script:uiaReady = $false
try {
  Add-Type -Language CSharp -ReferencedAssemblies UIAutomationClient, UIAutomationTypes -TypeDefinition @'
using System;
using System.Text;
using System.Windows.Automation;

public static class KeoUia {
  public static string ReadText(IntPtr h) {
    var root = AutomationElement.FromHandle(h);
    var cond = new OrCondition(
      new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
      new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
    var els = root.FindAll(TreeScope.Descendants, cond);
    var sb = new StringBuilder();
    foreach (AutomationElement el in els) {
      object p;
      if (el.TryGetCurrentPattern(TextPattern.Pattern, out p)) { sb.Append(((TextPattern)p).DocumentRange.GetText(400000)); sb.Append('\n'); }
      else if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) { sb.Append(((ValuePattern)p).Current.Value); sb.Append('\n'); }
      if (sb.Length > 400000) break;
    }
    return sb.ToString();
  }
}
'@
  $script:uiaReady = $true
} catch { $script:uiaReady = $false }

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
      'readtext' {
        if (-not $script:uiaReady) { Reply $req.id $true @{ available = $false; text = '' } }
        elseif (-not [KeoWin]::IsWindow($h)) { Reply $req.id $false @{ code = 'helper_error'; message = 'target_gone' } }
        else { Reply $req.id $true @{ available = $true; text = [KeoUia]::ReadText($h) } }
      }
      'keys'  { [KeoWin]::Keys($h, [int[]]@($req.args.mods), [int]$req.args.key); Reply $req.id $true @{ sent = $true } }
      'click' { [KeoWin]::Click($h, [int]$req.args.x, [int]$req.args.y, [string]$req.args.button, [bool]$req.args.double); Reply $req.id $true @{ clicked = $true } }
      'ping'  { Reply $req.id $true @{ pong = $true } }
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
