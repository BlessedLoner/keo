import type { ToolSpec } from '../providers/types';

/**
 * Focused tools: each request sends the model only the tools (and the instructions about them)
 * it is likely to need, instead of all of Keo's ~70 tools every time (that alone was ~18,000
 * tokens per model call, repeated at every step of a task). A small core is always there; the
 * other groups come with the words of the request, the attachments, the tools used in the last
 * few turns, and on request: the model can load any group with tools__load in the same turn.
 * Any registered tool still runs if the model calls it by name.
 */
export const TOOL_GROUPS = ['desktop', 'screen', 'whatsapp', 'email', 'calendar', 'webapps', 'research', 'files', 'create', 'pictures', 'video', 'projects'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number] | 'core';

/** Which group a tool belongs to (by its name: "desktop__click" → desktop). */
export function groupOf(toolName: string): ToolGroup {
  const [ns, op] = toolName.split('__');
  switch (ns) {
    case 'desktop':
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
      return 'create';
    case 'picture':
      return 'pictures';
    case 'video':
      return 'video';
    case 'project':
    case 'workflows':
      return 'projects';
    default:
      // memory, jobs, reminders, briefing, system, task, plan and anything new: always there.
      return 'core';
  }
}

/** What each group is for (shown to the model so it can load one it needs). */
export const GROUP_LABEL: Record<(typeof TOOL_GROUPS)[number], string> = {
  desktop: 'open apps, work in windows, click, type, draw, allowed apps',
  screen: 'look at the whole screen, point things out on it',
  whatsapp: 'WhatsApp chats, messages, files, live chats',
  email: 'read, search, draft, send and reply to email',
  calendar: 'Google Calendar events and free time',
  webapps: "work inside websites in Keo's browser window (forms, uploads, Google Docs/Slides, marketplaces)",
  research: 'deeper research with sub-agents, product comparisons, saving results',
  files: 'read, open, show, write files; project workspace files and scripts',
  create: 'make Word, PowerPoint, Excel files, web games, 3D models',
  pictures: 'edit, animate or make pictures; look at photos',
  video: 'make and edit videos',
  projects: 'projects and saved workflows',
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
  files: /\b(files?|folders?|documents?|docs?|pdf|docx|downloads?|read (the|this|my)|open (the|my)|save (it|this|to)|script|scripts|code|repo|workspace|txt|csv|json)\b/,
  create: /\b(make|create|write|draft|build|generate|design)\b.*\b(presentation|slides?|deck|powerpoint|pptx|word|document|docx|report|letter|cv|resume|essay|proposal|spreadsheet|excel|xlsx|budget|invoice|game|app|page|3d|stl|model)\b|\b(presentation|slides|deck|spreadsheet|powerpoint|word document|excel sheet)\b/,
  pictures: /\b(pictures?|images?|photos?|logo|png|jpe?g|gif|crop|animate|animated|background|redesign|illustration|poster|banner|thumbnail|wallpaper|icon|edit (the|this|my) (pic|image|photo|logo))\b/,
  video: /\b(videos?|clips?|reels?|tiktok|shorts|youtube|edit (the|this|my) video|render|montage|footage|template|captions?|subtitles?)\b/,
  projects: /\b(projects?|workflows?|workspace|milestone|backlog)\b/,
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
  // Making a file usually means looking at one too; pictures are often files.
  if (out.has('create') || out.has('pictures') || out.has('video')) out.add('files');
  return out;
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
