import { z } from 'zod';
import { resolveWhatsApp, waOpenChat, waTargetLabel } from './advanced';
import { allowCheck, bringToFront, Target, type CapabilityDeps } from './builtins';
import { CapabilityError, defineCapability, type AnyCapability } from './types';
import type { LiveChatService } from '../livechat/liveChatService';
import type { ChatBackground } from '../livechat/webChat';

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
export function liveChatCapabilities(d: CapabilityDeps & { live: LiveChatService; userMessage: (id: string | null) => string | null; telegramUnavailable?: () => string | null; backgrounds?: { whatsapp_bg?: ChatBackground; telegram_bg?: ChatBackground } }): AnyCapability[] {
  const start = defineCapability({
    id: 'whatsapp.live_chat_start',
    version: '1.0.0',
    title: 'Chat live on WhatsApp',
    description:
      'Start a LIVE WhatsApp chat with one contact: Keo keeps reading new messages and replying for the user until the user says stop (or the time/reply limit is reached). Keo pauses and asks the user about money, prices, payments, meetings, personal matters, "are you a bot?" and anything it cannot answer from the instructions. Use for requests like "chat with Ma Glo until I say stop" or "reply to John and keep the conversation going". Put the user\'s purpose in goal and any facts/rules they gave in instructions (their own words). opening = first message to send now (optional); replyToLatest = answer the contact\'s latest unanswered message right away. Omit target: Keo finds the WhatsApp window itself.',
    input: z
      .object({
        target: Target.optional(),
        which: z.enum(['app', 'web']).optional().describe('When both are open: "app" = WhatsApp desktop app, "web" = WhatsApp Web.'),
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
          const t = await resolveWhatsApp(d, i.target, ctx.settings, i.which);
          await bringToFront(d, t, ctx.settings);
          const o = await waOpenChat(d, t, i.contact, ctx.signal);
          if (!o.opened) {
            const several = o.candidates.length > 1;
            throw new CapabilityError(several ? 'ambiguous_contact' : 'not_opened', `Could not open the chat with “${i.contact}”: ${o.reason ?? 'not found'}.${o.candidates.length ? ` Chats found: ${o.candidates.join(', ')}.` : ''} ${several ? 'Ask the user which one they mean.' : 'Try again (WhatsApp may still be loading), or search with the name exactly as the chat list shows it; ask the user only if that also fails.'}`, {
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

  const startTelegram = defineCapability({
    id: 'telegram.live_chat_start',
    version: '1.0.0',
    title: 'Chat live on Telegram',
    description:
      'Start a LIVE Telegram chat through the user\'s Telegram bot with one chat (chatId from telegram__recent; the person must have messaged the bot first): Keo keeps reading new messages and replying for the user until the user says stop (or the time/reply limit is reached), with the same rules as WhatsApp live chats (it pauses and asks about money, meetings, personal matters, "are you a bot?"). It needs no screen, so it runs alongside a WhatsApp live chat. Answer, stop and list it with the whatsapp__live_chat_* tools (they cover every live chat). Put the user\'s purpose in goal and their facts/rules in instructions (their own words).',
    input: z
      .object({
        chatId: z.union([z.number(), z.string().trim().min(1).max(64)]),
        contact: z.string().trim().min(1).max(120).describe('The person or group name, as telegram__recent shows it.'),
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
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 60000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Telegram confirms every reply with a message id.',
    unavailableReason: () => d.telegramUnavailable?.() ?? null,
    autonomy: (i) => ({ tier: 'important', mustBeNamed: i.contact }),
    preview: (i, s) => {
      const minutes = i.maxMinutes ?? s.liveChat.maxMinutes;
      const replies = i.maxReplies ?? s.liveChat.maxReplies;
      return {
        summary: `Chat live with “${i.contact}” on Telegram until you say stop`,
        target: `Telegram chat ${i.chatId} (through your bot)`,
        consequences: [
          `Goal: ${i.goal}`,
          ...(i.instructions.length ? [`Your instructions: ${i.instructions.join(' · ')}`] : []),
          ...(i.opening ? [`First message: “${i.opening}”`] : []),
          ...(i.replyToLatest ? ['Replies to their latest message right away.'] : []),
          `Keo reads new messages and replies from your bot — up to ${replies} replies over ${minutes} minutes, ending earlier after ${s.liveChat.quietMinutes} quiet minutes or when you say stop.`,
          'It pauses and asks you about money, prices, payments, meetings, personal or urgent matters, “are you a bot?”, and anything it is unsure about.',
          'It needs no screen: your mouse and keyboard stay yours.',
        ],
        dataExport: `Their messages are sent to ${d.activeProviderDestination()} to write replies; replies go to Telegram.`,
      };
    },
    auditView: (i) => ({ contactLength: i.contact.length, instructions: i.instructions.length, opening: !!i.opening, replyToLatest: i.replyToLatest }),
    async execute(i, ctx) {
      const s = await d.live.startTelegram({
        chatId: String(i.chatId),
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
      return o.status === 'ended' ? { verified: false, detail: 'The live chat ended immediately.' } : { verified: true, detail: `Telegram live chat with ${o.contact} is running (${o.id}).` };
    },
  });

  const App = z.enum(['whatsapp', 'telegram']).describe('"whatsapp" or "telegram": the user’s own account, in the background');
  const bgOf = (app: 'whatsapp' | 'telegram') => d.backgrounds?.[app === 'telegram' ? 'telegram_bg' : 'whatsapp_bg'];
  const appLabel = (app: 'whatsapp' | 'telegram') => (app === 'telegram' ? 'Telegram' : 'WhatsApp');
  const linkSteps = (app: 'whatsapp' | 'telegram') =>
    app === 'telegram' ? 'Telegram → Settings → Devices → Link Desktop Device' : 'WhatsApp → Settings → Linked devices → Link a device';

  const link = defineCapability({
    id: 'chat.link_background',
    version: '1.0.0',
    title: 'Set up WhatsApp or Telegram in the background',
    description:
      'WhatsApp or Telegram in the background lets live chats and "answer everyone" run on the user\'s OWN account without the screen (the user keeps using the computer): Keo uses its own web version of the app, linked once to the user\'s phone. action "status" says whether it is linked; action "link" opens a window with the app\'s QR code — tell the user to scan it with their phone (WhatsApp: Settings → Linked devices → Link a device; Telegram: Settings → Devices → Link Desktop Device). After that it runs without a window.',
    input: z.object({ app: App, action: z.enum(['status', 'link']).default('status') }).strict(),
    output: z.object({ app: z.string(), status: z.enum(['not_linked', 'linking', 'loading', 'ready']), note: z.string() }),
    risk: 'medium',
    approval: 'always',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 60000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Linked when the app shows the chats.',
    unavailableReason: () => (d.backgrounds ? null : 'Chats in the background are not available.'),
    autonomy: (i) => ({ tier: i.action === 'status' ? ('routine' as const) : ('important' as const) }),
    preview: (i) => ({
      summary: i.action === 'link' ? `Link ${appLabel(i.app)} in the background (scan a QR code with your phone)` : `Check ${appLabel(i.app)} in the background`,
      target: `Keo’s own ${appLabel(i.app)} Web`,
      consequences:
        i.action === 'link'
          ? [
              `A window opens with ${appLabel(i.app)}’s QR code: scan it with your phone (${linkSteps(i.app)}).`,
              'It becomes one of your linked devices (you can remove it from your phone any time) and then runs without a window.',
              ...(i.app === 'whatsapp' ? ['WhatsApp does not officially support automatic replies from personal accounts; very heavy automated messaging can get a number restricted.'] : []),
            ]
          : [],
      dataExport: null,
    }),
    auditView: (i) => ({ app: i.app, action: i.action }),
    async execute(i) {
      const bg = bgOf(i.app);
      if (!bg) throw new CapabilityError('unavailable', `${appLabel(i.app)} in the background is not available.`, { dispatched: 'no' });
      const status = i.action === 'link' ? await bg.link() : await bg.status();
      const note =
        status === 'linking'
          ? `A window with ${appLabel(i.app)}’s QR code is open: the user scans it with their phone (${linkSteps(i.app)}). Keo carries on without a window once the chats show.`
          : status === 'not_linked'
            ? 'Not linked yet: call again with action "link" when the user wants it.'
            : status === 'loading'
              ? 'Linked; it is still loading.'
              : 'Linked and ready: live chats can run in the background (chat__background_start) and chat__answer_everyone can answer everyone.';
      return { app: i.app, status, note };
    },
  });

  const startBackground = defineCapability({
    id: 'chat.background_start',
    version: '1.0.0',
    title: 'Chat live in the background',
    description:
      'Start a LIVE chat with one contact on the user\'s OWN WhatsApp or Telegram account IN THE BACKGROUND (Keo\'s own web version of the app): no screen, mouse or keyboard, so the user keeps using the computer. Same rules as whatsapp__live_chat_start (pauses and asks about money, meetings, personal matters, "are you a bot?"). Needs the app linked once (chat__link_background). For WhatsApp, prefer this over whatsapp__live_chat_start when it is linked or when the user wants to keep using the computer; for the user\'s own Telegram this is the way (telegram__live_chat_start is only for the user\'s bot). Answer, stop and list it with the whatsapp__live_chat_* tools (they cover every live chat).',
    input: z
      .object({
        app: App,
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
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 120000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The chat is opened and its name checked before the session starts; every reply is checked in the chat.',
    unavailableReason: () => (d.backgrounds ? null : 'Chats in the background are not available.'),
    autonomy: (i) => ({ tier: 'important', mustBeNamed: i.contact }),
    preview: (i, s) => {
      const minutes = i.maxMinutes ?? s.liveChat.maxMinutes;
      const replies = i.maxReplies ?? s.liveChat.maxReplies;
      return {
        summary: `Chat live with “${i.contact}” on ${appLabel(i.app)} in the background until you say stop`,
        target: `Your ${appLabel(i.app)} (Keo’s own ${appLabel(i.app)} Web, no screen)`,
        consequences: [
          `Goal: ${i.goal}`,
          ...(i.instructions.length ? [`Your instructions: ${i.instructions.join(' · ')}`] : []),
          ...(i.opening ? [`First message: “${i.opening}”`] : []),
          ...(i.replyToLatest ? ['Replies to their latest message right away.'] : []),
          `Keo reads new messages and replies for you — up to ${replies} replies over ${minutes} minutes, ending earlier after ${s.liveChat.quietMinutes} quiet minutes or when you say stop.`,
          'It pauses and asks you about money, prices, payments, meetings, personal or urgent matters, “are you a bot?”, and anything it is unsure about.',
          'It needs no screen: your mouse and keyboard stay yours.',
        ],
        dataExport: `Their messages are sent to ${d.activeProviderDestination()} to write replies.`,
      };
    },
    auditView: (i) => ({ app: i.app, contactLength: i.contact.length, instructions: i.instructions.length, opening: !!i.opening, replyToLatest: i.replyToLatest }),
    async execute(i, ctx) {
      const s = await d.live.startBackground({
        channel: i.app === 'telegram' ? 'telegram_bg' : 'whatsapp_bg',
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
      return o.status === 'ended' ? { verified: false, detail: 'The live chat ended immediately.' } : { verified: true, detail: `Live chat with ${o.contact} is running in the background (${o.id}).` };
    },
  });

  const WHERE_LABEL = { telegram_bot: 'your Telegram bot', telegram: 'your Telegram', whatsapp: 'your WhatsApp' } as const;
  const everyone = defineCapability({
    id: 'chat.answer_everyone',
    version: '1.0.0',
    title: 'Answer everyone who messages',
    description:
      'Turn on (on: true) or off (on: false) "answer everyone": Keo starts a live chat for each person who messages from now on (private chats only), with the same rules as any live chat — it asks the user about money, meetings, personal matters and "are you a bot?". where: "whatsapp" = the user\'s own WhatsApp, "telegram" = the user\'s own Telegram (both in the background, linked once with chat__link_background), "telegram_bot" = people who message the user\'s Telegram bot. Use for "answer anyone who messages me on Telegram", "reply to everyone on WhatsApp while I work". Put the user\'s purpose in goal and their facts/rules in instructions, in their own words. Each chat shows with its own Stop; turning it off keeps running chats going.',
    input: z
      .object({
        where: z.enum(['whatsapp', 'telegram', 'telegram_bot']),
        on: z.boolean().default(true),
        goal: z.string().trim().max(600).default(''),
        instructions: z.array(z.string().trim().min(1).max(400)).max(10).default([]),
        maxMinutes: z.number().int().min(5).max(1440).optional(),
        maxRepliesPerChat: z.number().int().min(1).max(300).optional(),
      })
      .strict()
      .refine((i) => !i.on || i.goal.length > 0, 'Say what Keo should do in these chats (goal).'),
    output: z.object({ on: z.boolean(), where: z.string(), endsAt: z.string().nullable(), started: z.number() }),
    risk: 'high',
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 60000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Every reply is checked in the chat.',
    unavailableReason: () => null,
    // Turning it off is always fine; turning it on answers people for the user.
    autonomy: (i) => (i.on ? { tier: 'important' as const, reason: `Keo will answer anyone who messages ${WHERE_LABEL[i.where]}.` } : { tier: 'routine' as const }),
    preview: (i, s) => {
      if (!i.on) return { summary: 'Stop answering everyone', target: WHERE_LABEL[i.where], consequences: ['Chats already running keep going (each has its own Stop).'], dataExport: null };
      const minutes = i.maxMinutes ?? s.liveChat.maxMinutes;
      return {
        summary: `Answer everyone who messages ${WHERE_LABEL[i.where]}`,
        target: `${WHERE_LABEL[i.where]} (private chats)`,
        consequences: [
          `Goal: ${i.goal}`,
          ...(i.instructions.length ? [`Your instructions: ${i.instructions.join(' · ')}`] : []),
          `For ${minutes} minutes, each person who writes gets their own live chat (up to ${i.where === 'telegram_bot' ? 10 : 5} at once), answering their latest message. Messages that were already waiting are left for you.`,
          'It pauses and asks you about money, prices, payments, meetings, personal or urgent matters, “are you a bot?”, and anything it is unsure about.',
          'It needs no screen: your mouse and keyboard stay yours.',
        ],
        dataExport: `Their messages are sent to ${d.activeProviderDestination()} to write replies.`,
      };
    },
    auditView: (i) => ({ where: i.where, on: i.on, instructions: i.instructions.length }),
    async execute(i, ctx) {
      if (!i.on) {
        const was = d.live.autoStatus();
        d.live.stopAuto();
        return { on: false, where: i.where, endsAt: null, started: was?.started ?? 0 };
      }
      if (i.where === 'telegram_bot') {
        const why = d.telegramUnavailable?.();
        if (why) throw new CapabilityError('unavailable', why, { dispatched: 'no' });
      } else if ((await bgOf(i.where)?.status()) === 'not_linked') {
        throw new CapabilityError('not_linked', `${appLabel(i.where)} in the background is not linked yet. Offer to link it (chat__link_background, action "link"): the user scans a QR code with their phone.`, { dispatched: 'no' });
      }
      const a = await d.live.startAuto({
        channel: i.where === 'telegram_bot' ? 'telegram' : i.where === 'telegram' ? 'telegram_bg' : 'whatsapp_bg',
        goal: i.goal,
        instructions: i.instructions,
        maxMinutes: i.maxMinutes ?? ctx.settings.liveChat.maxMinutes,
        maxReplies: i.maxRepliesPerChat ?? ctx.settings.liveChat.maxReplies,
        conversationId: ctx.conversationId,
      });
      return { on: true, where: i.where, endsAt: a.endsAt, started: a.started };
    },
    async verify(i, o) {
      return { verified: o.on === i.on, detail: o.on ? `Answering everyone on ${WHERE_LABEL[i.where]} until ${new Date(o.endsAt!).toLocaleTimeString()}.` : 'Stopped answering everyone.' };
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

  return [start, startTelegram, everyone, link, startBackground, answer, stop, sendNow, status] as AnyCapability[];
}
