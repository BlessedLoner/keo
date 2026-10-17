import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { SpeechEngine, SpeechEvent } from './wakeService';

/**
 * Helper for the modern Windows (WinRT, Windows 10/11) speech recognizer —
 * the engine behind Windows voice typing, far better with accents than the
 * old desktop (SAPI) engine. It is compiled on first use with the C#
 * compiler that ships with every Windows install (.NET Framework 4), against
 * the Windows metadata in System32\WinMetadata, and speaks the same JSON-lines
 * protocol as the classic helper.
 *
 * Wake listening uses only a fixed phrase list, which Windows recognises on
 * this PC. Free dictation (the command after the wake phrase) may use
 * Microsoft's online speech service when the user has enabled "Online speech
 * recognition" in Windows; otherwise it reports `online_speech_off`.
 */
export const MODERN_SPEECH_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Threading;
using System.Web.Script.Serialization;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Media.SpeechRecognition;

public static class KeoVoice {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static readonly object Gate = new object();
  static SpeechRecognizer wakeRec;
  static SpeechRecognizer capRec;
  static string mode = "idle";
  static double threshold = 0.82;
  static int generation = 0;

  static void Emit(Dictionary<string, object> d) { lock (Gate) { Console.Out.WriteLine(Json.Serialize(d)); Console.Out.Flush(); } }
  static Dictionary<string, object> Ev(string name) { var d = new Dictionary<string, object>(); d["event"] = name; return d; }

  static T Wait<T>(IAsyncOperation<T> op, int seconds) {
    var until = DateTime.UtcNow.AddSeconds(seconds);
    while (op.Status == AsyncStatus.Started && DateTime.UtcNow < until) Thread.Sleep(15);
    if (op.Status == AsyncStatus.Started) { try { op.Cancel(); } catch { } throw new Exception("timeout"); }
    if (op.Status == AsyncStatus.Error) throw Map(op.ErrorCode);
    if (op.Status == AsyncStatus.Canceled) throw new Exception("cancelled");
    return op.GetResults();
  }
  static void WaitAction(IAsyncAction op, int seconds) {
    var until = DateTime.UtcNow.AddSeconds(seconds);
    while (op.Status == AsyncStatus.Started && DateTime.UtcNow < until) Thread.Sleep(15);
    if (op.Status == AsyncStatus.Error) throw Map(op.ErrorCode);
  }
  static Exception Map(Exception e) {
    if (e == null) return new Exception("error");
    uint hr = unchecked((uint)e.HResult);
    if (hr == 0x80045509) return new Exception("online_speech_off:" + e.Message);
    if (e is UnauthorizedAccessException || hr == 0x80070005) return new Exception("no_microphone:" + e.Message);
    return new Exception("speech_error:" + e.Message);
  }

  static Language Lang(string culture) {
    try {
      foreach (var l in SpeechRecognizer.SupportedGrammarLanguages) if (string.Equals(l.LanguageTag, culture, StringComparison.OrdinalIgnoreCase)) return l;
      foreach (var l in SpeechRecognizer.SupportedGrammarLanguages) if (l.LanguageTag.Split('-')[0] == culture.Split('-')[0]) return l;
    } catch { }
    return null;
  }

  static SpeechRecognizer Make(string culture) {
    var lang = Lang(culture);
    if (lang == null) throw new Exception("no_recognizer:" + culture);
    return new SpeechRecognizer(lang);
  }

  static List<string> Alts(SpeechRecognitionResult r) {
    var list = new List<string>();
    try { foreach (var a in r.GetAlternates(5)) if (!string.IsNullOrEmpty(a.Text) && list.Count < 5) list.Add(a.Text); } catch { }
    return list;
  }

  static double Conf(SpeechRecognitionResult r) {
    try { return Math.Round(r.RawConfidence, 3); } catch { return r.Confidence == SpeechRecognitionConfidence.High ? 0.9 : r.Confidence == SpeechRecognitionConfidence.Medium ? 0.7 : 0.4; }
  }

  static void StopAll() {
    generation++;
    var w = wakeRec; wakeRec = null;
    var c = capRec; capRec = null;
    if (w != null) { try { WaitAction(w.ContinuousRecognitionSession.CancelAsync(), 3); } catch { } try { w.Dispose(); } catch { } }
    if (c != null) { try { c.Dispose(); } catch { } }
    mode = "idle";
  }

