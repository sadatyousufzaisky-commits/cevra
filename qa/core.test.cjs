const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { temporaryFolder } = require('./temp.cjs');
const { createWorkspace, listFolder, readSource, saveSource, saveRecoveryCopy } = require('../src/workspace.cjs');
const { startNodeRun, startNodeTests } = require('../src/runner.cjs');
const { createDraftStore } = require('../src/drafts.cjs');
const { writeAtomic } = require('../src/atomic-file.cjs');
const { searchProject } = require('../src/project-search.cjs');
const { createSyntaxService } = require('../src/syntax-service.cjs');
const { createFormatService } = require('../src/format-service.cjs');
const { createSemanticService } = require('../src/semantic-service.cjs');

async function fixture(t) {
  const folder = await temporaryFolder(t, 'cevra-core-');
  const root = path.join(folder, 'project (QA) # % & café');
  await fs.mkdir(root);
  return { folder, root, workspace: await createWorkspace(root) };
}

test('workspace operations reject traversal, absolute paths, alternate streams, and hidden directories', async t => {
  const { folder, root, workspace } = await fixture(t);
  const outside = path.join(folder, 'outside.cjs');
  await fs.writeFile(outside, 'outside');
  await fs.writeFile(path.join(root, 'entry.cjs'), 'inside');
  const { revision } = await readSource(workspace, 'entry.cjs');

  const forbidden = ['../outside.cjs', outside, 'entry.cjs:alternate', '.git/config', 'node_modules/x.cjs'];
  if (process.platform === 'win32') forbidden.push('CON.cjs', 'NUL .cjs', 'entry.cjs.', 'entry.cjs ', '..\\outside.cjs');
  for (const relative of forbidden) {
    await assert.rejects(readSource(workspace, relative), /[Ww]orkspace path|outside the workspace/);
    await assert.rejects(saveSource(workspace, relative, 'modified', revision), /[Ww]orkspace path|outside the workspace/);
    await assert.rejects(listFolder(workspace, relative), /[Ww]orkspace path|outside the workspace/);
  }
  await assert.rejects(startNodeRun(workspace, '../outside.cjs', revision, () => {}), /outside the workspace/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  assert.equal(await fs.readFile(path.join(root, 'entry.cjs'), 'utf8'), 'inside');
});

test('workspace operations reject junctions, links, and replacement of the opened root', async t => {
  const { folder, root, workspace } = await fixture(t);
  const outside = path.join(folder, 'sibling');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'outside.cjs'), 'outside');
  await fs.writeFile(path.join(root, 'inside.cjs'), 'inside');
  const { revision } = await readSource(workspace, 'inside.cjs');
  await fs.symlink(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(path.join(outside, 'outside.cjs'), path.join(root, 'hard-link.cjs'));
  await assert.rejects(listFolder(workspace, 'outside-link'), /links cannot be opened/);
  for (const relative of [path.join('outside-link', 'outside.cjs'), 'hard-link.cjs']) {
    await assert.rejects(readSource(workspace, relative), /links cannot be opened/);
    await assert.rejects(saveSource(workspace, relative, 'modified', revision), /links cannot be opened/);
    await assert.rejects(startNodeRun(workspace, relative, revision, () => {}), /links cannot be opened/);
  }
  assert.equal(await fs.readFile(path.join(outside, 'outside.cjs'), 'utf8'), 'outside');

  await fs.rename(root, path.join(folder, 'original'));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'inside.cjs'), 'inside');
  await assert.rejects(readSource(workspace, 'inside.cjs'), /workspace folder changed/);
  await assert.rejects(saveSource(workspace, 'inside.cjs', 'modified', revision), /workspace folder changed/);
  await assert.rejects(startNodeTests(workspace, path.join(folder, 'test-state.json'), () => {}), /workspace folder changed/);
  assert.equal(await fs.readFile(path.join(root, 'inside.cjs'), 'utf8'), 'inside');
});

