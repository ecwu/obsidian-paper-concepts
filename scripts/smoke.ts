import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CliHarness } from '../src/harness';
import { DEFAULT_PROMPTS, makePrompt } from '../src/prompts';
import type { Provider } from '../src/types';

const providers = (process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude', 'opencode']) as Provider[];
const reports = await Promise.all(providers.map(async provider => {
  const cwd = await mkdtemp(join(tmpdir(), `pc-smoke-${provider}-`));
  await mkdir(join(cwd, 'knowledge'));
  await writeFile(join(cwd, 'catalog.json'), '[]');
  await writeFile(join(cwd, 'source.md'), `# A Controlled Study of Attention\nAuthors: A Researcher\nYear: 2026\n\nThis is a synthetic test paper, not a published research claim.\nResearch question: Does weighting input tokens improve this tiny controlled benchmark?\nMethod: Compare uniform token weights with learned attention weights on 10 generated examples.\nResults: Uniform weights solve 5 examples; attention solves 7 examples. No statistical significance is claimed.\nLimitations: Only 10 artificial examples; no generalization evidence.\nConcept: Attention assigns different weights to input information.\n`);
  const harness = new CliHarness(provider, provider === 'claude' ? 'claude' : provider);
  try {
    const version = await harness.detect();
    const result = await harness.run({ cwd, prompt: makePrompt(DEFAULT_PROMPTS), model: '', timeoutMs: 150_000 }, new AbortController().signal, event => console.log(`${provider}: ${event.kind}: ${event.text}`));
    await writeFile(join(cwd, 'result.json'), JSON.stringify(result, null, 2));
    return { provider, version, success: true, title: result.paper.title, concepts: result.concepts.length, directory: cwd };
  } catch (e) { return { provider, success: false, error: (e as Error).message, directory: cwd }; }
}));
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/harness-smoke.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports, null, 2));
if (reports.some(r => !r.success)) process.exitCode = 1;
