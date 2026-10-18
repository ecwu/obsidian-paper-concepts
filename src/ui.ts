import { App, ItemView, PluginSettingTab, Setting, WorkspaceLeaf, SecretComponent, Notice, type TextAreaComponent } from 'obsidian';
import type PaperConceptsPlugin from './main';
import { PARSERS, PROVIDERS, type Job, type ParserKind, type Phase, type Prompts, type Provider } from './types';
import { DEFAULT_PROMPTS } from './prompts';
import { CliHarness, HARNESSES } from './harness';
import { canRetry, isFinished, isPending } from './jobs';

export const VIEW_TYPE = 'paper-concepts';
const LABELS: Record<Phase, string> = {
  queued: '等待处理', parsing: '解析 PDF', context: '准备知识', generating: '分析论文', validating: '检查结果',
  writing: '保存笔记', succeeded: '已完成', failed: '处理失败', cancelled: '已取消', interrupted: '等待恢复'
};
const PARSER_LABELS: Record<ParserKind, string> = { local: '本地文本提取', mineru: 'MinerU 云端解析' };
const FOLDER_FIELDS = [['inbox', '收件目录'], ['papers', '论文目录'], ['concepts', '概念目录'], ['assets', '附件目录']] as const;
const PROMPT_FIELDS = [['workflow', '工作流程'], ['paper', 'Paper 格式'], ['concept', 'Concept 格式'], ['writing', '写作规范']] as const;
export class PaperView extends ItemView {
  private update = () => this.renderTasks();
  private tasks?: HTMLElement;
  private status?: HTMLElement;
  private pauseButton?: HTMLButtonElement;
  private selected?: string;
  constructor(leaf: WorkspaceLeaf, private plugin: PaperConceptsPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Paper Concepts'; }
  getIcon(): string { return 'book-open'; }
  async onOpen(): Promise<void> {
    this.plugin.listeners.add(this.update); this.render();
  }
  async onClose(): Promise<void> { this.plugin.listeners.delete(this.update); }
  private run(action: () => Promise<unknown>): void { void action().catch(e => this.plugin.report(e)); }
  private render(): void {
    const el = this.contentEl; el.empty(); el.addClass('pc-view');
    const header = el.createDiv({ cls: 'pc-header' });
    header.createEl('h1', { text: '论文知识库' });
    header.createEl('p', { text: '保存论文，让概念随阅读积累。', cls: 'pc-muted' });
    const actions = header.createDiv({ cls: 'pc-actions' });
    const importButton = actions.createEl('button', { text: '导入 PDF', cls: 'mod-cta' });
    importButton.addEventListener('click', () => this.plugin.chooseFiles());
    const configure = actions.createEl('button', { text: '配置知识库' });
    configure.addEventListener('click', () => {
      const setting = (this.app as App & { setting: { open(): void; openTabById(id: string): void } }).setting;
      setting.open(); setting.openTabById(this.plugin.manifest.id);
    });
    const drop = el.createDiv({ cls: 'pc-drop', attr: { role: 'button', tabindex: '0', 'aria-label': '拖入或选择 PDF 文件' } });
    drop.createEl('strong', { text: '将 PDF 拖到这里' });
    drop.createEl('span', { text: '支持批量导入。原始文件会保留在指定知识目录中。', cls: 'pc-muted' });
    drop.addEventListener('click', () => this.plugin.chooseFiles());
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.plugin.chooseFiles(); } });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.addClass('is-dragging'); });
    drop.addEventListener('dragleave', () => drop.removeClass('is-dragging'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.removeClass('is-dragging'); if (e.dataTransfer?.files) void this.plugin.importFiles([...e.dataTransfer.files]); });
    this.status = el.createDiv({ cls: 'pc-status', attr: { role: 'status', 'aria-live': 'polite' } });
    const toolbar = el.createDiv({ cls: 'pc-toolbar' }); toolbar.createEl('h2', { text: '处理记录' });
    this.pauseButton = toolbar.createEl('button');
    this.pauseButton.addEventListener('click', () => this.plugin.engine.setPaused(!this.plugin.engine.paused));
    this.tasks = el.createDiv({ cls: 'pc-tasks' }); this.renderTasks();
  }
  private renderTasks(): void {
    if (!this.tasks || !this.status) return;
    const engine = this.plugin.engine;
    const settings = this.plugin.settings;
    this.status.setText(settings.root ? `${settings.root} · ${settings.provider} · ${PARSER_LABELS[settings.parser]}` : '先在配置中选择一个仓库内目录，再导入 PDF。');
    this.pauseButton!.textContent = engine.paused ? '继续队列' : '暂停队列';
    this.tasks.empty();
    const jobs = engine.jobs.filter(j => j.root === settings.root);
    if (!jobs.length) { this.tasks.createEl('p', { text: '还没有论文。导入后可在这里查看分析进度与结果。', cls: 'pc-empty' }); return; }
    for (const job of jobs) this.renderJob(job);
  }
  private renderJob(job: Job): void {
    const row = this.tasks!.createEl('article', { cls: 'pc-job' });
    const heading = row.createDiv({ cls: 'pc-job-heading' }); heading.createEl('h3', { text: job.filename });
    heading.createEl('span', { text: LABELS[job.phase], cls: 'pc-state pc-state-' + job.phase });
    row.createEl('p', { text: `${job.settings.provider} · ${PARSER_LABELS[job.settings.parser]} · ${new Date(job.created).toLocaleString()}`, cls: 'pc-muted pc-meta' });
    const active = this.plugin.engine.activeJob?.id === job.id;
    if (active) row.createEl('p', { text: job.logs.at(-1)?.text ?? LABELS[job.phase], cls: 'pc-phase' });
    if (job.error) row.createEl('p', { text: job.error, cls: 'pc-error', attr: { role: 'alert' } });
    const controls = row.createDiv({ cls: 'pc-actions' });
    const button = (text: string, action: () => Promise<unknown>) => { const b = controls.createEl('button', { text }); b.addEventListener('click', () => this.run(action)); };
    if (job.paperPath) button('打开论文', () => this.app.workspace.openLinkText(job.paperPath!, '', false));
    if (active || isPending(job)) button('取消', () => this.plugin.engine.cancel(job.id));
    if (!active && canRetry(job)) button('重试原任务', () => this.plugin.engine.retry(job.id));
    if (!active && isFinished(job)) {
      button('重新分析', () => this.plugin.engine.reanalyze(job.id));
      if (job.settings.parser === 'local') button('改用 MinerU', () => this.plugin.engine.reanalyze(job.id, 'mineru'));
    }
    const logs = row.createEl('details'); logs.open = this.selected === job.id;
    logs.createEl('summary', { text: '查看日志' });
    logs.addEventListener('toggle', () => { if (logs.open) this.selected = job.id; else if (this.selected === job.id) this.selected = undefined; });
    logs.createEl('pre', { text: job.logs.map(l => `${new Date(l.at).toLocaleTimeString()}  ${l.text}`).join('\n'), cls: 'pc-log' });
  }
}