test('saves atomically, serializes competing revisions, and preserves existing recovery copies', async t => {
  const { root, workspace } = await fixture(t);
  const file = path.join(root, 'draft.txt');
  await fs.writeFile(file, 'original');
  const { revision } = await readSource(workspace, 'draft.txt');
  const results = await Promise.allSettled([
    saveSource(workspace, 'draft.txt', 'first edit', revision),
    saveSource(workspace, 'draft.txt', 'second edit', revision),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /changed on disk/);
  assert.equal(await fs.readFile(file, 'utf8'), 'first edit');
  const first = await saveRecoveryCopy(workspace, 'draft.txt', 'recovered one');
  const second = await saveRecoveryCopy(workspace, 'draft.txt', 'recovered two');
  assert.notEqual(first, second);
  assert.equal(await fs.readFile(path.join(root, first), 'utf8'), 'recovered one');
  assert.equal(await fs.readFile(path.join(root, second), 'utf8'), 'recovered two');
  assert.equal(await fs.readFile(file, 'utf8'), 'first edit');
  assert.deepEqual((await fs.readdir(root)).sort(), [first, second, 'draft.txt'].sort());
});

test('an interrupted atomic write leaves the previous file intact and cleans up its temporary file', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'original.txt');
  await fs.writeFile(file, 'previous contents');
  await assert.rejects(writeAtomic(file, 'candidate contents', {
    beforeCommit() { throw new Error('simulated failed commit'); },
  }), /simulated failed commit/);
  assert.equal(await fs.readFile(file, 'utf8'), 'previous contents');
  assert.deepEqual(await fs.readdir(root), ['original.txt']);
});

test('rejects directories, invalid UTF-8, binary text, and oversized files without changing disk', async t => {
  const { root, workspace } = await fixture(t);
  await fs.mkdir(path.join(root, 'directory.cjs'));
  await fs.writeFile(path.join(root, 'encoding.txt'), Buffer.from([0xff]));
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0]));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  await fs.writeFile(path.join(root, 'normal.txt'), 'original');
  await assert.rejects(readSource(workspace, 'directory.cjs'), /regular file/);
  await assert.rejects(readSource(workspace, 'encoding.txt'), /UTF-8/);
  await assert.rejects(readSource(workspace, 'binary.txt'), /UTF-8/);
  await assert.rejects(readSource(workspace, 'large.txt'), /2 MB/);
  const { revision } = await readSource(workspace, 'normal.txt');
  await assert.rejects(saveSource(workspace, 'normal.txt', '\0', revision), /UTF-8/);
  await assert.rejects(saveSource(workspace, 'normal.txt', 'a'.repeat(2 * 1024 * 1024 + 1), revision), /2 MB/);
  assert.equal(await fs.readFile(path.join(root, 'normal.txt'), 'utf8'), 'original');
});

async function run(t, workspace, name) {
  const { revision } = await readSource(workspace, name);
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const output = [];
  const controller = await startNodeRun(workspace, name, revision, event => {
    if (event.type === 'output') output.push(event.text);
    if (event.type === 'exit') finish(event);
  });
  t.after(() => controller.stop());
  const exit = await completed;
  return { exit, output: output.join('') };
}

test('JavaScript runner delivers both streams, preserves exit status, and rejects stale source', { timeout: 10_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const name = 'run (# % &).cjs';
  const script = path.join(root, name);
  await fs.writeFile(script, 'console.log("stdout café"); console.error("stderr ✓"); process.exitCode = 37;\n');
  const { exit, output } = await run(t, workspace, name);
  assert.equal(exit.code, 37);
  assert.equal(exit.location, null);
  assert.match(output, /stdout café/);
  assert.match(output, /stderr ✓/);

  const { revision } = await readSource(workspace, name);
  await fs.writeFile(script, 'throw new Error("external code must not run");');
  await assert.rejects(startNodeRun(workspace, name, revision, () => assert.fail('stale source ran')), /changed on disk/);
});

