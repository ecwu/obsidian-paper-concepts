import { describe, expect, it } from 'vitest';
import { loadSettings, parsingSettings, SettingsPersistence } from '../src/settings';

describe('parser preference persistence', () => {
  it('saves parser preferences before a knowledge folder is configured', async () => {
    let current = loadSettings(), saved = current;
    const persistence = new SettingsPersistence(() => current, async next => { saved = next; }, next => { current = next; });
    await persistence.update(s => parsingSettings(s, { parser: 'mineru', mineruSecret: 'saved-key' }));
    expect(saved.parser).toBe('mineru'); expect(current.parser).toBe('mineru'); expect(current.root).toBe('');
    expect(current.prompts).toEqual(loadSettings().prompts);
  });
  it('serializes rapid parser and secret changes and keeps the latest values', async () => {
    let current = loadSettings(); const writes: string[] = [];
    const persistence = new SettingsPersistence(() => current, async next => { await new Promise(r => setTimeout(r, 5)); writes.push(next.parser + ':' + next.mineruSecret); }, next => { current = next; });
    const first = persistence.update(s => parsingSettings(s, { parser: 'mineru', mineruSecret: s.mineruSecret }));
    const second = persistence.update(s => parsingSettings(s, { parser: s.parser, mineruSecret: 'new-key' }));
    await persistence.flush(); await Promise.all([first, second]);
    expect(current.parser).toBe('mineru'); expect(current.mineruSecret).toBe('new-key'); expect(writes.at(-1)).toBe('mineru:new-key');
  });
  it('does not apply failed writes and allows the next save', async () => {
    let current = loadSettings(), fail = true;
    const persistence = new SettingsPersistence(() => current, async () => { if (fail) throw new Error('disk full'); }, next => { current = next; });
    await expect(persistence.update(s => parsingSettings(s, { parser: 'mineru', mineruSecret: 'key' }))).rejects.toThrow('disk full');
    expect(current.parser).toBe('local'); fail = false;
    await persistence.update(s => parsingSettings(s, { parser: 'mineru', mineruSecret: 'key' })); expect(current.parser).toBe('mineru');
  });
});
