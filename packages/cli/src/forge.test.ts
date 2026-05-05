import { describe, expect, test } from 'bun:test';
import { buildForgeInvocation, transformGitLabJsonOutput } from './forge';

describe('archon-forge wrapper', () => {
  test('passes GitHub invocations through unchanged', () => {
    expect(buildForgeInvocation('github', 'gh', ['pr', 'list', '--json', 'number'])).toEqual({
      command: 'gh',
      args: ['pr', 'list', '--json', 'number'],
    });
  });

  test('translates GitHub-style PR list flags to glab MR flags', () => {
    const invocation = buildForgeInvocation('gitlab', 'glab', [
      'pr',
      'list',
      '--head',
      'feature-branch',
      '--state',
      'open',
      '--json',
      'number,url,headRefName',
    ]);

    expect(invocation.command).toBe('glab');
    expect(invocation.args).toEqual([
      'mr',
      'list',
      '--source-branch',
      'feature-branch',
      '--output',
      'json',
    ]);
    expect(invocation.transformStdout).toBeDefined();
  });

  test('translates GitHub-style PR create flags to glab MR create flags', () => {
    const invocation = buildForgeInvocation('gitlab', 'glab', [
      'pr',
      'create',
      '--draft',
      '--base',
      'dev',
      '--title',
      'Fix bug',
      '--body',
      'Body text',
    ]);

    expect(invocation.args).toEqual([
      'mr',
      'create',
      '--draft',
      '--target-branch',
      'dev',
      '--title',
      'Fix bug',
      '--description',
      'Body text',
      '--yes',
    ]);
  });

  test('translates PR comment to glab MR note create', () => {
    const invocation = buildForgeInvocation('gitlab', 'glab', [
      'pr',
      'comment',
      '42',
      '--body',
      'review body',
    ]);

    expect(invocation.args).toEqual(['mr', 'note', 'create', '42', '--message', 'review body']);
  });

  test('maps glab MR JSON to gh-compatible PR JSON fields', () => {
    const output = transformGitLabJsonOutput(
      JSON.stringify([
        {
          iid: 7,
          web_url: 'https://git.example.com/group/project/-/merge_requests/7',
          source_branch: 'feature',
          target_branch: 'dev',
        },
      ]),
      { resource: 'pr', jsonFields: ['number', 'url', 'headRefName', 'baseRefName'] }
    );

    expect(JSON.parse(output)).toEqual([
      {
        number: 7,
        url: 'https://git.example.com/group/project/-/merge_requests/7',
        headRefName: 'feature',
        baseRefName: 'dev',
      },
    ]);
  });

  test('supports the jq subset used by bundled commands', () => {
    const numberOutput = transformGitLabJsonOutput(
      JSON.stringify({ iid: 12, web_url: 'https://git.example.com/mr/12' }),
      { resource: 'pr', jsonFields: ['number'], jqExpression: '.number' }
    );
    expect(numberOutput).toBe('12\n');

    const lengthOutput = transformGitLabJsonOutput(
      JSON.stringify({ discussions: [{ id: 'a' }, { id: 'b' }] }),
      { resource: 'pr', jsonFields: ['comments'], jqExpression: '.comments | length' }
    );
    expect(lengthOutput).toBe('2\n');
  });
});
