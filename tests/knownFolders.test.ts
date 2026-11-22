import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownFoldersLine, knownPath, withKnownPaths } from '../src/main/agent/knownFolders';
import { makeHarness } from './helpers';

const k = { home: 'C:/Users/ada', desktop: 'C:/Users/ada/Desktop', documents: 'C:/Users/ada/Documents', downloads: 'C:/Users/ada/Downloads', pictures: 'C:/Users/ada/Pictures', videos: 'C:/Users/ada/Videos', music: 'C:/Users/ada/Music' };

describe('the user’s folders', () => {
  it('"Documents/…", "Downloads" and "~/…" become real paths; anything else is left as it is', () => {
    expect(knownPath('Documents/Scorecard Test', k)).toBe(path.join(k.documents, 'Scorecard Test'));
    expect(knownPath('Downloads', k)).toBe(k.downloads);
    expect(knownPath('downloads\\report.pdf', k)).toBe(path.join(k.downloads, 'report.pdf'));
    expect(knownPath('~/Desktop/a.png', k)).toBe(path.join(k.home, 'Desktop', 'a.png'));
    expect(knownPath('C:/Work/x', k)).toBeNull();
    expect(knownPath('Project notes', k)).toBeNull();
    expect(knownPath('https://example.com/Documents', k)).toBeNull();
  });

  it('only path fields of a tool input change — never a message, a recipient or a chat name', () => {
    const input = { folder: 'Documents/Scorecard Test', title: 'Downloads', to: 'Music', text: 'Pictures from the trip', files: ['Pictures/a.jpg', 'C:/x.png'], nested: { path: 'Videos/clip.mp4' } };
    expect(withKnownPaths(input, k)).toEqual({
      folder: path.join(k.documents, 'Scorecard Test'),
      title: 'Downloads',
      to: 'Music',
      text: 'Pictures from the trip',
      files: [path.join(k.pictures, 'a.jpg'), 'C:/x.png'],
      nested: { path: path.join(k.videos, 'clip.mp4') },
    });
    const untouched = { contact: 'Home', message: 'hi' };
    expect(withKnownPaths(untouched, k)).toBe(untouched);
    expect(knownFoldersLine(k)).toContain(`Downloads ${k.downloads}`);
  });

  it('Keo is told where the folders are, every turn', async () => {
    const h = makeHarness({ script: () => ({ text: 'ok', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', native: undefined }) as never });
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'what are the biggest files in my downloads?').done;
    expect(JSON.stringify(h.provider.lastRequest?.messages)).toContain("The user's folders");
    await h.close();
  });
});
