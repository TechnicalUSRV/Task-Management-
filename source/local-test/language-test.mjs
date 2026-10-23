/** Real React selector checks: drafts, persisted choice, failures and late responses. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url), dir = await mkdtemp(path.join(tmpdir(), 'task-language-'));
try {
  for (const file of ['i18n.ts', 'language-selector.tsx']) {
    let code = ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    code = code.replace(/^import (.+) from ['"](.+?)['"];?$/gm, (all, binding, spec) => {
      if (spec.endsWith('.json')) return `const ${binding} = ${JSON.stringify(require(path.resolve(import.meta.dirname, spec)))};`;
      return `import ${binding} from ${JSON.stringify(pathToFileURL(spec === './i18n' ? path.join(dir, 'i18n.mjs') : require.resolve(spec)).href)};`;
    });
    await writeFile(path.join(dir, file.replace(/\.tsx?$/, '.mjs')), code);
  }
  const dom = new JSDOM('<html><body><div id="app"></div></body></html>', { url: 'https://example.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { act, createElement: h, useState } = await import('react'), { createRoot } = await import('react-dom/client');
  const i18n = await import(pathToFileURL(path.join(dir, 'i18n.mjs')));
  const { LanguageSelector } = await import(pathToFileURL(path.join(dir, 'language-selector.mjs')));
  let accept, reject;
  const save = () => new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  function Form() { i18n.useLanguage(); const [draft, setDraft] = useState('Employee Save កិច្ចការ 中文'); return h('form', null, h('textarea', { value: draft, onChange: e => setDraft(e.target.value) }), h(LanguageSelector, { save })); }
  const root = createRoot(document.getElementById('app'));
  await act(async () => root.render(h(Form)));
  const input = document.querySelector('textarea'), select = document.querySelector('select');
  assert.deepEqual([...select.options].map(o => [o.value, o.text]), [['en', 'English'], ['km', 'ភាសាខ្មែរ'], ['zh-CN', '简体中文']]);
  const map = i18n.translatedMap({ SAVE: 'Save' }), entries = i18n.translatedEntries({ SAVE: 'Save' }), tuples = i18n.translatedTuples([['save', 'Save', 'action']]);
  for (const locale of ['km', 'zh-CN', 'en']) {
    const previous = i18n.getLanguage();
    await act(async () => { select.value = locale; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    assert.equal(i18n.getLanguage(), previous); assert.equal(select.disabled, true);
    await act(async () => accept({ ok: true }));
    assert.equal(document.documentElement.lang, locale); assert.equal(select.disabled, false);
    assert.equal(document.querySelector('textarea'), input); assert.equal(input.value, 'Employee Save កិច្ចការ 中文');
    assert.equal(map.SAVE, i18n.uiText('Save')); assert.deepEqual(Object.keys(map), ['SAVE']);
    assert.deepEqual([...entries[0]], ['SAVE', i18n.uiText('Save')]);
    assert.deepEqual([...tuples[0]], ['save', i18n.uiText('Save'), 'action']);
    assert.equal(i18n.uiText('Never translated {name}', { name: '<tag> Save 中文' }), 'Never translated <tag> Save 中文');
  }
  await act(async () => { select.value = 'km'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await act(async () => reject(new Error('Could not save')));
  assert.equal(i18n.getLanguage(), 'en'); assert.equal(select.value, 'en'); assert.equal(document.querySelector('[role=alert]').textContent, 'Could not save');
  const old = i18n.getLanguageRevision();
  await act(async () => i18n.setLanguage('zh-CN'));
  await act(async () => i18n.receiveLanguage(new Response('', { headers: { 'X-Account-Language': 'km' } }), old));
  assert.equal(i18n.getLanguage(), 'zh-CN');
  await act(async () => i18n.receiveLanguage(new Response('', { headers: { 'X-Account-Language': 'km' } }), i18n.getLanguageRevision()));
  assert.equal(i18n.getLanguage(), 'km');
  await act(async () => i18n.setLanguage('not-supported')); assert.equal(i18n.getLanguage(), 'en');
  await act(async () => root.unmount()); dom.window.close();
  console.log('PASS: saved language, failed save, draft preservation, stale response, fallback, opaque content and dynamic labels.');
} finally { await rm(dir, { recursive: true, force: true }); }
