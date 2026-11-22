import type { ToolSpec } from '../providers/types';

/**
 * Focused tools: each request sends the model only the tools (and the instructions about them)
 * it is likely to need, instead of all of Keo's ~70 tools every time (that alone was ~18,000
 * tokens per model call, repeated at every step of a task). A small core is always there; the
 * other groups come with the words of the request, the attachments, the tools used in the last
 * few turns, and on request: the model can load any group with tools__load in the same turn.
 * Any registered tool still runs if the model calls it by name.
 */
export const TOOL_GROUPS = ['desktop', 'screen', 'whatsapp', 'email', 'calendar', 'webapps', 'research', 'files', 'create', 'pictures', 'video', 'studio', 'projects', 'connected'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number] | 'core';

/** Which group a tool belongs to (by its name: "desktop__click" → desktop). */
export function groupOf(toolName: string): ToolGroup {
  const [ns, op] = toolName.split('__');
  switch (ns) {
    case 'desktop':
    case 'computer':
    case 'apps':
    case 'vision':
    case 'access':
      return 'desktop';
    case 'screen':
      return 'screen';
    case 'whatsapp':
      return 'whatsapp';
    case 'email':
      return 'email';
    case 'calendar':
      return 'calendar';
    case 'browser':
      return 'webapps';
    case 'web':
      // Searching and reading pages are everyday tools; working inside a website is not.
      return op === 'search' || op === 'fetch_page' ? 'core' : 'webapps';
    case 'research':
      return op === 'send_whatsapp' ? 'whatsapp' : 'research';
    case 'agents':
      return 'research';
    case 'files':
      return op === 'search' ? 'core' : op === 'look_at_pictures' ? 'pictures' : 'files';
    case 'create':
    case 'build':
      return 'create';
    case 'picture':
      return 'pictures';
    case 'video':
      return 'video';
    case 'studio':
      return 'studio';
    case 'project':
    case 'workflows':
      return 'projects';
    case 'telegram':
    case 'notion':
    case 'slack':
    case 'drive':
      return 'connected';
    default:
      // memory, jobs, reminders, briefing, system, task, plan and anything new: always there.
      return 'core';
  }
}

/** What each group is for (shown to the model so it can load one it needs). */
export const GROUP_LABEL: Record<(typeof TOOL_GROUPS)[number], string> = {
  desktop: 'open apps, work in windows, click, type, draw, allowed apps; Full control (any app, like a person)',
  screen: 'look at the whole screen, point things out on it',
  whatsapp: 'WhatsApp chats, messages, files, live chats',
  email: 'read, search, draft, send and reply to email',
  calendar: 'Google Calendar events and free time',
  webapps: "work inside websites in Keo's browser window (forms, uploads, Google Docs/Slides, marketplaces)",
  research: 'deeper research with sub-agents, product comparisons, saving results',
  files: 'read, open, show, write files; make folders, rename, copy, move, duplicate, sort and delete files (files__manage, with undo); project workspace files and scripts',
  create: 'make Word, PowerPoint, Excel files; build websites (with backend and database), web apps, 2D/3D games and motion sites; 3D models',
  pictures: 'edit, animate or make pictures; look at photos',
  video: 'copy a template video’s edit from a folder of clips (older ffmpeg pipeline)',
  studio: 'Keo Studio, the video editor: timeline edits, captions, effects, motion graphics, faceless videos, export',
  projects: 'projects and saved workflows',
  connected: 'connected apps: Telegram (the user’s bot and its live chats; the user’s own Telegram is chat__background_start), Notion pages, Slack channels, Google Drive (files Keo saves there)',
};

