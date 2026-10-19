const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
const root = mkdtempSync(path.join(os.tmpdir(), 'hlr-authoring-'));
app.setPath('userData', path.join(root, 'profile'));
let window;
const timeout = setTimeout(() => { console.error('Authoring smoke timed out'); app.exit(1); }, 90000);
const execute = async script => { try { return await window.webContents.executeJavaScript(script); } catch (error) { throw new Error(`${script}\n${error.message}`); } };
async function waitFor(script) { for (let i = 0; i < 150; i++) { if (await execute(script)) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(`Timed out: ${script}`); }
async function click(text, scope = 'main') {
  const script = `Array.from(document.querySelectorAll(${JSON.stringify(scope)} + ' button')).find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`;
  await waitFor(`!!(${script})`); await execute(`${script}.click()`);
}
async function fill(selector, value) { await execute(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`); }
async function select(label) { await execute(`document.querySelector(${JSON.stringify(`li[aria-label="${label}"] > .tree-row .tree-select`)}).click()`); await waitFor(`document.querySelector('main h1')?.textContent.includes(${JSON.stringify(label)})`); }
async function save() { await execute('document.querySelector(".draft-bar .btn-primary").click()'); await waitFor('!document.querySelector(".draft-bar") && document.querySelector("main").getAttribute("aria-busy") === "false"'); }
app.whenReady().then(async () => {
  const load = relative => import(pathToFileURL(path.resolve('dist', relative)));
  const { AppConfig } = await load('main/config/appConfig.js');
  const { DesktopService } = await load('main/services/desktopService.js');
  const { createDesktopWindow } = await load('main/window.js');
  const service = new DesktopService(new AppConfig(path.join(root, 'config.ini')));
  const project = path.join(root, 'Project.hlr'); await service.create(project, 'Flight Control', 'FC');
  for (const objectType of ['REQUIREMENT', 'DATA_DICTIONARY']) {
    await service.changeHierarchy({ action: 'addComponent', objectType, parentId: null, name: objectType === 'REQUIREMENT' ? 'Guidance' : 'Flight data', prefix: 'CTRL', description: '' });
    const parentId = service.state().current.workspace.domains[objectType].components[0].id;
    await service.changeHierarchy({ action: 'addRequirementSet', objectType, parentId, name: objectType === 'REQUIREMENT' ? 'Control altitude' : 'Inputs', prefix: 'ALT', description: '' });
  }
  const reqFn = service.state().current.workspace.domains.REQUIREMENT.requirementSets[0].requirementSetId;
  const diFn = service.state().current.workspace.domains.DATA_DICTIONARY.requirementSets[0].requirementSetId;
  await service.authorRequirementSet({ objectType: 'DATA_DICTIONARY', requirementSetId: diFn, changes: [{ action: 'add', values: { col_name: 'Measured altitude' } }] });
  const targetId = service.state().current.workspace.domains.DATA_DICTIONARY.requirementSets[0].items[0].id;
  window = await createDesktopWindow(service);
  await waitFor('!!document.querySelector(".overview") && document.querySelector("main").getAttribute("aria-busy") === "false"');
  await select('Requirements'); await select('Guidance'); await select('Control altitude');
  await click('Add requirement');
  await execute('document.querySelector(".draft-bar .btn-primary").click()'); await waitFor('document.querySelector(".alert")?.textContent.includes("Required")');
  await fill('textarea[aria-label="Description"]', 'The controller shall track target altitude.');
  await fill('textarea[aria-label="Requirement set description"]', '# Altitude control\n\n- Read measured altitude\n- Limit actuator demand\n\n<script>window.injected = true</script>');
  await save();
  assert.equal(service.state().current.workspace.domains.REQUIREMENT.requirementSets[0].items.length, 1);
  await click('Preview'); assert.equal(await execute('document.querySelector(".markdown h1").textContent'), 'Altitude control'); assert.equal(await execute('typeof window.injected'), 'undefined');
  await click('Write');
  await click('Add requirement'); await fill('textarea[aria-label="Description"]', 'The controller shall reject invalid input.'); await save();
  const firstId = service.state().current.workspace.domains.REQUIREMENT.requirementSets[0].items[0].id;
  await execute(`document.querySelector(${JSON.stringify(`button[aria-label="Edit Description for ${firstId}"]`)}).click()`);
  await fill('textarea[aria-label="Description"]', 'The controller shall track altitude within tolerance.'); await save();
  await execute(`document.querySelector(${JSON.stringify(`button[aria-label="Delete ${firstId}"]`)}).click()`);
  await click('Delete permanently', 'dialog'); await waitFor('!document.querySelector("dialog")');
  await click('Add requirement'); await fill('textarea[aria-label="Description"]', 'The controller shall record telemetry.'); await save();
  assert.deepEqual(service.state().current.workspace.domains.REQUIREMENT.requirementSets[0].items.map(i => i.seq), [2, 3]);
  // Build a typed reference column using the actual project settings UI.
  await click('Overview', '.side-nav');
  await execute('document.querySelector("button[aria-label=\\"Project settings\\"]").click()');
  await click('Reference', '.dd-add-tiles');
  await fill('input[aria-label="Column 3 name"]', 'Source data');
  await click('Save project settings'); await waitFor('!!document.querySelector(".overview")');
  await select('Control altitude');
  const item = service.state().current.workspace.domains.REQUIREMENT.requirementSets[0].items[0];
  await execute(`document.querySelector(${JSON.stringify(`button[aria-label="Edit Source data for ${item.id}"]`)}).click()`);
  await fill('select[aria-label="Source data"]', targetId); await save();
  await execute(`document.querySelector(${JSON.stringify(`button[aria-label="Open reference ${targetId}"]`)}).click()`);
  await waitFor('document.querySelector("main h1")?.textContent.includes("Inputs")');
  await execute(`document.querySelector(${JSON.stringify(`button[aria-label="Delete ${targetId}"]`)}).click()`);
  await click('Delete permanently', 'dialog'); await waitFor('document.querySelector(".alert")?.textContent.includes("Unresolved reference")');
  // Search in SQLite and navigate to the actual matching row.
  await execute('[...document.querySelectorAll(".topbar button")].find(b => b.textContent.startsWith("Search")).click()');
  await fill('input[aria-label="Search all items"]', 'telemetry');
  await waitFor('document.querySelectorAll(".search-results button").length === 1');
  await execute('document.querySelector(".search-results button").click()');
  await waitFor('!!document.querySelector(".target-row")');
  const exportPath = path.join(root, 'export.csv'); dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
  await click('CSV', '.items-panel'); await waitFor('[...document.querySelectorAll(".toast")].some(t => t.textContent.includes("export.csv"))');
  assert.match(readFileSync(exportPath, 'utf8'), /telemetry/); assert.match(readFileSync(exportPath, 'utf8'), /Source data/);
  const markdownPath = path.join(root, 'export.md'); dialog.showSaveDialog = async () => ({ canceled: false, filePath: markdownPath });
  await click('Markdown', '.items-panel'); await waitFor('[...document.querySelectorAll(".toast")].some(t => t.textContent.includes("export.md"))'); assert.match(readFileSync(markdownPath, 'utf8'), /\| ---/);
  writeFileSync(path.join(os.tmpdir(), 'hlr-authoring-smoke.png'), (await window.webContents.capturePage()).toPNG());
  // Ctrl+S commits the active row draft, and idle autosave persists scope edits.
  const editId = service.state().current.workspace.domains.REQUIREMENT.requirementSets[0].items[1].id;
  await execute(`document.querySelector(${JSON.stringify(`button[aria-label="Edit Description for ${editId}"]`)}).click()`);
  await fill('textarea[aria-label="Description"]', 'The controller shall record telemetry safely.');
  window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['control'] });
  await waitFor('!document.querySelector(".draft-bar")');
  assert.equal(service.state().current.workspace.domains.REQUIREMENT.requirementSets[0].items[1].values.col_desc, 'The controller shall record telemetry safely.');
  service.saveSettings({ theme: 'dark', language: 'en', auto_save_interval_sec: 1 });
  window.reload(); await waitFor('!!document.querySelector(".overview")');
  await select('Requirements'); await select('Guidance'); await select('Control altitude');
  await fill('textarea[aria-label="Requirement set description"]', '# Autosaved scope');
  await waitFor('!document.querySelector(".draft-bar")');
  assert.equal(service.state().current.workspace.domains.REQUIREMENT.requirementSets[0].description, '# Autosaved scope');
  const saved = service.state().current.workspace;
  await service.open(project); window.reload(); await waitFor('!!document.querySelector(".overview")');
  assert.deepEqual(service.state().current.workspace, JSON.parse(JSON.stringify(saved)));
  // Verify the virtual table with a real 10,000+ row function, including append-at-end.
  const { saveWorkspace } = await load('main/services/workspaceService.js');
  const large = service.state().current.workspace;
  const largeFn = large.domains.REQUIREMENT.requirementSets[0];
  for (let seq = 4; seq <= 10003; seq++) largeFn.items.push({ id: `REQ-FC-CTRL-ALT-${String(seq).padStart(3, '0')}`, seq, created_at: '2026-09-25T00:00:00Z', values: { col_desc: `Telemetry sample ${seq}`, col_status: 'Draft' } });
  largeFn.watermarkCounter = 10003;
  await saveWorkspace(project, large); await service.open(project); window.reload();
  await waitFor('!!document.querySelector(".overview")');
  await select('Requirements'); await select('Guidance'); await select('Control altitude');
  assert.ok(await execute('document.querySelectorAll(".virtual-table tbody tr").length <= 20'));
  await execute('document.querySelector(".virtual-table").scrollTop = document.querySelector(".virtual-table").scrollHeight');
  await waitFor('document.querySelector(".virtual-table").textContent.includes("REQ-FC-CTRL-ALT-10003")');
  await click('Add requirement'); await fill('textarea[aria-label="Description"]', 'Final virtualized row'); await save();
  assert.equal(service.state().current.workspace.domains.REQUIREMENT.requirementSets[0].items.at(-1).seq, 10004);
  console.log('Authoring smoke passed: required fields, add/edit/delete, immutable gaps, Markdown safety, custom reference column, reference navigation/deletion guard, SQLite search, CSV/Markdown export, persistence.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(timeout); if (window && !window.isDestroyed()) window.destroy(); rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode || 0);
});
