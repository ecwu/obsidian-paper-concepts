import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { createInterface } from 'node:readline';
import { stringify } from 'yaml';
import type { GenerationResult, HarnessAdapter, HarnessEvent, HarnessRequest, Provider } from './types';
import { OUTPUT_SCHEMA, validateResult } from './result';
import { aborted, cancellation, redact } from './util';

export interface DecodedEvent { event?: HarnessEvent; answer?: unknown; text?: string; fatal?: string }
type JsonEvent = Record<string, any>;

/** Everything that differs between harness CLIs. The process handling in `CliHarness` is shared. */
interface HarnessSpec {
  label: string;
  /** Supported major version, as printed by `--version`. */
  major: number;
  args(request: HarnessRequest): string[];
  /** Text written to stdin; the prompt goes either here or into `args`. */
  stdin(request: HarnessRequest): string;
  decode(event: JsonEvent): DecodedEvent;
  /** Writes provider configuration into the task directory before the run. */
  prepare?(cwd: string): Promise<void>;
}

const TOOL_EVENT: DecodedEvent = { event: { kind: 'tool', text: '读取论文或检索知识' } };
const modelArgs = (flag: string, request: HarnessRequest) => request.model ? [flag, request.model] : [];

/** Read-only OpenCode agent. Both config locations OpenCode loads get the same definition. */
const OPENCODE_AGENT = {
  description: 'Read academic papers and return structured knowledge without editing files', mode: 'primary',
  permissions: [
    { action: '*', resource: '*', effect: 'deny' },
    ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
    { action: 'external_directory', resource: '*', effect: 'deny' }
  ]
};
const OPENCODE_INSTRUCTIONS = 'Read the task files and return only the requested JSON. Never edit files or run commands.';

export const HARNESSES: Record<Provider, HarnessSpec> = {
  codex: {
    label: 'Codex', major: 0,
    args: request => ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"',
      '--output-schema', join(request.cwd, 'schema.json'), ...modelArgs('--model', request), '-'],
    stdin: request => request.prompt,
    decode: v => {
      if (v.type === 'turn.failed' || v.type === 'error') return { fatal: v.error?.message ?? v.message ?? 'Codex 执行失败' };
      if (v.type === 'item.completed' && v.item?.type === 'agent_message') return { text: v.item.text };
      if (v.type?.startsWith('item.') && v.item?.type === 'command_execution') return TOOL_EVENT;
      return {};
    }
  },
  claude: {
    label: 'Claude Code', major: 2,
    args: request => ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
      '--json-schema', JSON.stringify(OUTPUT_SCHEMA), ...modelArgs('--model', request)],
    stdin: request => request.prompt,
    decode: v => {
      if (v.type === 'result') {
        if (v.is_error || v.subtype !== 'success') return { fatal: (v.errors ?? [v.result ?? v.subtype]).join('\n') };
        return v.structured_output ? { answer: v.structured_output } : { text: v.result };
      }
      if (v.type === 'assistant') {
        const text = (v.message?.content ?? []).filter((c: JsonEvent) => c.type === 'text').map((c: JsonEvent) => c.text).join('');
        return text ? { text } : TOOL_EVENT;
      }
      return {};
    }
  },
  opencode: {
    label: 'OpenCode v2', major: 2,
    args: request => ['run', '--standalone', '--format', 'json', '--agent', 'paper-concepts', ...modelArgs('-m', request), request.prompt],
    stdin: () => '',
    decode: v => {
      if (v.type === 'error') return { fatal: v.error?.data?.message ?? v.error?.message ?? v.message ?? 'OpenCode 执行失败' };
      const part = v.part ?? v.properties?.part;
      if (v.type === 'text' || v.type === 'message.part.updated' && part?.type === 'text') return { text: part?.text ?? v.text };
      if (v.type === 'tool_use' || part?.type === 'tool') return TOOL_EVENT;
      return {};
    },
    prepare: async cwd => {
      await mkdir(join(cwd, '.opencode', 'agents'), { recursive: true, mode: 0o700 });
      await writeFile(join(cwd, '.opencode', 'agents', 'paper-concepts.md'), `---\n${stringify(OPENCODE_AGENT)}---\n${OPENCODE_INSTRUCTIONS}\n`, { mode: 0o600 });
      await writeFile(join(cwd, 'opencode.json'), JSON.stringify({ agents: { 'paper-concepts': OPENCODE_AGENT } }), { mode: 0o600 });
    }
  }
};