test('JavaScript runner keeps syntax and cross-file runtime diagnostics after large stderr output', { timeout: 10_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const directory = 'nested (source) # %';
  const target = path.join(directory, 'error (detail).cjs');
  await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, target), 'module.exports = function fail() {\n  throw new Error("cross-file");\n};\n');
  await fs.writeFile(path.join(root, 'run.cjs'), [
    'process.stderr.write("x".repeat(220000) + "\\n");',
    'require(' + JSON.stringify('./' + target.split(path.sep).join('/')) + ')();',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'syntax.mjs'), 'const invalid = ;\n');
  const runtime = await run(t, workspace, 'run.cjs');
  assert.equal(runtime.exit.code, 1);
  assert.deepEqual(runtime.exit.location, { path: target, line: 2, column: 9 });
  assert.equal(runtime.exit.summary, 'Error: cross-file');
  const syntax = await run(t, workspace, 'syntax.mjs');
  assert.equal(syntax.exit.code, 1);
  assert.deepEqual(syntax.exit.location, { path: 'syntax.mjs', line: 1, column: 17 });
  assert.match(syntax.exit.summary, /SyntaxError/);
});

test('draft writes retain the last acknowledged edit and isolate damaged records', async t => {
  const { folder, root } = await fixture(t);
  const directory = path.join(folder, 'drafts');
  const store = createDraftStore(directory);
  const revision = 'a'.repeat(64);
  await Promise.all([
    store.set(root, 'one.txt', 'earlier', revision),
    store.set(root, 'one.txt', 'latest', revision),
    store.set(root, 'two.txt', 'independent', revision),
  ]);
  await fs.writeFile(path.join(directory, 'b'.repeat(64) + '.json'), '{incomplete');
  const reopened = createDraftStore(directory);
  const { entries, unreadable } = await reopened.list();
  assert.equal(unreadable, true);
  assert.deepEqual(Object.fromEntries(entries.map(draft => [draft.path, draft.text])), {
    'one.txt': 'latest',
    'two.txt': 'independent',
  });
  await reopened.set(root, 'one.txt', null);
  assert.deepEqual((await reopened.list()).entries.map(draft => draft.path), ['two.txt']);
});

test('project search reads safe text and uses unsaved versions in place of disk copies', async t => {
  const { folder, root, workspace } = await fixture(t);
  const nested = 'nested (# % &)';
  const outside = path.join(folder, 'outside');
  for (const directory of [nested, 'node_modules', '.cache']) await fs.mkdir(path.join(root, directory));
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, nested, 'café.txt'), '\uFEFFskip\r\n  café [x+y]\r\n');
  await fs.writeFile(path.join(root, 'open.txt'), 'old [x+y]\n');
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.concat([Buffer.from('[x+y]'), Buffer.from([0])]));
  await fs.writeFile(path.join(root, 'node_modules', 'hidden.txt'), '[x+y]');
  await fs.writeFile(path.join(root, '.cache', 'hidden.txt'), '[x+y]');
  await fs.writeFile(path.join(outside, 'secret.txt'), '[x+y]');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const { files, count, skipped } = await searchProject(workspace, '[x+y]', false, [
    { path: 'open.txt', documentId: 5, version: 8, text: 'updated [X+Y]\n' },
  ], new AbortController().signal);
  assert.equal(count, 2);
  assert.equal(skipped, 1);
  assert.deepEqual(files[0], {
    path: 'open.txt', documentId: 5, version: 8,
    matches: [{ line: 1, column: 9, length: 5, preview: 'updated [X+Y]' }],
  });
  assert.equal(files[1].path, path.join(nested, 'café.txt'));
  assert.match(files[1].revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(files[1].matches, [{ line: 2, column: 8, length: 5, preview: '  café [x+y]' }]);
  assert.equal((await searchProject(workspace, '[X+Y]', true, [], new AbortController().signal)).count, 0);
});

