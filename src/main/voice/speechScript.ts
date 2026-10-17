/**
 * Local speech helper (Windows System.Speech / SAPI, fully offline). Runs in
 * its own PowerShell process so a failure never affects the desktop helper.
 *
 * Protocol: one JSON command per line on stdin; one JSON event per line on
 * stdout. Commands: wake, pause, capture, cancel_capture, test, recognizers.
 *
 * Privacy: in wake mode, speech that is not one of the configured phrases is
 * matched by a competing dictation grammar and DISCARDED — it is never
 * emitted, logged or sent anywhere. Only explicit "capture" (after the wake
 * phrase, the mic button or Ctrl+K) returns recognised text.
 */
export const SPEECH_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -Language CSharp -ReferencedAssemblies System.Speech, System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Speech.Recognition;
using System.Threading;
using System.Web.Script.Serialization;

public static class KeoSpeech {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static readonly object Gate = new object();
  static SpeechRecognitionEngine eng;
  static string mode = "idle";
  static double threshold = 0.82;
  static int lastLevelMs = 0;
  static DateTime started;
  static bool heardAudio = false;

  static void Emit(Dictionary<string, object> d) {
    lock (Gate) { Console.Out.WriteLine(Json.Serialize(d)); Console.Out.Flush(); }
  }
  static Dictionary<string, object> Ev(string name) { var d = new Dictionary<string, object>(); d["event"] = name; return d; }

  static RecognizerInfo Find(string culture) {
    RecognizerInfo best = null;
    foreach (var r in SpeechRecognitionEngine.InstalledRecognizers()) {
      if (string.Equals(r.Culture.Name, culture, StringComparison.OrdinalIgnoreCase)) return r;
      if (best == null && r.Culture.TwoLetterISOLanguageName == culture.Split('-')[0]) best = r;
    }
    return best;
  }

  static void Dispose() {
    var e = eng; eng = null; mode = "idle";
    if (e == null) return;
    try { e.RecognizeAsyncCancel(); } catch { }
    try { e.Dispose(); } catch { }
  }

  static SpeechRecognitionEngine Make(string culture) {
    var info = Find(culture);
    if (info == null) throw new Exception("no_recognizer:" + culture);
    var e = new SpeechRecognitionEngine(info);
    try { e.SetInputToDefaultAudioDevice(); }
    catch (Exception) { e.Dispose(); throw new Exception("no_microphone"); }
    e.AudioLevelUpdated += (s, a) => {
      if (a.AudioLevel > 0) heardAudio = true;
      if (mode != "capture") return;
      int now = Environment.TickCount;
      if (now - lastLevelMs < 100) return;
      lastLevelMs = now;
      var d = Ev("level"); d["level"] = a.AudioLevel; Emit(d);
    };
    return e;
  }

  // What the recognizer heard: best text plus up to 5 alternative readings. Used
  // by Keo to accept sound-alike wake phrases; never written anywhere.
  static Dictionary<string, object> Heard(string name, RecognitionResult r) {
    var d = Ev(name);
    d["grammar"] = r != null && r.Grammar != null ? r.Grammar.Name : null;
    d["text"] = r != null ? r.Text : null;
    d["confidence"] = r != null ? Math.Round(r.Confidence, 3) : 0.0;
    var alts = new List<string>();
    if (r != null) {
      try { foreach (var a in r.Alternates) { if (alts.Count >= 5) break; if (!string.IsNullOrEmpty(a.Text)) alts.Add(a.Text); } } catch { }
    }
    d["alts"] = alts;
    return d;
  }

  public static List<Dictionary<string, object>> Recognizers() {
    var list = new List<Dictionary<string, object>>();
    foreach (var r in SpeechRecognitionEngine.InstalledRecognizers()) {
      var d = new Dictionary<string, object>(); d["culture"] = r.Culture.Name; d["name"] = r.Name; list.Add(d);
    }
    return list;
  }

  public static void StartWake(string[] phrases, string culture, double thr) {
    Dispose();
    threshold = thr;
    eng = Make(culture);
    var gb = new GrammarBuilder(new Choices(phrases)); gb.Culture = eng.RecognizerInfo.Culture;
    eng.LoadGrammar(new Grammar(gb) { Name = "wake" });
    eng.LoadGrammar(new DictationGrammar() { Name = "competitor" });
    eng.SpeechRecognized += (s, a) => {
      if (mode != "wake" || a.Result == null) return;
      bool isWake = a.Result.Grammar != null && a.Result.Grammar.Name == "wake";
      if (isWake && a.Result.Confidence >= threshold) {
        var d = Ev("wake"); d["phrase"] = a.Result.Text; d["confidence"] = Math.Round(a.Result.Confidence, 3); Emit(d); return;
      }
      // Not a confident wake: Keo checks whether it *sounds like* the phrase.
      Emit(Heard("heard", a.Result));
    };
    eng.SpeechRecognitionRejected += (s, a) => {
      if (mode != "wake" || a.Result == null || string.IsNullOrEmpty(a.Result.Text)) return;
      Emit(Heard("heard", a.Result));
    };
    mode = "wake"; started = DateTime.UtcNow; heardAudio = false;
    eng.RecognizeAsync(RecognizeMode.Multiple);
    Emit(Ev("listening"));
    new Thread(() => {
      Thread.Sleep(20000);
      if (mode == "wake" && !heardAudio) Emit(Ev("silent_input"));
    }) { IsBackground = true }.Start();
  }

  static string capId = "";

  static Dictionary<string, object> CapEv(string name, string id) { var d = Ev(name); d["id"] = id; return d; }