export function harnessEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const home = env.HOME ?? env.USERPROFILE ?? '';
  env.PATH = [join(home, '.bun/bin'), join(home, '.opencode/bin'), join(home, '.local/bin'), env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
export function parseAnswer(text: string): GenerationResult {
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  try { return validateResult(JSON.parse(cleaned)); } catch (e) { throw new Error(`Harness 未返回有效的知识结果：${(e as Error).message}`); }
}
/** Stops the child and its process group, escalating to SIGKILL after two seconds. */
function terminate(child: ChildProcess): void {
  if (!child.pid) return;
  const signal = (name: NodeJS.Signals) => {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid!, name);
  };
  try { signal('SIGTERM'); } catch { child.kill('SIGTERM'); }
  const timer = setTimeout(() => { try { signal('SIGKILL'); } catch { /* Process already exited. */ } }, 2000);
  timer.unref(); child.once('close', () => clearTimeout(timer));
}

export class CliHarness implements HarnessAdapter {
  private spec: HarnessSpec;
  constructor(readonly provider: Provider, readonly executable: string) { this.spec = HARNESSES[provider]; }
  async detect(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['--version'], { shell: false, env: harnessEnvironment(), windowsHide: true });
      let output = '', errors = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('版本检测超时，请检查程序路径')); }, 10_000);
      child.stdout?.on('data', b => { output += String(b).slice(0, 2000); });
      child.stderr?.on('data', b => { errors += String(b).slice(0, 2000); });
      child.once('error', error => { clearTimeout(timer); reject(new Error(`无法启动 ${this.provider}：${error.message}`)); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(redact(errors || '版本检测失败'))); });
    });
  }
  async run(request: HarnessRequest, signal: AbortSignal, onEvent: (event: HarnessEvent) => void): Promise<GenerationResult> {
    aborted(signal);
    const version = await this.detect();
    const major = Number(/\b(?:v)?(\d+)\./.exec(version)?.[1]);
    if (major !== this.spec.major) throw new Error(`${this.provider} 版本不兼容：${version}。需要主版本 ${this.spec.major}，请在设置中选择正确的程序绝对路径。`);
    aborted(signal);
    await writeFile(join(request.cwd, 'schema.json'), JSON.stringify(OUTPUT_SCHEMA), { mode: 0o600 });
    await this.spec.prepare?.(request.cwd);
    return new Promise((resolve, reject) => {
      let finalAnswer: unknown, text = '', stderr = '', fatal = '', total = 0, timedOut = false;
      const child = spawn(this.executable, this.spec.args(request), {
        cwd: request.cwd, env: { ...harnessEnvironment(), PWD: request.cwd }, shell: false,
        detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
      const stop = () => terminate(child);
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs);
      createInterface({ input: child.stdout! }).on('line', line => {
        total += line.length;
        if (total > 32_000_000) { fatal = 'Harness 输出超过限制'; stop(); return; }
        let value: unknown;
        try { value = JSON.parse(line); } catch { return; /* Non-JSON startup output is not a knowledge artifact. */ }
        if (!value || typeof value !== 'object') return;
        const decoded = this.spec.decode(value as JsonEvent);
        if (decoded.event) onEvent(decoded.event);
        if (decoded.answer) finalAnswer = decoded.answer;
        if (decoded.text) text = decoded.text;
        if (decoded.fatal) fatal = redact(decoded.fatal);
      });
      child.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-20_000); });
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
      child.once('error', error => { cleanup(); reject(new Error(`无法启动 ${this.provider}，请检查程序路径：${error.message}`)); });
      child.once('close', code => {
        cleanup();
        if (signal.aborted) { reject(cancellation()); return; }
        if (timedOut) { reject(new Error('Harness 处理超时，可在设置中调整时限后重试')); return; }
        if (fatal || code !== 0) { reject(new Error(redact(fatal || stderr || `${this.provider} 异常退出 (${code})`))); return; }
        try {
          const result = finalAnswer ? validateResult(finalAnswer) : parseAnswer(text);
          onEvent({ kind: 'complete', text: '已收到结构化知识结果' });
          resolve(result);
        } catch (e) { reject(e); }
      });
      child.stdin!.on('error', () => { /* Exit diagnostics come from close/stderr. */ });
      child.stdin!.end(this.spec.stdin(request));
    });
  }
}