test('project search caps results, handles cancellation, and rejects an unsafe draft path', async t => {
  const { root, workspace } = await fixture(t);
  await fs.writeFile(path.join(root, 'many.txt'), 'token\n'.repeat(600));
  const result = await searchProject(workspace, 'token', false, [], new AbortController().signal);
  assert.equal(result.count, 400);
  assert.equal(result.limited, true);
  assert.equal(result.files[0].matches.at(-1).line, 400);

  const search = new AbortController();
  const pending = searchProject(workspace, 'token', false, [], search.signal);
  setImmediate(() => search.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(searchProject(workspace, 'token', false, [
    { path: '../outside.txt', documentId: 1, version: 0, text: 'token' },
  ], new AbortController().signal), /outside the workspace/);
});

test('syntax checks locate JavaScript and TypeScript errors and handle EOF and JSX', { timeout: 15_000 }, async t => {
  const syntax = createSyntaxService();
  t.after(syntax.stop);
  const js = 'const broken = ;\n';
  const [broken, typed, valid, eof, jsx] = await Promise.all([
    syntax.analyze('nested (# %)/entry.cjs', js),
    syntax.analyze('typed.js', 'const count: number = 1;\n'),
    syntax.analyze('valid.mts', 'import "./unavailable";\nconst count: number = 1;\nthrow new Error("never run");'),
    syntax.analyze('unclosed.ts', 'export function read() {\n'),
    syntax.analyze('view.tsx', 'const view = <button>Close</span>;\n'),
  ]);
  assert.deepEqual(broken.issues, [{
    from: 15, to: 16, line: 1, column: 16, severity: 'error', code: 1109, message: 'Expression expected.',
  }]);
  assert.equal(js.slice(broken.issues[0].from, broken.issues[0].to), ';');
  assert.equal(typed.issues[0].code, 8010);
  assert.deepEqual(valid.issues, []);
  assert.equal(eof.issues[0].line, 2);
  assert.equal(eof.issues[0].column, 1);
  assert.equal(eof.issues[0].from, eof.issues[0].to);
  assert.match(jsx.issues[0].message, /closing tag/);
});

test('syntax checks bound source size and displayed diagnostics', { timeout: 15_000 }, async t => {
  const syntax = createSyntaxService();
  t.after(syntax.stop);
  const many = await syntax.analyze('many.js', 'const broken = ;\n'.repeat(125));
  assert.equal(many.issues.length, 100);
  assert.equal(many.omitted, 25);
  await assert.rejects(syntax.analyze('note.txt', 'const broken = ;'), /JavaScript or TypeScript/);
  await assert.rejects(syntax.analyze('large.ts', 'a'.repeat(2 * 1024 * 1024 + 1)), /2 MB/);
});

test('syntax worker exits reject outstanding checks and a later request starts a replacement', { timeout: 15_000 }, async t => {
  const { folder } = await fixture(t);
  const worker = path.join(folder, 'worker.cjs');
  await fs.writeFile(worker, [
    'const { parentPort } = require("node:worker_threads");',
    'parentPort.on("message", ({ id, text }) => {',
    '  if (text === "exit") process.exit(23);',
    '  parentPort.postMessage({ id, result: { issues: [], omitted: 0 } });',
    '});',
  ].join('\n'));
  const syntax = createSyntaxService(worker);
  t.after(syntax.stop);
  const settled = await Promise.allSettled([
    syntax.analyze('first.js', 'exit'),
    syntax.analyze('second.ts', 'pending'),
  ]);
  for (const check of settled) {
    assert.equal(check.status, 'rejected');
    assert.match(check.reason.message, /analyzer stopped/);
  }
  assert.deepEqual(await syntax.analyze('second.ts', 'valid'), { issues: [], omitted: 0 });
});

function applyFormat(source, changes) {
  for (const { from, to, insert } of [...changes].reverse()) {
    source = source.slice(0, from) + insert + source.slice(to);
  }
  return source;
}

test('the CEVRA formatter edits whitespace, preserves literal content and ASI, and is idempotent', { timeout: 15_000 }, async t => {
  const { workspace } = await fixture(t);
  const formatter = createFormatService();
  t.after(formatter.stop);
  const template = 'const raw=' + String.fromCharCode(96) + 'a  ' + '$' + '{1+  2}' + String.fromCharCode(96) + ';';
  const source = [
    '#!/usr/bin/env node',
    'const text="  a  ";const pattern=/a  b/;',
    template,
    'function run(n){',
    '// preserve spacing  here',
    'return',
    '{ value:n+1 }',
    '}',
    'const property=1 .toString();',
    'const double=a+ +b;',
  ].join('\n');
  const { changes, eol } = await formatter.format(workspace, 'entry.cjs', source, '\r\n');
  for (const { from, to, insert } of changes) {
    assert.match(source.slice(from, to), /^\s*$/);
    assert.match(insert, /^\s*$/);
  }
  const formatted = applyFormat(source, changes);
  assert.match(formatted, /^#!\/usr\/bin\/env node\nconst text = "  a  ";\nconst pattern = \/a  b\/;/);
  assert.ok(formatted.includes(template.replace('raw=', 'raw = ')));
  assert.match(formatted, /function run\(n\) \{\n  \/\/ preserve spacing  here\n  return\n  \{\n    value: n \+ 1\n  \}\n\}/);
  assert.match(formatted, /const property = 1 \.toString\(\);\nconst double = a \+ \+b;\n$/);
  assert.equal(eol, '\r\n');
  assert.deepEqual(await formatter.format(workspace, 'entry.cjs', formatted, eol), { changes: [], eol });

  const jsx = 'const view=<main>exact  text {a+  b}</main>;';
  assert.equal(applyFormat(jsx, (await formatter.format(workspace, 'view.tsx', jsx, '\n')).changes),
    'const view = <main>exact  text {a+  b}</main>;\n');
});

test('formatting uses the nearest scoped CEVRA settings and rejects unsafe or invalid inputs', { timeout: 15_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  const formatter = createFormatService();
  t.after(formatter.stop);
  const nested = 'nested (# % &)';
  await fs.mkdir(path.join(root, nested));
  await fs.writeFile(path.join(root, '.cevra-format.json'), '{"indentWidth":4}');
  await fs.writeFile(path.join(root, nested, '.cevra-format.json'),
    '{"indentStyle":"tabs","bracketSpacing":false,"finalNewline":false,"lineEnding":"crlf"}');
  const source = 'export function next(a:number){return {a:a+1}}';
  const outer = await formatter.format(workspace, 'plain.ts', source, '\n');
  assert.equal(applyFormat(source, outer.changes), 'export function next(a: number) {\n    return { a: a + 1 }\n}\n');
  assert.equal(outer.eol, '\n');
  const inner = await formatter.format(workspace, path.join(nested, 'next.ts'), source, '\n');
  assert.equal(applyFormat(source, inner.changes), 'export function next(a: number) {\n\treturn {a: a + 1}\n}');
  assert.equal(inner.eol, '\r\n');
  await assert.rejects(formatter.format(workspace, 'broken.js', 'const x = ;', '\n'), /Fix the syntax error first/);
  await assert.rejects(formatter.format(workspace, '../outside.js', source, '\n'), /outside the workspace/);
  await fs.writeFile(path.join(root, nested, '.cevra-format.json'), '{"indentWidth":-1}');
  await assert.rejects(formatter.format(workspace, path.join(nested, 'next.ts'), source, '\n'), /invalid formatting option/);

  const outside = path.join(folder, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, '.cevra-format.json'), '{"indentWidth":8}');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(formatter.format(workspace, 'linked/source.ts', source, '\n'), /Workspace links cannot be opened/);
});

test('semantic queries follow project aliases and prefer unsaved versions across files', { timeout: 20_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const folder = 'lib (# % &)';
  const helper = path.join(folder, 'price.ts');
  const importer = 'main.ts';
  await fs.mkdir(path.join(root, folder));
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { paths: { '@lib/*': ['./' + folder + '/*'] } },
  }));
  const saved = '/** From disk. */\nexport function price(amount: number): string { return String(amount); }\n';
  await fs.writeFile(path.join(root, helper), saved);
  const text = 'import { price } from "@lib/price";\nconst result = price(12);\n';
  const main = { path: importer, documentId: 1, version: 0, text };
  const position = text.lastIndexOf('price(') + 2;
  const disk = await semantics.quickInfo(workspace, importer, position, [main]);
  assert.match(disk.signature, /price\(amount: number\): string/);
  assert.match(disk.documentation, /From disk/);
  assert.equal(text.slice(disk.from, disk.to), 'price');
  const draft = {
    path: helper, documentId: 2, version: 1,
    text: '/** From the unsaved editor. */\nexport function price(amount: bigint, currency: string): string { return currency + amount; }\n',
  };
  const updated = await semantics.quickInfo(workspace, importer, position, [main, draft]);
  assert.match(updated.signature, /price\(amount: bigint, currency: string\): string/);
  assert.match(updated.documentation, /From the unsaved editor/);
  assert.equal(await fs.readFile(path.join(root, helper), 'utf8'), saved);

  await fs.writeFile(path.join(root, helper), 'export function price(amount: boolean): boolean { return amount; }\n');
  const refreshed = await semantics.quickInfo(workspace, importer, position, [main]);
  assert.match(refreshed.signature, /price\(amount: boolean\): boolean/);

  await fs.unlink(path.join(root, helper));
  await fs.rmdir(path.join(root, folder));
  const recovered = await semantics.quickInfo(workspace, importer, position, [main, draft]);
  assert.match(recovered.signature, /price\(amount: bigint, currency: string\): string/);
});