/** Words that bring a group in (the newest user messages, lower-cased). */
const TRIGGERS: Record<(typeof TOOL_GROUPS)[number], RegExp> = {
  desktop:
    /\b(open|launch|start|close|switch to|minimi[sz]e|maximi[sz]e|app|apps|application|window|windows|click|type|press|scroll|notepad|paint|word|excel|powerpoint|chrome|edge|firefox|spotify|explorer|settings|desktop|draw|install|program|task ?bar|menu|button|keyboard|mouse|computer|pc|laptop)\b/,
  screen: /\b(screen|look at|what am i (looking|seeing)|point (it )?out|show me where|circle|highlight|this (chart|video|picture|page|error|thing))\b/,
  whatsapp: /\b(whatsapp|whats app|message|messages|text (him|her|them|my)|chat with|reply to|dm|contact|send (it|this|that|a message) to|tell (him|her|them|my))\b/,
  email: /\b(e-?mails?|mail|inbox|gmail|outlook|yahoo|newsletter|unread|reply to|forward|cc|bcc|attachment)\b|@\w+\.\w+/,
  calendar: /\b(calendar|meeting|meet|schedule|appointment|book|booking|event|events|availability|free time|busy|tomorrow at|next week|invite)\b/,
  webapps: /\b(website|web ?site|site|web ?app|google (docs?|slides|sheets|forms)|ebay|amazon|jumia|etsy|form|forms|log ?in|sign ?in|upload|browser|tab|tabs|online|listing|post on|checkout|portal)\b/,
  research: /\b(research|compare|comparison|best|cheapest|price|prices|deal|deals|buy|review|reviews|vs|versus|which (one|is better)|recommend|options|look up|find out)\b/,
  files: /\b(files?|folders?|documents?|docs?|pdf|docx|downloads?|desktop|pictures|photos|images|read (the|this|my)|open (the|my)|save (it|this|to)|rename|move|copy|duplicate|organi[sz]e|sort|tidy|clean up|recycle bin|script|scripts|code|repo|workspace|txt|csv|json)\b/,
  create: /\b(make|create|write|draft|build|generate|design)\b.*\b(presentation|slides?|deck|powerpoint|pptx|word|document|docx|report|letter|cv|resume|essay|proposal|spreadsheet|excel|xlsx|budget|invoice|game|games|app|page|3d|stl|model|website|web ?site|site|landing page|shop|store|dashboard|portfolio|blog)\b|\b(presentation|slides|deck|spreadsheet|powerpoint|word document|excel sheet|website|web ?site|landing page|online (shop|store)|web ?app|3d game|2d game)\b/,
  pictures: /\b(pictures?|images?|photos?|logo|png|jpe?g|gif|crop|animate|animated|background|redesign|illustration|poster|banner|thumbnail|wallpaper|icon|edit (the|this|my) (pic|image|photo|logo))\b/,
  video: /\b(videos?|clips?|reels?|tiktok|shorts|youtube|edit (the|this|my) video|render|montage|footage|template|captions?|subtitles?|studio|faceless|b-?roll|silences?|filler words?|retakes?)\b/,
  studio: /\b(videos?|clips?|reels?|tiktok|shorts|youtube|edit (the|this|my) video|render|montage|footage|template|captions?|subtitles?|studio|faceless|b-?roll|silences?|filler words?|retakes?|voice-?over|green ?screen|transition|thumbnail)\b/,
  projects: /\b(projects?|workflows?|workspace|milestone|backlog)\b/,
  connected: /\b(telegram|notion|slack|google drive|my drive|to drive|in drive)\b/,
};

export interface GroupHints {
  /** The newest user messages (most recent last). */
  texts: string[];
  /** The newest user message came with pictures (attachments or Keo's pencil). */
  pictures: boolean;
  /** It came with documents attached. */
  documents: boolean;
  /** Keo's pencil was used (a picture of the whole screen). */
  pencil: boolean;
  /** Groups whose tools were used in the last few turns of this conversation. */
  recent: Iterable<ToolGroup>;
  /** An open question waits on a tool (its group stays). */
  pendingTool?: string | null;
}

