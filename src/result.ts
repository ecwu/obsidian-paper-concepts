import type { GenerationResult } from './types';

/** The harness answer contract. `OUTPUT_SCHEMA` is sent to the model; `validateResult` enforces it on the answer. */
export const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['paper', 'concepts'],
  properties: {
    paper: { type: 'object', additionalProperties: false, required: ['title', 'authors', 'year', 'doi', 'arxiv', 'tags', 'body'], properties: {
      title: { type: 'string' }, authors: { type: 'array', items: { type: 'string' } },
      year: { type: ['integer', 'null'] }, doi: { type: ['string', 'null'] }, arxiv: { type: ['string', 'null'] },
      tags: { type: 'array', items: { type: 'string' } }, body: { type: 'string' }
    } },
    concepts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['existingId', 'title', 'aliases', 'tags', 'body'], properties: {
      existingId: { type: ['string', 'null'] }, title: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, body: { type: 'string' }
    } } }
  }
} as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Harness 结果必须是 JSON 对象');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000_000) throw new Error(`生成结果缺少有效 ${name}`);
  return value;
}
function list(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== 'string')) throw new Error(`生成结果 ${name} 必须是文字数组`);
  return value as string[];
}
const nullable = (value: unknown, name: string): string | null => value === null ? null : text(value, name);
function body(value: unknown): string {
  const markdown = text(value, 'body');
  if (/^\s*---\s*\n/.test(markdown)) throw new Error('正文不能包含 YAML 区块');
  return markdown;
}
function year(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 3000) throw new Error('论文年份无效');
  return value;
}

export function validateResult(input: unknown): GenerationResult {
  const result = object(input), paper = object(result.paper);
  if (!Array.isArray(result.concepts) || result.concepts.length > 100) throw new Error('Concept 列表无效');
  return {
    paper: {
      title: text(paper.title, 'title'), authors: list(paper.authors, 'authors'), year: year(paper.year),
      doi: nullable(paper.doi, 'doi'), arxiv: nullable(paper.arxiv, 'arxiv'), tags: list(paper.tags, 'tags'), body: body(paper.body)
    },
    concepts: result.concepts.map(item => {
      const concept = object(item);
      return {
        existingId: nullable(concept.existingId, 'existingId'), title: text(concept.title, 'title'),
        aliases: list(concept.aliases, 'aliases'), tags: list(concept.tags, 'tags'), body: body(concept.body)
      };
    })
  };
}
