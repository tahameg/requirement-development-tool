const { app } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
const root = mkdtempSync(path.join(os.tmpdir(), 'hlr-hierarchy-'));
app.setPath('userData', path.join(root, 'profile'));
let window;
const timeout = setTimeout(() => { console.error('Hierarchy smoke test timed out'); app.exit(1); }, 60000);
const execute = async script => { try { return await window.webContents.executeJavaScript(script); } catch (error) { throw new Error(`${script}\n${error.message}`); } };
async function waitFor(script) {
  for (let i = 0; i < 100; i++) { if (await execute(script)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`Timed out: ${script}`);
}
async function click(text, scope = 'main') {
  const selector = JSON.stringify(scope);
  const label = JSON.stringify(text);
  await waitFor(`Array.from(document.querySelectorAll(${selector} + ' button')).some(b => b.textContent.trim() === ${label} && !b.disabled)`);
  await execute(`Array.from(document.querySelectorAll(${selector} + ' button')).find(b => b.textContent.trim() === ${label}).click()`);
}
async function fill(selector, value) {
  await execute(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
async function select(label) {
  const selector = `li[role="treeitem"][aria-label=${JSON.stringify(label)}] > .tree-row .tree-select`;
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await execute(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await waitFor(`document.querySelector('main h1')?.textContent.includes(${JSON.stringify(label)})`);
}
const nextId = "[...document.querySelectorAll('.meta')].find(m => m.textContent.startsWith('Next ID')).querySelector('code').textContent";
async function clickDelete() { await waitFor('!!document.querySelector(".node-actions button[aria-label^=Delete]:not(:disabled)")'); await execute('document.querySelector(".node-actions button[aria-label^=Delete]").click()'); }
async function submit() {
  await execute('document.querySelector("dialog form").requestSubmit()');
  await waitFor('!document.querySelector("dialog") && document.querySelector("main").getAttribute("aria-busy") === "false"');
}
async function create(button, name, prefix, scope = 'main') {
  await click(button, scope);
  await waitFor('!!document.querySelector("dialog[open]")');
  await fill('dialog input[name=name]', name);
  await fill('dialog input[name=prefix]', prefix);
  await fill('dialog textarea', `${name} scope`);
  await submit();
  await waitFor(`document.querySelector('main h1')?.textContent.includes(${JSON.stringify(name)})`);
}
app.whenReady().then(async () => {
  const load = relative => import(pathToFileURL(path.resolve('dist', relative)));
  const { AppConfig } = await load('main/config/appConfig.js');
  const { DesktopService } = await load('main/services/desktopService.js');
  const { createDesktopWindow } = await load('main/window.js');
  const { addItem } = await load('main/services/idGenerator.js');
  const { saveWorkspace, loadWorkspace } = await load('main/services/workspaceService.js');
  const service = new DesktopService(new AppConfig(path.join(root, 'config.ini')));
  window = await createDesktopWindow(service);
  await waitFor('document.querySelector("main").getAttribute("aria-busy") === "false"');
  const labels = ['Requirements', 'Data Dictionary', 'Entity', 'Action'];
  // Without a project the roots are read-only and main offers create/open.
  for (const label of labels) { await execute(`document.querySelector('li[role="treeitem"][aria-label=${JSON.stringify(label)}] > .tree-row .tree-select').click()`); assert.equal(await execute('Array.from(document.querySelectorAll("main .launch-tile")).some(b => b.textContent.startsWith("Open project"))'), true); }
  const project = path.join(root, 'Guidance.hlr');
  await service.create(project, 'Guidance System', 'GS');
  window.reload();
  await waitFor('!!document.querySelector(".overview")');
  await select('Requirements');
  await execute(String.raw`document.querySelector('li[aria-label="Requirements"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
  await create('Component', 'Compiler', 'COMPL', '.tree-menu');
  await create('Subcomponent', 'Parser', '', '.node-actions');
  await create('Subcomponent', 'Deep', 'DEEP', '.node-actions');
  await create('Requirement set', 'Parse', 'PARSE', '.node-actions');
  assert.equal(await execute(nextId), 'REQ-GS-COMPL-DEEP-PARSE-001');
  assert.equal(await execute('!!document.querySelector(".node-badge .node-icon-requirementSet")'), true);
  assert.equal(await execute('Array.from(document.querySelectorAll("main button")).some(b => b.textContent === "Subcomponent" || b.textContent === "Requirement set")'), false);
  await click('Deep', '.breadcrumbs');
  await click('Requirement set', '.node-actions');
  await fill('dialog input[name=name]', 'Parse'); await fill('dialog input[name=prefix]', 'DUP');
  await execute('document.querySelector("dialog form").requestSubmit()');
  await waitFor('document.querySelector("dialog [role=alert]")?.textContent.includes("unique")');
  await click('Cancel', 'dialog');
  await select('Parse');
  const original = service.state().current.workspace;
  const fnId = original.domains.REQUIREMENT.requirementSets[0].requirementSetId;
  const populated = addItem(original, 'REQUIREMENT', fnId, { col_desc: 'The parser shall preserve its input.' });
  const permanentId = populated.domains.REQUIREMENT.requirementSets[0].items[0].id;
  await saveWorkspace(project, populated); await service.open(project); window.reload();
  await waitFor('!!document.querySelector(".overview")');
  await fill('input[type=search]', permanentId);
  await select('Parse');
  assert.equal(await execute(String.raw`document.querySelectorAll("li[aria-level=\"1\"]").length`), 1);
  assert.equal(await execute('document.querySelector(".virtual-table td.col-id code").textContent'), permanentId);
  await fill('input[type=search]', '');
  await click('Properties');
  await fill('dialog input[name=name]', 'Build AST'); await fill('dialog input[name=prefix]', 'AST'); await submit();
  assert.equal(await execute('document.querySelector(".virtual-table td.col-id code").textContent'), permanentId);
  await click('Compiler', '.breadcrumbs');
  await click('Properties'); await fill('dialog input[name=name]', 'Language engine'); await fill('dialog input[name=prefix]', 'LANG'); await submit();
  await select('Build AST');
  assert.equal(await execute(nextId), 'REQ-GS-LANG-DEEP-AST-002');
  assert.equal(await execute('document.querySelector(".breadcrumbs").textContent.includes("Language engine")'), true);
  // Collapse and expand the root, then exercise keyboard selection.
  await execute(String.raw`document.querySelector("button[aria-label=\"Collapse Requirements\"]").click()`);
  assert.equal(await execute(String.raw`!!document.querySelector("li[aria-label=\"Language engine\"]")`), false);
  await execute(String.raw`document.querySelector("button[aria-label=\"Expand Requirements\"]").click()`);
  await execute(String.raw`document.querySelector("li[aria-label=\"Requirements\"]").focus()`);
  window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await waitFor('document.activeElement?.getAttribute("aria-label") === "Language engine"');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor('document.querySelector("main h1")?.textContent.includes("Language engine")');
  for (const label of labels.slice(1)) { await select(label); await create('Component', `${label} module`, 'MOD', '.node-actions'); await create('Requirement set', `${label} group`, 'GROUP', '.node-actions'); }
  await select('Build AST');
  writeFileSync(path.join(os.tmpdir(), 'hlr-hierarchy-smoke.png'), (await window.webContents.capturePage()).toPNG());
  await select('Parser'); await clickDelete();
  await waitFor('document.querySelector("dialog")?.textContent.includes("2 components, 1 requirement set, and 1 item")');
  await click('Cancel', 'dialog');
  assert.equal(service.state().current.workspace.domains.REQUIREMENT.requirementSets.length, 1);
  await clickDelete(); await click('Delete permanently', 'dialog');
  await waitFor('!document.querySelector("dialog")');
  assert.equal(service.state().current.workspace.domains.REQUIREMENT.requirementSets.length, 0);
  assert.deepEqual(service.state().current.workspace.retiredIds, [permanentId]);
  assert.equal(service.state().current.workspace.domains.ACTION.requirementSets.length, 1);
  await service.open(project); window.reload();
  await waitFor('!!document.querySelector(".overview")');
  await select('Requirements');
  assert.equal(await execute(String.raw`!!document.querySelector("li[aria-label=\"Parser\"]")`), false);
  assert.deepEqual((await loadWorkspace(project)).retiredIds, [permanentId]);
  assert.equal(JSON.parse(readFileSync(path.join(project, 'requirements/components.json'))).length, 1);
  console.log('Hierarchy smoke test passed: four roots, nested components/requirementSets, breadcrumbs, search by item ID, keyboard navigation, uniqueness validation, properties, immutable IDs, delete confirmation, tombstones and reload.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(timeout); if (window && !window.isDestroyed()) window.close(); rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode || 0);
});
