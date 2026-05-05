#!/usr/bin/env bun
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { findRepoRoot, getRemoteUrl, resolveForgeContext } from '@archon/git';
import type { ForgeType } from '@archon/git';

interface ForgeInvocation {
  command: string;
  args: string[];
  transformStdout?: (stdout: string) => string;
}

interface OutputTransform {
  resource: 'pr' | 'issue';
  jsonFields?: string[];
  jqExpression?: string;
}

function printForgeUsage(): void {
  console.error('Usage: archon-forge <args...>');
  console.error('Example: archon-forge issue view 123');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printForgeUsage();
    return 1;
  }

  let remoteUrl: string | null = null;
  const cwd = process.cwd();

  const repoRoot = await findRepoRoot(cwd);
  if (repoRoot) {
    remoteUrl = await getRemoteUrl(repoRoot);
  }

  const forge = resolveForgeContext({ remoteUrl, env: process.env });
  const cli = process.env.FORGE_CLI?.trim() || forge.cli;

  if (!cli) {
    const detected = forge.type === 'unknown' ? 'unknown forge' : forge.type;
    console.error(`Unable to determine forge CLI for ${detected}.`);
    console.error(
      'Set FORGE_CLI to gh or glab, or run from a repository with a known origin remote.'
    );
    return 1;
  }

  const invocation = buildForgeInvocation(forge.type, cli, args);
  return await runInvocation(invocation);
}

export function buildForgeInvocation(
  forgeType: ForgeType,
  cli: string,
  args: string[]
): ForgeInvocation {
  if (forgeType !== 'gitlab' || !isGlabCli(cli)) {
    return { command: cli, args };
  }

  const translated = translateGitLabArgs(args);
  const outputTransform = translated.output;
  return {
    command: cli,
    args: translated.args,
    transformStdout: outputTransform
      ? (stdout: string): string => transformGitLabJsonOutput(stdout, outputTransform)
      : undefined,
  };
}

function isGlabCli(cli: string): boolean {
  return cli.split(/[\\/]/).pop() === 'glab';
}

function translateGitLabArgs(args: string[]): { args: string[]; output?: OutputTransform } {
  const [resource, subcommand, ...rest] = args;

  if (resource === 'pr') {
    if (subcommand === 'comment') {
      return { args: ['mr', 'note', 'create', ...translateGitHubFlagAliases(rest, 'comment')] };
    }

    const output = consumeOutputFlags(rest);
    const aliasArgs = translateGitHubFlagAliases(output.args, subcommand);
    return {
      args: ['mr', subcommand ?? 'view', ...withGitLabCreateConfirmation(subcommand, aliasArgs)],
      output: output.transform ? { resource: 'pr', ...output.transform } : undefined,
    };
  }

  if (resource === 'issue') {
    const output = consumeOutputFlags(rest);
    return {
      args: ['issue', subcommand ?? 'view', ...translateGitHubFlagAliases(output.args, subcommand)],
      output: output.transform ? { resource: 'issue', ...output.transform } : undefined,
    };
  }

  return { args };
}

function consumeOutputFlags(args: string[]): {
  args: string[];
  transform?: Omit<OutputTransform, 'resource'>;
} {
  const translated: string[] = [];
  let jsonFields: string[] | undefined;
  let jqExpression: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';

    if (arg === '--json') {
      jsonFields = splitJsonFields(args[index + 1]);
      index++;
      continue;
    }
    if (arg.startsWith('--json=')) {
      jsonFields = splitJsonFields(arg.slice('--json='.length));
      continue;
    }
    if (arg === '--jq' || arg === '-q') {
      jqExpression = args[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith('--jq=')) {
      jqExpression = arg.slice('--jq='.length);
      continue;
    }

    translated.push(arg);
  }

  if (!jsonFields && !jqExpression) {
    return { args: translated };
  }

  translated.push('--output', 'json');
  return { args: translated, transform: { jsonFields, jqExpression } };
}

function splitJsonFields(value: string | undefined): string[] | undefined {
  const fields = value
    ?.split(',')
    .map(field => field.trim())
    .filter(Boolean);
  return fields && fields.length > 0 ? fields : undefined;
}

