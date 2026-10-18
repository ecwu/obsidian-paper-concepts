import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from './helpers';

const ui = vi.hoisted(() => {
  class Element {
    text = ''; children: Element[] = [];
    get textContent() { return this.text; }
    empty() { this.children = []; } addClass() {}
    setText(value: string) { this.text = value; }
    createEl(_tag: string, options?: { text?: string }) { const child = new Element(); child.text = options?.text ?? ''; this.children.push(child); return child; }
  }
  class Control {
    value = ''; label = ''; disabled = false;
    change?: (value: string) => void; click?: () => void | Promise<void>;
    setValue(value: string) { this.value = value; return this; }
    onChange(callback: (value: string) => void) { this.change = callback; return this; }
    addOption() { return this; }
    setButtonText(value: string) { this.label = value; return this; }
    setDisabled(value: boolean) { this.disabled = value; return this; }
    setCta() { return this; }
    onClick(callback: () => void | Promise<void>) { this.click = callback; return this; }
  }
  const rows: Setting[] = []; const secrets: Control[] = [];
  class Setting {
    name = ''; controls: Control[] = [];
    constructor(_el: Element) { rows.push(this); }
    setName(value: string) { this.name = value; return this; }
    setDesc() { return this; } setClass() { return this; }
    add(callback: (control: Control) => void) { const control = new Control(); this.controls.push(control); callback(control); return this; }
    addDropdown(callback: (control: Control) => void) { return this.add(callback); }
    addText(callback: (control: Control) => void) { return this.add(callback); }
    addTextArea(callback: (control: Control) => void) { return this.add(callback); }
    addButton(callback: (control: Control) => void) { return this.add(callback); }
    addComponent(callback: (container: Element) => void) { callback(new Element()); return this; }
  }
  class SecretComponent extends Control { constructor(_app: unknown, _el: Element) { super(); secrets.push(this); } }
  class PluginSettingTab { containerEl = new Element(); constructor(public app: unknown) {} }
  return { rows, secrets, Setting, SecretComponent, PluginSettingTab, testApi: vi.fn() };
});
vi.mock('obsidian', () => ({ Setting: ui.Setting, SecretComponent: ui.SecretComponent, PluginSettingTab: ui.PluginSettingTab, ItemView: class {}, Notice: class {} }));
vi.mock('../src/obsidian-port', () => ({ obsidianHttp: vi.fn() }));
vi.mock('../src/mineru', () => ({ testMineruApi: ui.testApi }));
import { PaperSettingsTab } from '../src/ui';
import type PaperConceptsPlugin from '../src/main';
import type { App } from 'obsidian';

function setup() {
  const plugin = { settings: settings(), saveParsingSettings: vi.fn(async (preferences: object) => { Object.assign(plugin.settings, preferences); }), report: vi.fn() };
  const app = { secretStorage: { getSecret: vi.fn(() => 'test-token') } };
  const tab = new PaperSettingsTab(app as unknown as App, plugin as unknown as PaperConceptsPlugin); tab.display();
  return { plugin, app, tab };
}
const button = (label: string) => ui.rows.flatMap(row => row.controls).find(control => control.label === label)!;
beforeEach(() => { ui.rows.length = 0; ui.secrets.length = 0; ui.testApi.mockReset(); });
describe('native settings controls', () => {
  it('persists a parser selection immediately without the bottom save button', async () => {
    const { plugin } = setup();
    ui.rows.find(row => row.name === 'PDF 解析器')!.controls[0]!.change!('mineru');
    await vi.waitFor(() => expect(plugin.settings.parser).toBe('mineru'));
    expect(plugin.saveParsingSettings).toHaveBeenCalledWith({ parser: 'mineru', mineruSecret: 'paper-concepts-mineru' });
  });
  it('tests the newly selected secret and renders the result beside the controls', async () => {
    const { app, tab } = setup(); ui.secrets[0]!.change!('different-key');
    ui.testApi.mockResolvedValue('MinerU API 测试成功');
    await button('测试 MinerU API').click!();
    expect(app.secretStorage.getSecret).toHaveBeenCalledWith('different-key'); expect(ui.testApi.mock.calls[0]![1]).toBe('test-token');
    expect(Array.from(tab.containerEl.children).some(child => child.textContent === 'MinerU API 测试成功')).toBe(true);
    expect(button('测试 MinerU API').disabled).toBe(false); expect(button('取消测试').disabled).toBe(true);
  });
  it('cancels the test when settings close', async () => {
    const { tab } = setup(); let active!: AbortSignal;
    ui.testApi.mockImplementation(async (_http, _token, signal: AbortSignal) => new Promise((_resolve, reject) => { active = signal; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }));
    const running = button('测试 MinerU API').click!();
    await vi.waitFor(() => expect(ui.testApi).toHaveBeenCalledOnce()); tab.hide(); await running;
    expect(active.aborted).toBe(true); expect(Array.from(tab.containerEl.children).some(child => child.textContent?.startsWith('测试已取消'))).toBe(true);
  });
});