  public static void Capture(string culture, int initialMs, int endMs, int maxMs) {
    Dispose();
    var id = capId;
    eng = Make(culture);
    eng.LoadGrammar(new DictationGrammar() { Name = "dictation" });
    eng.InitialSilenceTimeout = TimeSpan.FromMilliseconds(initialMs);
    eng.EndSilenceTimeout = TimeSpan.FromMilliseconds(endMs);
    eng.BabbleTimeout = TimeSpan.FromMilliseconds(maxMs);
    eng.RecognizeCompleted += (s, a) => {
      if (mode != "capture") return;
      mode = "idle";
      if (a.Cancelled) { Emit(CapEv("capture_cancelled", id)); return; }
      if (a.Error != null) { var er = CapEv("capture_error", id); er["message"] = a.Error.Message; Emit(er); return; }
      if (a.Result != null && !string.IsNullOrEmpty(a.Result.Text)) {
        var d = CapEv("command", id); d["text"] = a.Result.Text; d["confidence"] = Math.Round(a.Result.Confidence, 3); Emit(d);
      } else {
        var n = CapEv("command_none", id); n["reason"] = a.InitialSilenceTimeout ? "silence" : a.BabbleTimeout ? "unclear" : "no_speech"; Emit(n);
      }
    };
    mode = "capture";
    eng.RecognizeAsync(RecognizeMode.Single);
    Emit(CapEv("capturing", id));
  }

  public static void Test(string[] phrases, string culture, int seconds) {
    Dispose();
    eng = Make(culture);
    var gb = new GrammarBuilder(new Choices(phrases)); gb.Culture = eng.RecognizerInfo.Culture;
    eng.LoadGrammar(new Grammar(gb) { Name = "wake" });
    eng.LoadGrammar(new DictationGrammar() { Name = "competitor" });
    eng.InitialSilenceTimeout = TimeSpan.FromSeconds(seconds);
    eng.BabbleTimeout = TimeSpan.FromSeconds(seconds);
    eng.RecognizeCompleted += (s, a) => {
      mode = "idle";
      var r = a.Result;
      var d = Heard("test_result", r);
      d["recognized"] = r != null && r.Grammar != null && r.Grammar.Name == "wake";
      d["heardSomething"] = r != null;
      Emit(d);
    };
    mode = "test";
    eng.RecognizeAsync(RecognizeMode.Single);
    Emit(Ev("testing"));
  }

  // Microphone-free grammar check: feeds text to the recognizer instead of audio.
  public static void Emulate(string[] phrases, string culture, string text) {
    var info = Find(culture);
    if (info == null) throw new Exception("no_recognizer:" + culture);
    using (var e = new SpeechRecognitionEngine(info)) {
      e.SetInputToNull();
      var gb = new GrammarBuilder(new Choices(phrases)); gb.Culture = info.Culture;
      e.LoadGrammar(new Grammar(gb) { Name = "wake" });
      e.LoadGrammar(new DictationGrammar() { Name = "competitor" });
      var r = e.EmulateRecognize(text);
      var d = Ev("emulated");
      d["grammar"] = r != null && r.Grammar != null ? r.Grammar.Name : null;
      d["text"] = r != null ? r.Text : null;
      d["confidence"] = r != null ? Math.Round(r.Confidence, 3) : 0.0;
      Emit(d);
    }
  }

  static string[] Strings(object o) {
    var list = new List<string>();
    var en = o as System.Collections.IEnumerable;
    if (en != null) foreach (var x in en) if (x != null) list.Add(x.ToString());
    return list.ToArray();
  }

  public static void Handle(Dictionary<string, object> cmd) {
    var name = (string)cmd["cmd"];
    switch (name) {
      case "recognizers": { var d = Ev("recognizers"); d["list"] = Recognizers(); Emit(d); break; }
      case "wake": {
        var phrases = Strings(cmd["phrases"]);
        StartWake(phrases, (string)cmd["culture"], Convert.ToDouble(cmd["threshold"], CultureInfo.InvariantCulture));
        break;
      }
      case "pause": Dispose(); Emit(Ev("paused")); break;
      case "capture": {
        capId = cmd.ContainsKey("id") ? Convert.ToString(cmd["id"]) : "";
        try { Capture((string)cmd["culture"], Convert.ToInt32(cmd["initialMs"]), Convert.ToInt32(cmd["endMs"]), Convert.ToInt32(cmd["maxMs"])); }
        catch (Exception e) { mode = "idle"; var er = CapEv("capture_error", capId); er["message"] = e.Message; er["code"] = e.Message.Split(':')[0]; Emit(er); }
        break;
      }
      case "cancel_capture": if (eng != null && mode == "capture") { try { eng.RecognizeAsyncCancel(); } catch { } } else Emit(CapEv("capture_cancelled", capId)); break;
      case "test": {
        var phrases = Strings(cmd["phrases"]);
        Test(phrases, (string)cmd["culture"], Convert.ToInt32(cmd["seconds"]));
        break;
      }
      case "emulate": {
        var phrases = Strings(cmd["phrases"]);
        Emulate(phrases, (string)cmd["culture"], (string)cmd["text"]);
        break;
      }
      default: { var d = Ev("error"); d["code"] = "unknown_command"; Emit(d); break; }
    }
  }

  public static void Run() {
    Emit(Ev("ready"));
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      try { Handle(Json.Deserialize<Dictionary<string, object>>(line)); }
      catch (Exception e) {
        var msg = e.InnerException != null ? e.InnerException.Message : e.Message;
        var d = Ev("error"); d["code"] = msg.Split(':')[0]; d["message"] = msg; Emit(d);
      }
    }
    Dispose();
  }
}
'@

[KeoSpeech]::Run()
`;