  public static void StartWake(string[] phrases, string culture, double thr) {
    StopAll();
    threshold = thr;
    var gen = generation;
    var r = Make(culture);
    r.Constraints.Add(new SpeechRecognitionListConstraint(phrases, "wake"));
    var comp = Wait(r.CompileConstraintsAsync(), 20);
    if (comp.Status != SpeechRecognitionResultStatus.Success) { r.Dispose(); throw new Exception("compile_failed:" + comp.Status); }
    try { r.ContinuousRecognitionSession.AutoStopSilenceTimeout = TimeSpan.FromHours(12); } catch { }
    r.ContinuousRecognitionSession.ResultGenerated += (s, a) => {
      if (gen != generation || mode != "wake") return;
      var res = a.Result;
      if (res == null || string.IsNullOrEmpty(res.Text)) return;
      var good = res.Confidence == SpeechRecognitionConfidence.High || (res.Confidence == SpeechRecognitionConfidence.Medium && threshold < 0.9);
      if (good) { var d = Ev("wake"); d["phrase"] = res.Text; d["confidence"] = Conf(res); Emit(d); return; }
      var h = Ev("heard"); h["grammar"] = "wake"; h["text"] = res.Text; h["confidence"] = Conf(res); h["alts"] = Alts(res); Emit(h);
    };
    r.ContinuousRecognitionSession.Completed += (s, a) => {
      if (gen != generation || mode != "wake") return;
      // Sessions end on long silence or audio hiccups: start again while wake listening is on.
      new Thread(() => { Thread.Sleep(300); if (gen == generation && mode == "wake") { try { WaitAction(r.ContinuousRecognitionSession.StartAsync(), 10); } catch (Exception e) { Fail(e); } } }) { IsBackground = true }.Start();
    };
    r.RecognitionQualityDegrading += (s, a) => {
      var d = Ev("quality"); d["problem"] = a.Problem.ToString(); Emit(d);
    };
    wakeRec = r;
    mode = "wake";
    // The microphone can still be held for a moment by a capture that just ended.
    try { WaitAction(r.ContinuousRecognitionSession.StartAsync(), 15); }
    catch (Exception) { Thread.Sleep(700); if (gen != generation) return; WaitAction(r.ContinuousRecognitionSession.StartAsync(), 15); }
    Emit(Ev("listening"));
  }

  static string capId = "";

  static Dictionary<string, object> CapEv(string name, string id) { var d = Ev(name); d["id"] = id; return d; }

  public static void Capture(string culture, int initialMs, int endMs, int maxMs) {
    var hadWake = wakeRec != null;
    StopAll();
    var gen = generation;
    var id = capId;
    mode = "capture";
    new Thread(() => {
      // The microphone can still be held for a moment by the wake session that
      // was just stopped; a failed first attempt is retried once.
      if (hadWake) Thread.Sleep(250);
      for (int attempt = 0; attempt < 2; attempt++) {
        SpeechRecognizer r = null;
        try {
          r = Make(culture);
          r.Constraints.Add(new SpeechRecognitionTopicConstraint(SpeechRecognitionScenario.Dictation, "dictation"));
          var comp = Wait(r.CompileConstraintsAsync(), 20);
          if (comp.Status != SpeechRecognitionResultStatus.Success) throw new Exception("online_speech_off:" + comp.Status);
          r.Timeouts.InitialSilenceTimeout = TimeSpan.FromMilliseconds(initialMs);
          r.Timeouts.EndSilenceTimeout = TimeSpan.FromMilliseconds(endMs);
          r.Timeouts.BabbleTimeout = TimeSpan.FromMilliseconds(maxMs);
          if (gen != generation) { r.Dispose(); Emit(CapEv("capture_cancelled", id)); return; }
          capRec = r;
          if (attempt == 0) Emit(CapEv("capturing", id));
          var res = Wait(r.RecognizeAsync(), (maxMs / 1000) + 30);
          if (gen != generation) { Emit(CapEv("capture_cancelled", id)); return; }
          mode = "idle";
          if (res.Status == SpeechRecognitionResultStatus.Success && !string.IsNullOrEmpty(res.Text)) {
            var d = CapEv("command", id); d["text"] = res.Text; d["confidence"] = Conf(res); Emit(d);
          } else {
            var n = CapEv("command_none", id); n["reason"] = res.Status == SpeechRecognitionResultStatus.TimeoutExceeded ? "silence" : res.Status.ToString(); Emit(n);
          }
          return;
        } catch (Exception e) {
          if (gen != generation) { Emit(CapEv("capture_cancelled", id)); return; }
          var code = e.Message.Split(':')[0];
          if (attempt == 0 && code != "online_speech_off" && code != "no_recognizer") {
            try { if (r != null) r.Dispose(); } catch { }
            Thread.Sleep(600);
            continue;
          }
          mode = "idle";
          var er = CapEv("capture_error", id); er["message"] = e.Message; er["code"] = code; Emit(er);
          return;
        }
      }
    }) { IsBackground = true }.Start();
  }