export class PaperSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: PaperConceptsPlugin) { super(app, plugin); }
  display(): void {
    const el = this.containerEl; el.empty(); el.addClass('pc-settings');
    const draft = structuredClone(this.plugin.settings);
    el.createEl('h2', { text: 'Paper Concepts' });
    el.createEl('p', { text: '只在指定目录内整理学术论文。所有生成结果自动保存。' });
    const text = (name: string, description: string, value: string, update: (value: string) => void) =>
      new Setting(el).setName(name).setDesc(description).addText(input => input.setValue(value).onChange(update));
    text('知识目录', '使用仓库内相对路径，例如 100-Research/190-Paper Library。已有文件会保留。', draft.root, v => { draft.root = v.trim(); });
    for (const [key, label] of FOLDER_FIELDS) text(label, '相对于知识目录。', draft[key], v => { draft[key] = v.trim(); });
    new Setting(el).setName('PDF 解析器').setDesc('本地提取只读取 PDF 文字；选择 MinerU 会上传 PDF 到其云端服务。').addDropdown(dropdown => {
      for (const parser of PARSERS) dropdown.addOption(parser, PARSER_LABELS[parser]);
      dropdown.setValue(draft.parser).onChange(v => { draft.parser = v as ParserKind; });
    });
    new Setting(el).setName('MinerU Token').setDesc('选择 Obsidian 凭据存储中的密钥。密钥不会写入插件配置。').addComponent(container =>
      new SecretComponent(this.app, container).setValue(draft.mineruSecret).onChange(v => { draft.mineruSecret = v ?? ''; }));
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
