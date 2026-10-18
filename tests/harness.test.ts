import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CliHarness, HARNESSES } from '../src/harness';
import type { HarnessRequest, Provider } from '../src/types';
import { result } from './helpers';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fake(provider: Provider, mode = 'success') {
  const cwd = await mkdtemp(join(tmpdir(), 'pc-cli-test-')); dirs.push(cwd);
  const file = join(cwd, 'fake-cli.cjs');
  const output = provider === 'codex' ? { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result()) } } : provider === 'claude' ? { type: 'result', subtype: 'success', is_error: false, structured_output: result() } : { type: 'text', part: { text: JSON.stringify(result()) } };
  const script = `#!${process.execPath}\nconst fs=require('node:fs');
if(process.argv.includes('--version')){console.log('fake ${provider === 'codex' ? '0' : '2'}.0.0');process.exit(0)}
fs.writeFileSync(${JSON.stringify(join(cwd, 'argv.json'))},JSON.stringify(process.argv.slice(2)));
if(${JSON.stringify(mode)}==='wait'){setInterval(()=>{},1000)}
else if(${JSON.stringify(mode)}==='fail'){console.error('authentication failed token=secret');process.exit(1)}
else {console.log(${JSON.stringify(JSON.stringify(output))})}
process.stdin.resume();`;
  await writeFile(file, script); await chmod(file, 0o755);
  return { cwd, harness: new CliHarness(provider, file), request: { cwd, prompt: 'Read source.md, return JSON.', model: '', timeoutMs: 2000 } satisfies HarnessRequest };
}
describe('real child process adapters', () => {
  it.each(['codex', 'claude', 'opencode'] as const)('decodes %s output with its own protocol', async provider => {
    const f = await fake(provider); expect(await f.harness.detect()).toBe(`fake ${provider === 'codex' ? '0' : '2'}.0.0`);
    expect(await f.harness.run(f.request, new AbortController().signal, () => {})).toEqual(result());
    const argv = JSON.parse(await readFile(join(f.cwd, 'argv.json'), 'utf8'));
    expect(argv).not.toContain('--model'); expect(argv).not.toContain('-m');
    if (provider === 'opencode') expect(argv).toContain('--standalone');
  });
  it('passes hostile-looking model text as one argument', () => {
    const model = 'model; touch /tmp/never-run';
    const args = HARNESSES.codex.args({ cwd: '/tmp/work', model, prompt: 'x', timeoutMs: 100 });
    expect(args[args.indexOf('--model') + 1]).toBe(model);
  });
  it('reports authentication failure and redacts secrets', async () => {
    const f = await fake('codex', 'fail');
    await expect(f.harness.run(f.request, new AbortController().signal, () => {})).rejects.toThrow('token=[REDACTED]');
  });
  it('terminates a running harness when cancelled', async () => {
    const f = await fake('claude', 'wait'); const controller = new AbortController();
    const run = f.harness.run(f.request, controller.signal, () => {}); setTimeout(() => controller.abort(), 80);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('terminates timed-out jobs', async () => {
    const f = await fake('opencode', 'wait');
    await expect(f.harness.run({ ...f.request, timeoutMs: 80 }, new AbortController().signal, () => {})).rejects.toThrow('超时');
  });
  it('interprets provider errors instead of accepting exit status alone', () => {
    expect(HARNESSES.codex.decode({ type: 'turn.failed', error: { message: 'limit reached' } }).fatal).toBe('limit reached');
    expect(HARNESSES.claude.decode({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['limit reached'] }).fatal).toBe('limit reached');
    expect(HARNESSES.opencode.decode({ type: 'error', error: { data: { message: 'limit reached' } } }).fatal).toBe('limit reached');
  });
});
