import type { Settings } from '../../shared/settings';
import type { Logger } from '../logging/logger';
import type { KeoAccount } from '../cloud/account';
import type { OpenAICompatProvider } from '../providers/openaiCompat';
import { KeoError } from '../util/errors';

/**
 * Speech services that leave the computer: Keo's own voice and listening (Keo Cloud, with a Keo
 * account) or OpenAI's (the user's key). Local text-to-speech (Windows voices via the renderer's
 * speechSynthesis) needs nothing here. Audio is processed in memory only — recordings are never
 * written to disk or logged.
 */
export class VoiceService {
  constructor(
    private readonly openai: OpenAICompatProvider,
    private readonly getSettings: () => Settings,
    private readonly hasOpenAIKey: () => boolean,
    private readonly log: Logger,
    private readonly account: Pick<KeoAccount, 'signedIn' | 'speak' | 'transcribe'> | null = null,
  ) {}

  sttStatus(s: Settings = this.getSettings()): { available: boolean; reason: string | null } {
    if (s.voice.sttProvider === 'none') return { available: false, reason: 'Speech-to-text is off. Choose a provider in Settings → Voice.' };
    if (s.voice.sttProvider === 'keo') {
      if (!this.account?.signedIn()) return { available: false, reason: 'Keo’s listening needs your Keo account: sign in (Settings → Providers).' };
      if (!s.voice.audioExportConsent) return { available: false, reason: 'Allow sending recordings to Keo Cloud in Settings → Voice first.' };
      return { available: true, reason: null };
    }
    if (!this.hasOpenAIKey()) return { available: false, reason: 'Speech-to-text uses OpenAI; add an OpenAI API key.' };
    if (!s.voice.audioExportConsent) return { available: false, reason: 'Allow sending recordings to OpenAI in Settings → Voice first.' };
    return { available: true, reason: null };
  }

  async transcribe(audio: Uint8Array, mimeType: string, signal: AbortSignal): Promise<string> {
    const s = this.getSettings();
    const st = this.sttStatus(s);
    if (!st.available) throw new KeoError('voice_unavailable', st.reason ?? 'Unavailable');
    this.log.info('voice.transcribe', { bytes: audio.byteLength, mimeType, model: s.voice.sttModel });
    // Transcribe in the user's language (the wake-word language) instead of letting
    // the model guess: short or quiet clips were otherwise "heard" as Spanish etc.
    const language = s.wake.culture.split('-')[0]!.toLowerCase();
    if (s.voice.sttProvider === 'keo') {
      if (mimeType !== 'audio/wav') throw new KeoError('voice_unavailable', 'Keo’s listening needs the recording as WAV.');
      return dropHallucination((await this.cloud(() => this.account!.transcribe(audio, language, signal))).trim());
    }
    const text = await this.openai.transcribe(audio, mimeType, s.voice.sttModel, signal, {
      language,
      prompt: 'A person talking to Keo, their computer assistant (apps such as WhatsApp, Chrome, Notepad).',
    });
    return dropHallucination(text.trim());
  }

  async speak(text: string, signal: AbortSignal): Promise<{ audio: Uint8Array; mimeType: string }> {
    const s = this.getSettings();
    if (s.voice.ttsEngine === 'keo') {
      if (!this.account?.signedIn()) throw new KeoError('voice_unavailable', 'Keo’s voice needs your Keo account: sign in (Settings → Providers).');
      this.log.info('voice.speak', { chars: text.length, engine: 'keo', voice: s.voice.keoVoice });
      return this.cloud(() => this.account!.speak(text, s.voice.keoVoice, signal));
    }
    if (s.voice.ttsEngine !== 'openai') throw new KeoError('voice_unavailable', 'Cloud text-to-speech is not selected.');
    if (!this.hasOpenAIKey()) throw new KeoError('voice_unavailable', 'Cloud text-to-speech uses OpenAI; add an OpenAI API key.');
    this.log.info('voice.speak', { chars: text.length, model: s.voice.openaiTtsModel });
    return { audio: await this.openai.speak(text, s.voice.openaiTtsModel, s.voice.openaiTtsVoice, signal), mimeType: 'audio/mpeg' };
  }

  /** Keo Cloud's refusals (plan, allowance, sign-in) as a voice error with its message. */
  private async cloud<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      throw new KeoError(status === 403 || status === 429 ? 'voice_limit' : 'voice_unavailable', (e as Error).message);
    }
  }
}

/**
 * Speech-to-text models invent stock phrases for silence or noise ("Thanks for
 * watching!", subtitle credits, "Gracias."). Such a transcript is treated as
 * nothing heard, so Keo listens again instead of answering it.
 */
const HALLUCINATIONS = [
  /^(thanks?|thank you)( (so|very) much)? for (watching|listening)[.!]*$/i,
  /^(please )?(like and )?subscribe[.!]*$/i,
  /subtit(le|ulo|ulos|res)|amara\.org|untertitel|sous-titres/i,
  /^(gracias|obrigad[oa]|merci|danke|grazie)( por ver( el video)?| for watching)?[.!]*$/i,
  /^you[.!]?$/i,
  /^[\s.,!?…-]*$/,
];

export function dropHallucination(text: string): string {
  const t = text.trim();
  return HALLUCINATIONS.some((r) => r.test(t)) ? '' : t;
}
