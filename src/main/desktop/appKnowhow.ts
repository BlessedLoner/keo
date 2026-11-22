/**
 * App know-how: what a person who knows Windows well knows about the apps used most — where things
 * are and the shortcuts — so Keo goes straight to the point instead of looking around. Given to the
 * model with apps__open and computer__do (only for the app in front), short enough to read at once.
 */
export interface AppKnowhow {
  /** The app's name, as said to the user. */
  app: string;
  tips: string[];
}

interface Entry extends AppKnowhow {
  /** Process name (without .exe) and/or window title it is recognised by. */
  process?: RegExp;
  title?: RegExp;
}

const ENTRIES: Entry[] = [
  {
    app: 'File Explorer',
    process: /^explorer$/i,
    title: /file explorer|this pc|downloads|documents|desktop|pictures|videos/i,
    tips: [
      'Go to a folder: ctrl+l, type the path (or shell:downloads, shell:desktop, shell:documents, shell:pictures), enter.',
      'New folder: ctrl+shift+n, type the name, enter. Rename the selected item: f2, type, enter.',
      'Search this folder: ctrl+f (or ctrl+e), type, enter. Up one folder: alt+up. Back: alt+left.',
      'Copy / cut / paste: ctrl+c, ctrl+x, ctrl+v. Select all: ctrl+a. Open the selected item: enter.',
      'Delete sends to the Recycle Bin and is a "deletes" effect (the user approves it).',
      'Show details (size, date): ctrl+shift+6. Properties of the selected item: alt+enter.',
    ],
  },
  {
    app: 'Settings',
    process: /^systemsettings$/i,
    title: /^settings$/i,
    tips: [
      'Open a page directly with apps__settings_page (never by typing) — ms-settings:display, ms-settings:bluetooth, ms-settings:network-wifi, ms-settings:sound, ms-settings:notifications, ms-settings:defaultapps, ms-settings:windowsupdate, ms-settings:personalization-background, ms-settings:powersleep, ms-settings:dateandtime, ms-settings:privacy, ms-settings:appsfeatures.',
      'Or type in the "Find a setting" search box at the top left and click the result by name.',
      'Switches are toggles named after the setting: click them by name with computer__do.',
    ],
  },
  {
    app: 'Web browser (Chrome / Edge)',
    process: /^(chrome|msedge|brave|firefox|opera)$/i,
    tips: [
      'Go to a site or search: ctrl+l, type the address or words, enter. New tab: ctrl+t. Close tab: ctrl+w. Next tab: ctrl+tab. Reopen a closed tab: ctrl+shift+t.',
      'Find on the page: ctrl+f, type, enter. Back: alt+left. Reload: f5. Downloads: ctrl+j. History: ctrl+h.',
      'Zoom: ctrl+plus / ctrl+minus, ctrl+0 to reset. Full screen: f11.',
      'For work inside a website (forms, uploads, reading pages) Keo\'s own browser tools (web__) are more exact than the screen when they are available.',
    ],
  },
  {
    app: 'Word',
    process: /^winword$/i,
    tips: [
      'New document: ctrl+n. Save: ctrl+s (first time: type the name in the File name box, enter). Save as: f12.',
      'Bold / italic / underline: ctrl+b, ctrl+i, ctrl+u. Centre: ctrl+e. Left: ctrl+l. Headings: ctrl+alt+1, ctrl+alt+2, ctrl+alt+3. Normal text: ctrl+shift+n.',
      'Find and replace: ctrl+h. New page: ctrl+enter. Print: ctrl+p. Undo: ctrl+z.',
      'Typing goes where the cursor is: ctrl+home for the start, ctrl+end for the end.',
    ],
  },
  {
    app: 'Excel',
    process: /^excel$/i,
    tips: [
      'Go to a cell: ctrl+g (or f5), type the address like B4, enter. Start of sheet: ctrl+home. Jump to the edge of the data: ctrl+arrow.',
      'Type into a cell and press enter (moves down) or tab (moves right). Edit the cell: f2. Formulas start with = (e.g. =SUM(B2:B10)). AutoSum: alt+=.',
      'Format cells: ctrl+1. Filter: ctrl+shift+l. Insert a table: ctrl+t. Fill down: ctrl+d.',
      'New sheet: shift+f11. Save: ctrl+s.',
    ],
  },
  {
    app: 'PowerPoint',
    process: /^powerpnt$/i,
    tips: [
      'New slide: ctrl+m. Duplicate slide: ctrl+d. Start the show: f5 (from this slide: shift+f5).',
      'Slide text boxes are named "Click to add title" / "Click to add text": click them by name, then type.',
      'Save: ctrl+s. Undo: ctrl+z.',
    ],
  },
  {
    app: 'Notepad',
    process: /^notepad$/i,
    tips: ['It is ready to type as soon as it opens. New tab: ctrl+t (Windows 11). Save: ctrl+s. Find: ctrl+f. Replace: ctrl+h. Select all: ctrl+a.'],
  },
  {
    app: 'Calculator',
    process: /^(calculatorapp|calculator|calc)$/i,
    title: /^calculator$/i,
    tips: [
      'Fastest: type the sum with the keyboard (computer__type "12*34" then computer__keys "enter"); escape clears.',
      'Buttons are named in words: "One"…"Nine", "Zero", "Plus", "Minus", "Multiply by", "Divide by", "Equals", "Clear"; the answer is in the element "Display is …".',
    ],
  },
  {
    app: 'Paint',
    process: /^mspaint$/i,
    tips: ['Draw with computer__drag (or desktop drawing). Tools and colours are buttons named after them (Pencil, Brush, Fill, Text, the colour names). New: ctrl+n. Save: ctrl+s. Undo: ctrl+z.'],
  },
  {
    app: 'WhatsApp',
    process: /^whatsapp(\.root)?$/i,
    title: /whatsapp/i,
    tips: [
      'Prefer the whatsapp__ tools (or chat__background_start for live chats): they find the chat, check the name and confirm the message arrived.',
      'On screen: the search box is at the top of the chat list ("Search or start a new chat"); the message box at the bottom ("Type a message"). Enter sends (a "sends" effect); shift+enter is a new line.',
    ],
  },
  {
    app: 'Telegram',
    process: /^telegram$/i,
    tips: ['Prefer chat__background_start / chat__answer_everyone for the user\'s own Telegram. On screen: search at the top left, message box at the bottom ("Write a message…"); enter sends (a "sends" effect).'],
  },
  {
    app: 'Outlook / Mail',
    process: /^(outlook|olk|hxoutlook)$/i,
    tips: ['Prefer the email__ tools: exact and instant. On screen: new mail ctrl+n, send ctrl+enter (a "sends" effect), reply ctrl+r, search ctrl+e.'],
  },
  {
    app: 'File dialog (Open / Save as)',
    title: /^(open|save as|save|select|choose|upload|browse)\b/i,
    tips: ['Type the full path of the file or folder into the "File name" box and press enter — no need to click through folders. alt+d goes to the folder path box.'],
  },
];

/** The know-how for an app window, or null when Keo has none for it. */
export function knowhowFor(processName: string | null | undefined, title?: string | null): AppKnowhow | null {
  const proc = (processName ?? '').replace(/\.exe$/i, '');
  const t = title ?? '';
  // A file dialog belongs to any app: recognised by its title first.
  const dialog = ENTRIES.find((e) => !e.process && e.title?.test(t));
  if (dialog) return { app: dialog.app, tips: dialog.tips };
  const e = ENTRIES.find((x) => (x.process && x.process.test(proc)) || (!proc && x.title?.test(t)));
  return e ? { app: e.app, tips: e.tips } : null;
}
