import { describe, expect, it } from 'vitest';
import { AppDiscovery } from '../src/main/desktop/appDiscovery';

describe('finding apps when Windows answers slowly or not at all', () => {
  it('Notepad and other built-in apps are always findable, and a failed read is not remembered', async () => {
    let calls = 0;
    const d = new AppDiscovery(async () => {
      calls++;
      if (calls === 1) throw new Error('Windows took too long to list the apps.');
      return [
        { name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' },
        { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
        { name: 'Google Chrome', appId: 'Chrome' },
        { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode' },
        { name: 'Notepad', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' },
      ];
    });
    const first = await d.find('notepad');
    expect(first[0]?.app.appId).toBe('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe');
    expect((await d.find('calculator'))[0]?.app.name).toBe('Calculator');
    // The next request asks Windows again; the real Notepad entry wins over the built-in one.
    const second = await d.find('notepad');
    expect(calls).toBe(2);
    expect(second[0]?.app.appId).toBe('Microsoft.WindowsNotepad_8wekyb3d8bbwe!App');
    expect(second.filter((m) => m.app.name === 'Notepad')).toHaveLength(1);
    await d.find('spotify');
    expect(calls).toBe(2); // a good list is remembered
  });
});