test('semantic queries check JavaScript and confine module reads to permitted workspace files', { timeout: 20_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const outside = path.join(folder, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.js'), 'export function reveal() { return "outside private"; }\n');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'hidden.js'), 'export function reveal() { return "dependency private"; }\n');
  await fs.writeFile(path.join(root, 'greet.js'),
    '/** @param {string} name */\nexport function greet(name) { return "Hello " + name; }\n');
  const valid = 'import { greet } from "./greet.js";\ngreet("World");\n';
  const source = { path: 'index.js', documentId: 1, version: 0, text: valid };
  const info = await semantics.quickInfo(workspace, source.path, valid.lastIndexOf('greet('), [source]);
  assert.match(info.signature, /greet\(name: string\): string/);
  for (const [index, module] of ['../outside/secret.js', './linked/secret.js', './node_modules/hidden.js'].entries()) {
    const text = 'import { reveal } from ' + JSON.stringify(module) + ';\nreveal();\n';
    const inaccessible = await semantics.quickInfo(workspace, source.path, text.lastIndexOf('reveal('),
      [{ ...source, version: index + 1, text }]);
    assert.equal(inaccessible, null);
  }
  await assert.rejects(semantics.quickInfo(workspace, source.path, 0, [
    source, { path: '../outside/secret.js', documentId: 2, version: 0, text: valid },
  ]), /outside the workspace/);
  const config = path.join(root, 'jsconfig.json');
  await fs.writeFile(config, '{"compilerOptions":');
  await assert.rejects(semantics.quickInfo(workspace, source.path, valid.lastIndexOf('greet('), [source]),
    /Check the JSON in jsconfig\.json/);
  await fs.writeFile(config, '{}');
  const restored = await semantics.quickInfo(workspace, source.path, valid.lastIndexOf('greet('), [source]);
  assert.match(restored.signature, /greet\(name: string\): string/);

  await fs.writeFile(path.join(root, 'greet.cjs'),
    '/** @param {string} name */\nfunction greet(name) { return "Hello " + name; }\nmodule.exports = { greet };\n');
  const commonJS = 'const { greet } = require("./greet.cjs");\nconst names = ["world"];\nnames.map(greet);\ngreet("world");\n';
  const script = { path: 'index.cjs', documentId: 2, version: 0, text: commonJS };
  const call = await semantics.quickInfo(workspace, script.path, commonJS.lastIndexOf('greet('), [script]);
  assert.match(call.signature, /greet\(name: string\): string/);
  const arrayMethod = await semantics.quickInfo(workspace, script.path, commonJS.indexOf('map('), [script]);
  assert.match(arrayMethod.signature, /Array<string>\.map/);
});

test('completions use unsaved imports and preserve exact TypeScript replacement ranges', { timeout: 20_000 }, async t => {
  const { root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  const saved = 'export const data = { diskOnly: 1 };\n';
  await fs.writeFile(path.join(root, 'data.ts'), saved);
  const draft = {
    path: 'data.ts', documentId: 2, version: 1,
    text: 'export const data = { calculate() {}, "dash-name": 1 };\nexport function makeMode() {}\n',
  };
  let version = 0;
  async function suggest(marked, overlays = []) {
    const position = marked.lastIndexOf('|');
    const text = marked.slice(0, position) + marked.slice(position + 1);
    return semantics.complete(workspace, 'main.ts', position, [
      { path: 'main.ts', documentId: 1, version: version++, text }, ...overlays,
    ]);
  }
  const imports = 'import { data } from "./data";\n';
  const before = await suggest(imports + 'data.|');
  assert.deepEqual(before.options.map(item => item.label), ['diskOnly']);
  const after = await suggest(imports + 'data.|', [draft]);
  assert.deepEqual(after.options.map(({ label, kind }) => [label, kind]), [
    ['calculate', 'method'], ['dash-name', 'property'],
  ]);

  const existing = imports + 'data.calOld;';
  const middle = await suggest(imports + 'data.cal|Old;', [draft]);
  const [method] = middle.options;
  assert.equal(middle.options.length, 1);
  assert.equal(existing.slice(method.from, method.to), 'calOld');
  assert.equal(method.insert, 'calculate');

  const optional = imports + 'data?.da;';
  const bracket = await suggest(imports + 'data?.da|;', [draft]);
  const [property] = bracket.options;
  assert.equal(optional.slice(property.from, property.to), '?.da');
  assert.equal(property.insert, '?.["dash-name"]');

  const named = await suggest('import { make| } from "./data";', [draft]);
  assert.deepEqual(named.options.map(item => item.label), ['makeMode']);
  const argument = await suggest('function set(level: "basic" | "advanced") {}\nset("ba|");');
  assert.deepEqual(argument?.options.map(item => item.label), ['basic']);
  assert.equal(await fs.readFile(path.join(root, 'data.ts'), 'utf8'), saved);
});

test('completion results are bounded, ranked before truncation, and confined to the workspace', { timeout: 20_000 }, async t => {
  const { folder, root, workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  await fs.writeFile(path.join(folder, 'outside.js'), 'export const value = { privateData: 1 };\n');
  await fs.writeFile(path.join(root, 'unimported.ts'), 'export const workspaceAutoImport = 1;\n');
  const keys = Array.from({ length: 100 }, (_, index) => 'alpha' + index + ': 0');
  const text = 'const value = { ' + keys.join(', ') + ', zebra: 1 };\nvalue.';
  const source = { path: 'index.js', documentId: 1, version: 0, text };
  const limited = await semantics.complete(workspace, source.path, text.length, [source]);
  assert.equal(limited.options.length, 80);
  const narrowed = await semantics.complete(workspace, source.path, text.length + 1, [
    { ...source, version: 1, text: text + 'z' },
  ]);
  assert.deepEqual(narrowed.options.map(item => item.label), ['zebra']);
  for (const [index, input] of [
    'import { value } from "../outside.js";\nvalue.',
    'workspaceAutoIm',
    'const label = "workspaceAutoIm',
  ].entries()) {
    const result = await semantics.complete(workspace, source.path, input.length, [
      { ...source, version: index + 2, text: input },
    ]);
    assert.equal(result?.options.length ?? 0, 0);
  }
});

test('completion bursts keep the newest queued request and cancel queued work on shutdown', { timeout: 20_000 }, async t => {
  const { workspace } = await fixture(t);
  const semantics = createSemanticService();
  t.after(semantics.stop);
  function suggest(label, version) {
    const text = `const value = { ${label}: 1 };\nvalue.`;
    return semantics.complete(workspace, 'main.ts', text.length, [
      { path: 'main.ts', documentId: 1, version, text },
    ]);
  }

  const [first, replaced, latest] = await Promise.all([suggest('first', 0), suggest('replaced', 1), suggest('latest', 2)]);
  assert.deepEqual(first.options.map(item => item.label), ['first']);
  assert.equal(replaced, null);
  assert.deepEqual(latest.options.map(item => item.label), ['latest']);

  const canceled = assert.rejects(suggest('inFlight', 3), /language request was canceled/);
  const queued = suggest('queued', 4);
  semantics.stop();
  await canceled;
  assert.equal(await queued, null);
  const restarted = await suggest('restarted', 5);
  assert.deepEqual(restarted.options.map(item => item.label), ['restarted']);
});
