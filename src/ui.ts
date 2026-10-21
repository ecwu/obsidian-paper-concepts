import { App, ItemView, Menu, setIcon, PluginSettingTab, Setting, WorkspaceLeaf, SecretComponent, Notice, type ButtonComponent, type TextAreaComponent } from 'obsidian';
import type PaperConceptsPlugin from './main';
import { PARSERS, PROVIDERS, type Job, type ParserKind, type Phase, type Prompts, type Provider, type Settings } from './types';
import { DEFAULT_PROMPTS } from './prompts';
import { CliHarness, HARNESSES } from './harness';
import { canRetry, isFinished, isPending } from './jobs';
import { testMineruApi } from './mineru';
import { obsidianHttp } from './obsidian-port';
import { redact } from './util';

export const VIEW_TYPE = 'paper-concepts';
const LABELS: Record<Phase, string> = {
  queued: '等待处理', parsing: '解析 PDF', context: '准备知识', generating: '分析论文', validating: '检查结果',
  writing: '保存笔记', succeeded: '已完成', failed: '处理失败', cancelled: '已取消', interrupted: '等待恢复'
};
const PARSER_LABELS: Record<ParserKind, string> = { local: '本地文本提取', mineru: 'MinerU 云端解析' };
const FOLDER_FIELDS = [['inbox', '收件目录'], ['papers', '论文目录'], ['concepts', '概念目录'], ['assets', '附件目录']] as const;
const PROMPT_FIELDS = [['workflow', '工作流程'], ['paper', 'Paper 格式'], ['concept', 'Concept 格式'], ['writing', '写作规范']] as const;
const HISTORY_PAGE = 10;
export class PaperView extends ItemView {
  private update = () => this.renderTasks();
  private tasks?: HTMLElement;
  private status?: HTMLElement;
  private pauseButton?: HTMLElement;
  private selected?: string;
  private historyOpen = true;
  private historyLimit = HISTORY_PAGE;
  constructor(leaf: WorkspaceLeaf, private plugin: PaperConceptsPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Paper Concepts'; }
  getIcon(): string { return 'book-open'; }
  async onOpen(): Promise<void> {
    this.plugin.listeners.add(this.update); this.render();
  }
  async onClose(): Promise<void> { this.plugin.listeners.delete(this.update); }
  private run(action: () => Promise<unknown>): void { void action().catch(e => this.plugin.report(e)); }
  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void): HTMLElement {
    const b = parent.createDiv({ cls: 'clickable-icon', attr: { role: 'button', tabindex: '0', 'aria-label': label } });
    setIcon(b, icon);
    b.addEventListener('click', e => { e.stopPropagation(); onClick(e); });
    b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); } });
    return b;
  }
  private render(): void {
    const el = this.contentEl; el.empty(); el.addClass('pc-view');
    const header = el.createDiv({ cls: 'pc-header' });
    header.createDiv({ text: '论文知识库', cls: 'pc-title' });
    const actions = header.createDiv({ cls: 'pc-header-actions' });
    this.iconButton(actions, 'file-plus', '导入 PDF', () => this.plugin.chooseFiles());
    this.pauseButton = this.iconButton(actions, 'pause', '暂停队列', () => this.plugin.engine.setPaused(!this.plugin.engine.paused));
    this.iconButton(actions, 'settings', '配置知识库', () => {
      const setting = (this.app as App & { setting: { open(): void; openTabById(id: string): void } }).setting;
      setting.open(); setting.openTabById(this.plugin.manifest.id);
    });
    const drop = el.createDiv({ cls: 'pc-drop', attr: { role: 'button', tabindex: '0', 'aria-label': '拖入或选择 PDF 文件' } });
    setIcon(drop.createSpan({ cls: 'pc-drop-icon' }), 'upload');
    drop.createSpan({ text: '拖入 PDF 或点击选择' });
    drop.addEventListener('click', () => this.plugin.chooseFiles());
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.plugin.chooseFiles(); } });
    // The whole view accepts drops; the strip only highlights.
    el.addEventListener('dragover', e => { e.preventDefault(); drop.addClass('is-dragging'); });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget as Node | null)) drop.removeClass('is-dragging'); });
    el.addEventListener('drop', e => { e.preventDefault(); drop.removeClass('is-dragging'); if (e.dataTransfer?.files) void this.plugin.importFiles([...e.dataTransfer.files]); });
    this.status = el.createDiv({ cls: 'pc-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.tasks = el.createDiv({ cls: 'pc-tasks' }); this.renderTasks();
  }
  private renderTasks(): void {
    if (!this.tasks || !this.status) return;
    const engine = this.plugin.engine;
    const settings = this.plugin.settings;
    const context = settings.root ? `${settings.root} · ${settings.provider} · ${PARSER_LABELS[settings.parser]}` : '先在配置中选择一个仓库内目录，再导入 PDF。';
    this.status.setText((engine.paused ? '队列已暂停 · ' : '') + context);
    this.status.setAttr('title', context);
    if (this.pauseButton) {
      setIcon(this.pauseButton, engine.paused ? 'play' : 'pause');
      this.pauseButton.setAttr('aria-label', engine.paused ? '继续队列' : '暂停队列');
      this.pauseButton.toggleClass('is-active', engine.paused);
    }
    this.tasks.empty();
    const jobs = engine.jobs.filter(j => j.root === settings.root);
    if (!jobs.length) { this.tasks.createEl('p', { text: '还没有论文。导入后可在这里查看分析进度与结果。', cls: 'pc-empty' }); return; }
    const current = jobs.filter(j => j.phase !== 'succeeded'), done = jobs.filter(j => j.phase === 'succeeded');
    if (current.length) {
      this.tasks.createDiv({ text: `进行中 · ${current.length}`, cls: 'pc-section-title' });
      for (const job of current) this.renderJob(this.tasks, job);
    }
    if (done.length) this.renderHistory(done);
  }
  private renderJob(parent: HTMLElement, job: Job): void {
    const row = parent.createEl('article', { cls: 'pc-job' });
    const heading = row.createDiv({ cls: 'pc-job-heading' });
    heading.createDiv({ text: displayName(job.filename), cls: 'pc-job-title', attr: { title: job.filename } });
    heading.createSpan({ text: LABELS[job.phase], cls: 'pc-state pc-state-' + job.phase });
    const active = this.plugin.engine.activeJob?.id === job.id;
    if (active) row.createDiv({ text: job.logs.at(-1)?.text ?? LABELS[job.phase], cls: 'pc-phase' });
    if (job.error) row.createDiv({ text: job.error, cls: 'pc-error', attr: { role: 'alert' } });
    const controls = row.createDiv({ cls: 'pc-job-actions' });
    const button = (text: string, action: () => Promise<unknown>) => { const b = controls.createEl('button', { text }); b.addEventListener('click', () => this.run(action)); };
    if (active || isPending(job)) button('取消', () => this.plugin.engine.cancel(job.id));
    if (!active && canRetry(job)) button('重试', () => this.plugin.engine.retry(job.id));
    // A failed local parse keeps the PDF in the runtime store, so MinerU can parse it again.
    if (!active && canRetry(job) && job.settings.parser === 'local') button('改用 MinerU', () => this.plugin.engine.reanalyze(job.id, 'mineru'));
    this.iconButton(controls, 'more-horizontal', '更多操作', e => this.openMenu(job, e));
    if (this.selected === job.id) this.renderLog(row, job);
  }
  private renderHistory(done: Job[]): void {
    const section = this.tasks!.createDiv({ cls: 'pc-history' });
    const title = section.createDiv({ cls: 'pc-section-title pc-collapsible', attr: { role: 'button', tabindex: '0', 'aria-expanded': String(this.historyOpen) } });
    setIcon(title.createSpan({ cls: 'pc-chevron' }), this.historyOpen ? 'chevron-down' : 'chevron-right');
    title.createSpan({ text: `已完成 · ${done.length}` });
    const toggle = () => { this.historyOpen = !this.historyOpen; this.renderTasks(); };
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    if (!this.historyOpen) return;
    const list = section.createDiv({ cls: 'pc-history-list' });
    for (const job of done.slice(0, this.historyLimit)) {
      const item = list.createDiv({ cls: 'pc-history-item' });
      const line = item.createDiv({ cls: 'pc-history-line', attr: { role: 'button', tabindex: '0', title: `${job.filename}\n${job.settings.provider} · ${PARSER_LABELS[job.settings.parser]} · ${new Date(job.created).toLocaleString()}` } });
      line.createSpan({ text: displayName(job.filename), cls: 'pc-history-name' });
      line.createSpan({ text: shortDate(job.created), cls: 'pc-history-date' });
      this.iconButton(line, 'more-horizontal', '更多操作', e => this.openMenu(job, e));
      const open = () => { if (job.paperPath) this.run(() => this.app.workspace.openLinkText(job.paperPath!, '', false)); };
      line.addEventListener('click', open);
      line.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); open(); } });
      line.addEventListener('contextmenu', e => { e.preventDefault(); this.openMenu(job, e); });
      if (this.selected === job.id) this.renderLog(item, job);
    }
    if (done.length > this.historyLimit) {
      const more = section.createEl('button', { text: `显示更多（还有 ${done.length - this.historyLimit} 篇）`, cls: 'pc-more' });
      more.addEventListener('click', () => { this.historyLimit += HISTORY_PAGE * 2; this.renderTasks(); });
    }
  }
  private openMenu(job: Job, e: MouseEvent): void {
    const active = this.plugin.engine.activeJob?.id === job.id;
    const menu = new Menu();
    if (job.paperPath) menu.addItem(i => i.setTitle('打开论文').setIcon('file-text').onClick(() => this.run(() => this.app.workspace.openLinkText(job.paperPath!, '', false))));
    if (!active && isFinished(job)) menu.addItem(i => i.setTitle('按当前设置重新分析').setIcon('refresh-cw').onClick(() => this.run(() => this.plugin.engine.reanalyze(job.id))));
    menu.addItem(i => i.setTitle(this.selected === job.id ? '收起日志' : '查看日志').setIcon('scroll-text').onClick(() => {
      this.selected = this.selected === job.id ? undefined : job.id; this.renderTasks();
    }));
    menu.showAtMouseEvent(e);
  }
  private renderLog(parent: HTMLElement, job: Job): void {
    parent.createEl('pre', { text: job.logs.map(l => `${new Date(l.at).toLocaleTimeString()}  ${l.text}`).join('\n'), cls: 'pc-log' });
  }
}