  public static void Test(string[] phrases, string culture, int seconds) {
    StopAll();
    var gen = generation;
    var r = Make(culture);
    r.Constraints.Add(new SpeechRecognitionListConstraint(phrases, "wake"));
    var comp = Wait(r.CompileConstraintsAsync(), 20);
    if (comp.Status != SpeechRecognitionResultStatus.Success) { r.Dispose(); throw new Exception("compile_failed:" + comp.Status); }
    r.Timeouts.InitialSilenceTimeout = TimeSpan.FromSeconds(seconds);
    r.Timeouts.BabbleTimeout = TimeSpan.FromSeconds(seconds);
    capRec = r;
    mode = "test";
    Emit(Ev("testing"));
    new Thread(() => {
      var d = Ev("test_result");
      try {
        var res = Wait(r.RecognizeAsync(), seconds + 20);
        if (gen != generation) return;
        var heard = res.Status == SpeechRecognitionResultStatus.Success && !string.IsNullOrEmpty(res.Text);
        d["grammar"] = heard ? "wake" : null;
        d["text"] = heard ? res.Text : null;
        d["alts"] = heard ? Alts(res) : new List<string>();
        d["confidence"] = heard ? Conf(res) : 0.0;
        d["recognized"] = heard && (res.Confidence == SpeechRecognitionConfidence.High || res.Confidence == SpeechRecognitionConfidence.Medium);
        d["heardSomething"] = heard || res.Status != SpeechRecognitionResultStatus.TimeoutExceeded;
      } catch (Exception e) {
        d["grammar"] = null; d["text"] = null; d["alts"] = new List<string>(); d["confidence"] = 0.0; d["recognized"] = false; d["heardSomething"] = false; d["error"] = e.Message;
      }
      mode = "idle";
      Emit(d);
    }) { IsBackground = true }.Start();
  }

  static void Fail(Exception e) {
    var msg = e.Message;
    var d = Ev("error"); d["code"] = msg.Split(':')[0]; d["message"] = msg; Emit(d);
  }

  static string[] Strings(object o) {
    var list = new List<string>();
    var en = o as System.Collections.IEnumerable;
    if (en != null) foreach (var x in en) if (x != null) list.Add(x.ToString());
    return list.ToArray();
  }

  static void Handle(Dictionary<string, object> cmd) {
    var name = (string)cmd["cmd"];
    switch (name) {
      case "recognizers": {
        var list = new List<Dictionary<string, object>>();
        foreach (var l in SpeechRecognizer.SupportedGrammarLanguages) { var x = new Dictionary<string, object>(); x["culture"] = l.LanguageTag; x["name"] = "Windows speech (" + l.DisplayName + ")"; list.Add(x); }
        var d = Ev("recognizers"); d["list"] = list; Emit(d); break;
      }
      case "wake": StartWake(Strings(cmd["phrases"]), (string)cmd["culture"], Convert.ToDouble(cmd["threshold"], System.Globalization.CultureInfo.InvariantCulture)); break;
      case "pause": StopAll(); Emit(Ev("paused")); break;
      case "capture": capId = cmd.ContainsKey("id") ? Convert.ToString(cmd["id"]) : ""; Capture((string)cmd["culture"], Convert.ToInt32(cmd["initialMs"]), Convert.ToInt32(cmd["endMs"]), Convert.ToInt32(cmd["maxMs"])); break;
      case "cancel_capture": if (mode == "capture") StopAll(); Emit(CapEv("capture_cancelled", capId)); break;
      case "test": Test(Strings(cmd["phrases"]), (string)cmd["culture"], Convert.ToInt32(cmd["seconds"])); break;
      default: { var d = Ev("error"); d["code"] = "unknown_command"; Emit(d); break; }
    }
  }