export function chooseGroups(h: GroupHints): Set<ToolGroup> {
  const out = new Set<ToolGroup>(['core']);
  const text = h.texts.join('\n').toLowerCase();
  for (const g of TOOL_GROUPS) if (TRIGGERS[g].test(text)) out.add(g);
  if (h.pictures) out.add('pictures');
  if (h.documents) out.add('files');
  if (h.pencil) {
    out.add('screen');
    out.add('desktop');
  }
  for (const g of h.recent) out.add(g);
  if (h.pendingTool) out.add(groupOf(h.pendingTool));
  // Working on the computer means looking at the screen too (Full control works from screen pictures).
  if (out.has('desktop')) out.add('screen');
  // Making a file usually means looking at one too; pictures are often files.
  if (out.has('create') || out.has('pictures') || out.has('video')) out.add('files');
  return out;
}

/**
 * How strongly a request is about each group. The ask itself usually comes first ("Build a website
 * for Keo…"), with details after, so words in the first sentence of the newest message count far more than
 * the same words further on (common words like "type" or "app" in the details must not outweigh it).
 */
export function groupScores(texts: string[]): Map<ToolGroup, number> {
  const all = texts.join('\n').toLowerCase();
  // The first sentence of the newest message (where the ask is).
  const opening = ((texts.at(-1) ?? '').toLowerCase().split(/[.!?]\s|\n/).find((x) => x.trim()) ?? '').slice(0, 300);
  const count = (s: string, g: (typeof TOOL_GROUPS)[number]) => (s.match(new RegExp(TRIGGERS[g].source, 'g')) ?? []).length;
  const out = new Map<ToolGroup, number>();
  for (const g of TOOL_GROUPS) out.set(g, count(all, g) + 10 * count(opening, g));
  return out;
}

/**
 * The most tools sent with one request. Services refuse more (OpenAI: 128 tools), and fewer tools
 * also make the model choose better. Room is kept for the checklist and tools__load.
 */
export const TOOL_CAP = 120;
/** The most tools any service accepts in one request (OpenAI: 128): never sent more than this. */
export const HARD_TOOL_LIMIT = 128;

/**
 * Keeps `groups` within `cap` tools: groups the request needs for sure (`pinned`: core, tools in
 * use, groups the model loaded) stay; of the others, the ones the request mentions least are left
 * out first (they stay loadable with tools__load). Returns the groups left out.
 */
export function fitToolGroups(groups: Set<ToolGroup>, pinned: Set<ToolGroup>, scores: Map<ToolGroup, number>, countOf: (g: ToolGroup) => number, cap = TOOL_CAP): ToolGroup[] {
  let total = [...groups].reduce((n, g) => n + countOf(g), 0);
  if (total <= cap) return [];
  const dropped: ToolGroup[] = [];
  // Least mentioned first; among equals, the bigger group first (frees the most room).
  const order = [...groups].filter((g) => !pinned.has(g)).sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0) || countOf(b) - countOf(a));
  for (const g of order) {
    if (total <= cap) break;
    groups.delete(g);
    total -= countOf(g);
    dropped.push(g);
  }
  return dropped;
}

export const LOAD_TOOLS = 'tools__load';

/** The tool that brings in more tool groups for the rest of this turn. */
export function loadToolsSpec(missing: Array<(typeof TOOL_GROUPS)[number]>): ToolSpec {
  return {
    name: LOAD_TOOLS,
    description: `Load more of Keo's tools when the request needs something you do not have yet. Groups not loaded now: ${missing.map((g) => `${g} (${GROUP_LABEL[g]})`).join('; ')}. They are available from your next step.`,
    inputSchema: {
      type: 'object',
      properties: { groups: { type: 'array', items: { type: 'string', enum: [...missing] }, minItems: 1 } },
      required: ['groups'],
      additionalProperties: false,
    },
  };
}

export function parseLoad(input: unknown): Array<(typeof TOOL_GROUPS)[number]> {
  const g = (input as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(g)) return [];
  return g.filter((x): x is (typeof TOOL_GROUPS)[number] => typeof x === 'string' && (TOOL_GROUPS as readonly string[]).includes(x));
}
