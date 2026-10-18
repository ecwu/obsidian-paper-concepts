import { describe, expect, it } from 'vitest';
import { HARNESSES } from '../src/harness';
import { activityDescriber, describePlan, onceEach, shellActivity } from '../src/activity';
import { hash } from '../src/util';
import type { ContextSnapshot, HarnessEvent } from '../src/types';

const context: ContextSnapshot = { digest: '', notes: [{ id: 'c1', path: 'R/200-Concepts/Attention.md', title: 'Attention', aliases: [], type: 'concept', content: '', hash: '', properties: {} }] };
const note = `knowledge/${hash('c1')}.md`;
const describeAll = (events: HarnessEvent[]) => events.map(e => e.kind === 'tool' ? activityDescriber(context)(e.activity) : e.text);

describe('harness tool activity (shapes captured from real CLI runs)', () => {
  it('reports a Codex command once, at its start, with its real target', () => {
    const item = { id: 'item_1', type: 'command_execution', command: `/bin/zsh -lc 'cat ${note}'` };
    expect(describeAll(HARNESSES.codex.decode({ type: 'item.started', item }).events ?? [])).toEqual(['参考已有概念：Attention']);
    expect(HARNESSES.codex.decode({ type: 'item.completed', item }).events).toBeUndefined();
  });
  it('interprets common read-only shell commands', () => {
    expect(shellActivity(`/bin/zsh -lc "rg -n -w 'attention' source.md"`)).toEqual({ action: 'search', target: 'source.md', detail: 'attention' });
    expect(shellActivity(`/bin/zsh -lc "sed -n '1,200p' source.md"`)).toEqual({ action: 'read', target: 'source.md', detail: '1–200' });
    expect(shellActivity(`/bin/zsh -lc "rg --files -g '*.md' knowledge"`)).toMatchObject({ action: 'list' });
    expect(shellActivity(`/bin/zsh -lc 'pwd'`)).toBeUndefined();
  });
  it('reads Claude Code tool_use blocks with absolute paths', () => {
    const events = HARNESSES.claude.decode({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Read', input: { file_path: '/private/tmp/work/source.md', offset: 201, limit: 200 } },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'attention', path: '/private/tmp/work/knowledge' } },
      { type: 'tool_use', name: 'StructuredOutput', input: {} }
    ] } }).events ?? [];
    expect(describeAll(events)).toEqual(['阅读论文正文（第 201–400 行）', '在已有知识中检索“attention”']);
  });
  it('reads OpenCode tool parts', () => {
    const events = HARNESSES.opencode.decode({ type: 'tool_use', part: { type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'catalog.json' } } } }).events ?? [];
    expect(describeAll(events)).toEqual(['查看知识目录（1 个已有页面）']);
  });
});

describe('log lines', () => {
  it('logs each distinct line once per run', () => {
    const lines: string[] = [], report = onceEach(text => lines.push(text));
    for (const text of ['阅读论文正文', '阅读论文正文', undefined, '参考已有概念：Attention']) report(text);
    expect(lines).toEqual(['阅读论文正文', '参考已有概念：Attention']);
  });
  it('summarizes planned writes', () => {
    expect(describePlan({ version: 1, jobId: 'j', root: 'R', paperPath: 'R/100-Papers/Study.md', complete: false, changes: [
      { path: 'R/200-Concepts/Attention.md', before: 'old', after: 'new', done: false },
      { path: 'R/200-Concepts/Transformer.md', before: null, after: 'new', done: false },
      { path: 'R/100-Papers/Study.md', before: null, after: 'new', done: false }
    ] })).toBe('新建论文《Study》；新建概念：Transformer；更新概念：Attention');
  });
});
