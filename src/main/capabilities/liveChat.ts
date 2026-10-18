import { z } from 'zod';
import { resolveWhatsApp, waOpenChat, waTargetLabel } from './advanced';
import { allowCheck, bringToFront, Target, type CapabilityDeps } from './builtins';
import { CapabilityError, defineCapability, type AnyCapability } from './types';
import type { LiveChatService } from '../livechat/liveChatService';

const Session = z.object({
  id: z.string(),
  contact: z.string(),
  status: z.string(),
  question: z.string().nullable(),
  replies: z.number(),
  maxReplies: z.number(),
  endsAt: z.string(),
});
const view = (s: { id: string; contact: string; status: string; question: string | null; replies: number; maxReplies: number; endsAt: string }) => ({
  id: s.id,
  contact: s.contact,
  status: s.status,
  question: s.question,
  replies: s.replies,
  maxReplies: s.maxReplies,
  endsAt: s.endsAt,
});

/**
 * Live WhatsApp chats. Starting one is a single approval for an ongoing,
 * bounded conversation; answering and stopping are the user's own words
 * relayed by the agent (an answer must be traceable to a message the user
 * actually wrote, so text from the contact can never steer a session).
 */
export function liveChatCapabilities(d: CapabilityDeps & { live: LiveChatService; userMessage: (id: string | null) => string | null }): AnyCapability[] {
  const start = defineCapability({
    id: 'whatsapp.live_chat_start',
    version: '1.0.0',
    title: 'Chat live on WhatsApp',
    description:
      'Start a LIVE WhatsApp chat with one contact: Keo keeps reading new messages and replying for the user until the user says stop (or the time/reply limit is reached). Keo pauses and asks the user about money, prices, payments, meetings, personal matters, "are you a bot?" and anything it cannot answer from the instructions. Use for requests like "chat with Ma Glo until I say stop" or "reply to John and keep the conversation going". Put the user\'s purpose in goal and any facts/rules they gave in instructions (their own words). opening = first message to send now (optional); replyToLatest = answer the contact\'s latest unanswered message right away. Omit target: Keo finds the WhatsApp window itself.',
    input: z
      .object({
        target: Target.optional(),
        contact: z.string().trim().min(1).max(120),
        goal: z.string().trim().min(1).max(600),
        instructions: z.array(z.string().trim().min(1).max(400)).max(10).default([]),
        opening: z.string().trim().min(1).max(1500).optional(),
        replyToLatest: z.boolean().default(false),
        maxMinutes: z.number().int().min(5).max(720).optional(),
        maxReplies: z.number().int().min(1).max(300).optional(),
      })
      .strict(),
    output: Session,
    risk: 'high',
    approval: 'always',
    permissions: ['desktop.control'],
    consequential: true,
    idempotent: false,
    timeoutMs: 120000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The chat is opened and its header verified before the session starts; every reply is verified in the chat.',
    precheck: (i, s) => (i.target ? allowCheck(i.target, s) : null),
    // Hands-free may start it only for a contact the user named themselves.
    autonomy: (i) => ({ tier: 'important', mustBeNamed: i.contact }),
    preview: (i, s) => {
      const minutes = i.maxMinutes ?? s.liveChat.maxMinutes;
      const replies = i.maxReplies ?? s.liveChat.maxReplies;
      return {
        summary: `Chat live with “${i.contact}” on WhatsApp until you say stop`,
        target: waTargetLabel(i.target),
        consequences: [
          `Goal: ${i.goal}`,
          ...(i.instructions.length ? [`Your instructions: ${i.instructions.join(' · ')}`] : []),
          ...(i.opening ? [`First message: “${i.opening}”`] : []),
          ...(i.replyToLatest ? ['Replies to their latest message right away.'] : []),
          `Keo reads new messages and replies for you — up to ${replies} replies over ${minutes} minutes, ending earlier after ${s.liveChat.quietMinutes} quiet minutes or when you say stop.`,
          'It pauses and asks you about money, prices, payments, meetings, personal or urgent matters, “are you a bot?”, and anything it is unsure about.',
          `Keo types only after you have been idle for ${s.liveChat.idleSeconds} s, then gives your window back.`,
        ],
        dataExport: `Their messages are sent to ${d.activeProviderDestination()} to write replies.`,
      };
    },
    auditView: (i) => ({ target: i.target, contactLength: i.contact.length, instructions: i.instructions.length, opening: !!i.opening, replyToLatest: i.replyToLatest }),
    // Opening the chat takes the desktop; the session itself (its opening message, replies) takes
    // its own turns through the live chat service, so nothing waits on itself.
    locksDesktopItself: true,
    async execute(i, ctx) {
      const target = await d.desktop.exclusive(
        `whatsapp.live_chat_start:${ctx.correlationId}`,
        async () => {
          const t = await resolveWhatsApp(d, i.target, ctx.settings);
          await bringToFront(d, t, ctx.settings);
          const o = await waOpenChat(d, t, i.contact, ctx.signal);
          if (!o.opened) {
            throw new CapabilityError('not_opened', `Could not open the chat with “${i.contact}”: ${o.reason ?? 'not found'}.${o.candidates.length ? ` Candidates: ${o.candidates.join(', ')}.` : ''} Ask the user which one they mean.`, {
              dispatched: 'no',
            });
          }
          return t;
        },
        ctx.signal,
      );
      const s = await d.live.start({
        target,
        contact: i.contact,
        goal: i.goal,
        instructions: i.instructions,
        opening: i.opening ?? null,
        maxMinutes: i.maxMinutes ?? ctx.settings.liveChat.maxMinutes,
        maxReplies: i.maxReplies ?? ctx.settings.liveChat.maxReplies,
        conversationId: ctx.conversationId,
      });
      if (i.replyToLatest) d.live.replyToLatest(s.id);
      return view(s);
    },
    async verify(_i, o) {
      return o.status === 'ended' ? { verified: false, detail: 'The live chat ended immediately.' } : { verified: true, detail: `Live chat with ${o.contact} is running (${o.id}).` };
    },
  });

  const answer = defineCapability({
    id: 'whatsapp.live_chat_answer',
    version: '1.0.0',
    title: 'Answer for a live chat',
    description:
      "Give a running live chat the user's answer or new instruction (e.g. the price to quote, what to say, \"explain it to her\", \"research it and tell him\"). Keo takes the user's own latest message as the answer automatically — just pass sessionId. This does NOT send anything by itself: Keo writes the reply and posts \"Sent to …\" in this chat only when it really goes out. Never tell the user it was sent.",
    input: z
      .object({
        sessionId: z.string().regex(/^lc_[A-Za-z0-9_-]{4,64}$/),
        answer: z.string().trim().min(1).max(1500).optional().describe('Optional; ignored when the user wrote a message this turn (their own words are used).'),
        replyNow: z.boolean().default(true),
      })
      .strict(),
    output: Session.extend({ note: z.string() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 10000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Accepted only when the answer can be found in a message the user wrote.',
    preview: () => ({ summary: 'Give a live chat your answer', target: null, consequences: ['Uses your latest message as the answer.'], dataExport: null }),
    auditView: (i) => ({ sessionId: i.sessionId }),
    async execute(i, ctx) {
      // Provenance: the answer is the user's own message from this turn — never text from the contact.
      const own = d.userMessage(ctx.sourceMessageId);
      const text = own ?? (i.answer && ctx.conversationId && d.findUserQuote(ctx.conversationId, i.answer) ? i.answer : null);
      if (!text) {
        throw new CapabilityError('not_from_user', "Keo could not find the user's own message for this answer. Ask the user what to tell the contact.", { dispatched: 'no' });
      }
      const s = d.live.answer(i.sessionId, text, i.replyNow);
      return {
        ...view(s),
        note: `Passed the user's answer to the live chat with ${s.contact}. NOTHING HAS BEEN SENT YET: Keo writes the reply now and posts "Sent to ${s.contact}: …" in this chat when it actually goes out (or shows it as ready if the user is busy).`,
      };
    },
  });

  const stop = defineCapability({
    id: 'whatsapp.live_chat_stop',
    version: '1.0.0',
    title: 'Stop a live chat',
    description: 'Stop a running live WhatsApp chat (sessionId), or all of them when sessionId is omitted. Use whenever the user says stop, enough, or that they will take over.',
    input: z.object({ sessionId: z.string().regex(/^lc_[A-Za-z0-9_-]{4,64}$/).optional() }).strict(),
    output: z.object({ stopped: z.number() }),
    risk: 'read',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 5000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Session state checked after stopping.',
    preview: () => ({ summary: 'Stop live chat', target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ sessionId: i.sessionId ?? 'all' }),
    async execute(i) {
      if (i.sessionId) return { stopped: d.live.stop(i.sessionId) ? 1 : 0 };
      return { stopped: d.live.stopAll() };
    },
  });

  const sendNow = defineCapability({
    id: 'whatsapp.live_chat_send_now',
    version: '1.0.0',
    title: 'Send the ready live-chat reply now',
    description: 'When a live chat has a reply ready (waiting for the user to pause), send it right now. Use when the user says "send it", "send now" or similar.',
    input: z.object({ sessionId: z.string().regex(/^lc_[A-Za-z0-9_-]{4,64}$/) }).strict(),
    output: Session,
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 5000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The reply goes through the session’s verified send.',
    preview: () => ({ summary: 'Send the ready reply now', target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ sessionId: i.sessionId }),
    async execute(i) {
      return view(d.live.sendDraftNow(i.sessionId));
    },
  });

  const status = defineCapability({
    id: 'whatsapp.live_chat_status',
    version: '1.0.0',
    title: 'Live chat status',
    description: 'List running and recently ended live WhatsApp chats with their state and any question waiting for the user.',
    input: z.object({}).strict(),
    output: z.object({ sessions: z.array(Session) }),
    risk: 'read',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 5000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read from the live chat service.',
    preview: () => ({ summary: 'Show live chats', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute() {
      return { sessions: d.live.list().map(view) };
    },
  });

  return [start, answer, stop, sendNow, status] as AnyCapability[];
}