function translateGitHubFlagAliases(args: string[], subcommand: string | undefined): string[] {
  const translated: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';

    if (arg === '--head') {
      translated.push('--source-branch', args[index + 1] ?? '');
      index++;
      continue;
    }
    if (arg.startsWith('--head=')) {
      translated.push(`--source-branch=${arg.slice('--head='.length)}`);
      continue;
    }
    if (arg === '--base') {
      translated.push('--target-branch', args[index + 1] ?? '');
      index++;
      continue;
    }
    if (arg.startsWith('--base=')) {
      translated.push(`--target-branch=${arg.slice('--base='.length)}`);
      continue;
    }
    if (arg === '--limit') {
      translated.push('--per-page', args[index + 1] ?? '');
      index++;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      translated.push(`--per-page=${arg.slice('--limit='.length)}`);
      continue;
    }
    if (arg === '--state') {
      appendGitLabStateFlag(translated, args[index + 1]);
      index++;
      continue;
    }
    if (arg.startsWith('--state=')) {
      appendGitLabStateFlag(translated, arg.slice('--state='.length));
      continue;
    }
    if (arg === '--body' && (subcommand === 'create' || subcommand === 'comment')) {
      translated.push(
        subcommand === 'comment' ? '--message' : '--description',
        args[index + 1] ?? ''
      );
      index++;
      continue;
    }
    if (arg.startsWith('--body=') && (subcommand === 'create' || subcommand === 'comment')) {
      translated.push(
        subcommand === 'comment' ? '--message' : '--description',
        arg.slice('--body='.length)
      );
      continue;
    }
    if (arg === '--body-file' && (subcommand === 'create' || subcommand === 'comment')) {
      translated.push(
        subcommand === 'comment' ? '--message' : '--description',
        readFileSync(args[index + 1] ?? '', 'utf8')
      );
      index++;
      continue;
    }
    if (arg.startsWith('--body-file=') && (subcommand === 'create' || subcommand === 'comment')) {
      translated.push(
        subcommand === 'comment' ? '--message' : '--description',
        readFileSync(arg.slice('--body-file='.length), 'utf8')
      );
      continue;
    }

    translated.push(arg);
  }

  return translated.filter(arg => arg !== '');
}

function withGitLabCreateConfirmation(subcommand: string | undefined, args: string[]): string[] {
  if (
    subcommand !== 'create' ||
    args.includes('--web') ||
    args.includes('--yes') ||
    args.includes('-y')
  ) {
    return args;
  }

  return [...args, '--yes'];
}

function appendGitLabStateFlag(args: string[], state: string | undefined): void {
  switch (state?.toLowerCase()) {
    case 'all':
      args.push('--all');
      break;
    case 'closed':
      args.push('--closed');
      break;
    case 'merged':
      args.push('--merged');
      break;
    case 'open':
    default:
      break;
  }
}

export function transformGitLabJsonOutput(stdout: string, transform: OutputTransform): string {
  if (stdout.trim() === '') return stdout;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return stdout;
  }

  const mapped = Array.isArray(parsed)
    ? parsed.map(item => mapGitLabEntity(transform.resource, item))
    : mapGitLabEntity(transform.resource, parsed);
  const selected = transform.jsonFields ? selectFields(mapped, transform.jsonFields) : mapped;

  if (transform.jqExpression) {
    return `${formatJqValue(evaluateJqSubset(selected, transform.jqExpression))}\n`;
  }

  return `${JSON.stringify(selected, null, 2)}\n`;
}

function mapGitLabEntity(resource: 'pr' | 'issue', value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};

  const mapped: Record<string, unknown> = { ...value };
  mapped.number = value.number ?? value.iid ?? value.id;
  mapped.url = value.url ?? value.web_url ?? value.webUrl;
  mapped.body = value.body ?? value.description;
  mapped.comments = value.comments ?? value.notes ?? value.discussions;

  if (resource === 'pr') {
    mapped.headRefName = value.headRefName ?? value.source_branch ?? value.sourceBranch;
    mapped.baseRefName = value.baseRefName ?? value.target_branch ?? value.targetBranch;
  }

  return mapped;
}

function selectFields(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map(item => selectFields(item, fields));
  }
  if (!isRecord(value)) return value;

  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    selected[field] = value[field];
  }
  return selected;
}

function evaluateJqSubset(value: unknown, expression: string): unknown {
  const trimmed = expression.trim();
  const commaParts = trimmed.split(',').map(part => part.trim());
  if (commaParts.length > 1) {
    return commaParts.map(part => evaluateJqSubset(value, part));
  }

  const lengthMatch = /^\.(\w+)\s*\|\s*length$/.exec(trimmed);
  if (lengthMatch) {
    const target = getField(value, lengthMatch[1]);
    return Array.isArray(target) || typeof target === 'string'
      ? target.length
      : isRecord(target)
        ? Object.keys(target).length
        : 0;
  }

  const fieldMatch = /^\.(\w+)$/.exec(trimmed);
  if (fieldMatch) {
    return getField(value, fieldMatch[1]);
  }

  return value;
}

function getField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

function formatJqValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(item => formatJqValue(item)).join('\n');
  }
  if (typeof value === 'string') return value;
  if (value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runInvocation(invocation: ForgeInvocation): Promise<number> {
  return await new Promise<number>(resolve => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: invocation.transformStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      env: process.env,
    });

    let stdout = '';
    if (invocation.transformStdout && child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
    }

    child.on('error', err => {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        console.error(`Forge CLI not found: ${invocation.command}`);
        console.error(`Install ${invocation.command} or set FORGE_CLI to an available executable.`);
      } else {
        console.error(`Failed to execute ${invocation.command}: ${error.message}`);
      }
      resolve(1);
    });

    child.on('close', code => {
      if (code === 0 && invocation.transformStdout) {
        process.stdout.write(invocation.transformStdout(stdout));
      }
      resolve(code ?? 1);
    });
  });
}

if (import.meta.main) {
  main()
    .then(code => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const err = error as Error;
      console.error(`Fatal error: ${err.message}`);
      process.exit(1);
    });
}