  public static void Main() {
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    Console.InputEncoding = new System.Text.UTF8Encoding(false);
    Emit(Ev("ready"));
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      try { Handle(Json.Deserialize<Dictionary<string, object>>(line)); }
      catch (Exception e) { Fail(e.InnerException ?? e); }
    }
    StopAll();
  }
}
`;

/** Paths of the .NET Framework C# compiler and the Windows metadata (present on every Windows 10/11). */
function toolchain(): { csc: string; fw: string; wm: string } | null {
  const win = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const fw = path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const wm = path.join(win, 'System32', 'WinMetadata');
  const csc = path.join(fw, 'csc.exe');
  if (!fs.existsSync(csc) || !fs.existsSync(path.join(wm, 'Windows.Media.winmd'))) return null;
  return { csc, fw, wm };
}

/** Compiles the helper once per source version; returns the executable path. */
export function ensureModernHelper(runtimeDir: string): string {
  const tc = toolchain();
  if (!tc) throw new Error('unsupported: this Windows has no .NET Framework 4 compiler or WinRT metadata');
  const hash = crypto.createHash('sha256').update(MODERN_SPEECH_SOURCE).digest('hex').slice(0, 12);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const exe = path.join(runtimeDir, `keo-voice-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;
  const src = path.join(runtimeDir, `keo-voice-${hash}.cs`);
  fs.writeFileSync(src, MODERN_SPEECH_SOURCE, 'utf8');
  const refs = [
    path.join(tc.fw, 'System.Runtime.dll'),
    path.join(tc.fw, 'System.Runtime.InteropServices.WindowsRuntime.dll'),
    path.join(tc.fw, 'System.Web.Extensions.dll'),
    path.join(tc.wm, 'Windows.Foundation.winmd'),
    path.join(tc.wm, 'Windows.Media.winmd'),
    path.join(tc.wm, 'Windows.Globalization.winmd'),
  ];
  const r = spawnSync(tc.csc, ['-nologo', '-optimize+', '-platform:x64', `-out:${exe}`, ...refs.map((x) => `-r:${x}`), src], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  try {
    fs.rmSync(src, { force: true });
  } catch {
    /* ignore */
  }
  if (r.status !== 0 || !fs.existsSync(exe)) throw new Error(`compile_failed: ${(r.stdout || r.stderr || '').split('\n').slice(0, 3).join(' ').slice(0, 300)}`);
  return exe;
}

/** The modern engine: same events and commands as the classic helper. */
export class ModernSpeechEngine implements SpeechEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  constructor(private readonly runtimeDir: string) {}

  start(onEvent: (e: SpeechEvent) => void, onExit: (code: number | null) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') return reject(new Error('Windows only'));
      let exe: string;
      try {
        exe = ensureModernHelper(this.runtimeDir);
      } catch (e) {
        return reject(e as Error);
      }
      const p = spawn(exe, [], { windowsHide: true, stdio: 'pipe' });
      this.proc = p;
      let ready = false;
      const t = setTimeout(() => !ready && reject(new Error('Modern speech helper did not start in time.')), 20000);
      readline.createInterface({ input: p.stdout }).on('line', (line) => {
        let e: SpeechEvent;
        try {
          e = JSON.parse(line.replace(/^\ufeff/, '')) as SpeechEvent;
        } catch {
          return;
        }
        if (e.event === 'ready' && !ready) {
          ready = true;
          clearTimeout(t);
          resolve();
        }
        onEvent(e);
      });
      p.on('error', (err) => {
        clearTimeout(t);
        if (!ready) reject(err);
      });
      p.on('exit', (code) => {
        clearTimeout(t);
        this.proc = null;
        if (!ready) reject(new Error('Modern speech helper exited during start.'));
        onExit(code);
      });
    });
  }

  send(cmd: Record<string, unknown>): void {
    this.proc?.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  stop(): void {
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

/**
 * Prefers the modern engine and falls back to the classic (SAPI) one when the
 * modern helper cannot be built or started on this PC.
 */
export class AutoSpeechEngine implements SpeechEngine {
  private active: SpeechEngine | null = null;
  kind: 'modern' | 'classic' | null = null;
  fallbackReason: string | null = null;

  constructor(
    private readonly modern: SpeechEngine,
    private readonly classic: SpeechEngine,
    private readonly prefer: () => 'auto' | 'modern' | 'classic',
  ) {}

  async start(onEvent: (e: SpeechEvent) => void, onExit: (code: number | null) => void): Promise<void> {
    const want = this.prefer();
    if (want !== 'classic') {
      try {
        await this.modern.start(onEvent, onExit);
        this.active = this.modern;
        this.kind = 'modern';
        this.fallbackReason = null;
        return;
      } catch (e) {
        this.fallbackReason = (e as Error).message;
        if (want === 'modern') throw e;
      }
    }
    await this.classic.start(onEvent, onExit);
    this.active = this.classic;
    this.kind = 'classic';
  }

  send(cmd: Record<string, unknown>): void {
    this.active?.send(cmd);
  }

  stop(): void {
    this.active?.stop();
    this.active = null;
    this.kind = null;
  }
}