const displayName = (filename: string): string => filename.replace(/\.pdf$/i, '');
/** Time for today, otherwise month and day; the year only when it differs. */
function shortDate(iso: string): string {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export class PaperSettingsTab extends PluginSettingTab {
  private testController?: AbortController;
  constructor(app: App, private plugin: PaperConceptsPlugin) { super(app, plugin); }
  hide(): void { this.testController?.abort(); }
  /** The parser and secret save on change, so a new import uses them without the save button. */
  private renderParsing(el: HTMLElement, draft: Settings): void {
    const status = el.createEl('p', { cls: 'pc-muted', attr: { role: 'status', 'aria-live': 'polite' } });
    let revision = 0;
    const save = () => {
      const current = ++revision;
      status.setText('正在保存解析设置…');
      this.plugin.saveParsingSettings({ parser: draft.parser, mineruSecret: draft.mineruSecret }).then(
        () => { if (current === revision) status.setText(`已保存：${PARSER_LABELS[this.plugin.settings.parser]}。新导入或按当前设置重新分析时生效。`); },
        error => { if (current === revision) status.setText(`解析设置保存失败：${redact(String(error.message ?? error))}`); });
    };
    new Setting(el).setName('PDF 解析器').setDesc('修改后立即保存。已有任务保留原解析器；选择 MinerU 会上传新任务的 PDF 到其云端服务。').addDropdown(dropdown => {
      for (const parser of PARSERS) dropdown.addOption(parser, PARSER_LABELS[parser]);
      dropdown.setValue(draft.parser).onChange(v => { draft.parser = v as ParserKind; save(); });
    });
    new Setting(el).setName('MinerU Token').setDesc('选择 Obsidian 凭据存储中的密钥。选择后立即保存，Token 不会写入插件配置。').addComponent(container =>
      new SecretComponent(this.app, container).setValue(draft.mineruSecret).onChange(v => { draft.mineruSecret = v ?? ''; save(); }));
  }
  /** Tests the selected secret against the real API with a synthetic PDF. Closing the settings cancels the test. */
  private renderMineruTest(el: HTMLElement, draft: Settings): void {
    const result = el.createEl('p', { cls: 'pc-muted', attr: { role: 'status', 'aria-live': 'polite' } });
    const setting = new Setting(el).setName('MinerU API 测试')
      .setDesc('上传内置的一页测试 PDF，检查认证、上传、解析和下载，会使用解析额度。不上传仓库文件，不调用 AI，不保存笔记。');
    let start!: ButtonComponent, cancel!: ButtonComponent;
    const run = async () => {
      if (this.testController) return;
      const controller = new AbortController(); this.testController = controller;
      start.setDisabled(true); cancel.setDisabled(false);
      result.setText('正在准备 MinerU API 测试…');
      try {
        const token = this.app.secretStorage.getSecret(draft.mineruSecret) ?? '';
        result.setText(await testMineruApi(obsidianHttp, token, controller.signal, text => result.setText(text)));
      } catch (error) {
        result.setText(controller.signal.aborted ? '测试已取消。已上传的云端任务可能继续运行。' : `测试失败：${redact((error as Error).message)}`);
      } finally {
        if (this.testController === controller) this.testController = undefined;
        start.setDisabled(false); cancel.setDisabled(true);
      }
    };
    setting.addButton(button => { start = button; button.setButtonText('测试 MinerU API').onClick(run); });
    setting.addButton(button => { cancel = button; button.setButtonText('取消测试').setDisabled(true).onClick(() => this.testController?.abort()); });
  }
  display(): void {
    this.testController?.abort();
    const el = this.containerEl; el.empty(); el.addClass('pc-settings');
    const draft = structuredClone(this.plugin.settings);
    el.createEl('h2', { text: 'Paper Concepts' });
    el.createEl('p', { text: '只在指定目录内整理学术论文。所有生成结果自动保存。' });
    const text = (name: string, description: string, value: string, update: (value: string) => void) =>
      new Setting(el).setName(name).setDesc(description).addText(input => input.setValue(value).onChange(update));
    text('知识目录', '使用仓库内相对路径，例如 100-Research/190-Paper Library。已有文件会保留。', draft.root, v => { draft.root = v.trim(); });
    for (const [key, label] of FOLDER_FIELDS) text(label, '相对于知识目录。', draft[key], v => { draft[key] = v.trim(); });
    this.renderParsing(el, draft);
    this.renderMineruTest(el, draft);
    new Setting(el).setName('AI Harness').addDropdown(dropdown => {
      for (const provider of PROVIDERS) dropdown.addOption(provider, HARNESSES[provider].label);
      dropdown.setValue(draft.provider).onChange(v => { draft.provider = v as Provider; });
    });
    for (const provider of PROVIDERS) {
      text(`${provider} 程序`, '可填命令名或绝对路径。', draft.executables[provider], v => { draft.executables[provider] = v; });
      text(`${provider} 模型`, '留空以沿用 Harness 的默认模型与认证。', draft.models[provider], v => { draft.models[provider] = v; });
    }
    text('超时（分钟）', '适用于每次 Harness 分析，范围 1–180。', String(draft.timeoutMinutes), v => { draft.timeoutMinutes = Number(v); });
    new Setting(el).setName('程序检测').setDesc('只读取所选 CLI 的版本，不发起模型请求。').addButton(button => button.setButtonText('检测 Harness').onClick(async () => {
      button.setDisabled(true);
      try { new Notice(await new CliHarness(draft.provider, draft.executables[draft.provider]).detect(), 10_000); }
      catch (e) { this.plugin.report(e); }
      finally { button.setDisabled(false); }
    }));
    el.createEl('h3', { text: '提示词' });
    el.createEl('p', { text: '修改只影响之后导入或重新分析的任务。每个任务保留自己的提示词版本。', cls: 'pc-muted' });
    const promptAreas: Partial<Record<keyof Prompts, TextAreaComponent>> = {};
    for (const [key, label] of PROMPT_FIELDS) {
      new Setting(el).setName(label).setClass('pc-prompt-setting').addTextArea(area => {
        promptAreas[key] = area;
        area.setValue(draft.prompts[key]).onChange(value => { draft.prompts[key] = value; });
      });
    }
    const result = el.createEl('p', { cls: 'pc-muted', attr: { role: 'status' } });
    new Setting(el).addButton(button => button.setButtonText('保存并初始化目录').setCta().onClick(async () => {
      button.setDisabled(true);
      try {
        await this.plugin.saveSettings(draft); await this.plugin.initialize();
        result.setText('配置已保存，知识目录已就绪。');
      } catch (e) { result.setText((e as Error).message); this.plugin.report(e); }
      finally { button.setDisabled(false); }
    })).addButton(button => button.setButtonText('恢复默认提示词').onClick(() => {
      draft.prompts = structuredClone(DEFAULT_PROMPTS);
      for (const [key] of PROMPT_FIELDS) promptAreas[key]?.setValue(DEFAULT_PROMPTS[key]);
      result.setText('已恢复默认提示词，保存后生效。');
    }));
  }
}
