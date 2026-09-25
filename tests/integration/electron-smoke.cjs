const { app, dialog } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
const root = mkdtempSync(path.join(os.tmpdir(), 'hlr-electron-'));
app.setPath('userData', path.join(root, 'electron-profile'));
let window;
const timeout = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1); }, 30000);
async function waitFor(script) {
  for (let i = 0; i < 100; i++) {
    if (await window.webContents.executeJavaScript(script)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${script}`);
}
app.whenReady().then(async () => {
  const { AppConfig } = await import(pathToFileURL(path.resolve('dist/main/config/appConfig.js')));
  const { DesktopService } = await import(pathToFileURL(path.resolve('dist/main/services/desktopService.js')));
  const { createDesktopWindow } = await import(pathToFileURL(path.resolve('dist/main/window.js')));
  const config = new AppConfig(path.join(root, 'config', 'hlr-writing-tool', 'config.ini'));
  const service = new DesktopService(config);
  window = await createDesktopWindow(service);
  const errors = [];
  window.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
  await waitFor('!!document.querySelector(".launch-card") && !document.querySelector("main").getAttribute("aria-busy").includes("true")');
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await window.webContents.executeJavaScript('typeof process'), 'undefined');
  assert.equal(await window.webContents.executeJavaScript('typeof window.hlr.state'), 'function');
  assert.equal(await window.webContents.executeJavaScript('fetch("https://example.com").then(() => false, () => true)'), true);
  assert.match(readFileSync(config.filename, 'utf8'), /\[general\]/);
  await window.webContents.executeJavaScript('document.querySelector(".launch-card").click()');
  await waitFor('!!document.querySelector("form")');
  const project = path.join(root, 'Smoke.hlr');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: project });
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('form input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Smoke project');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor('!document.querySelector("button.primary").disabled');
  await window.webContents.executeJavaScript('document.querySelector("form").requestSubmit()');
  await waitFor('document.querySelector(".workspace-card") && !document.querySelector("main").getAttribute("aria-busy").includes("true")');
  const state = await window.webContents.executeJavaScript('window.hlr.state()');
  assert.equal(state.ok, true); assert.equal(state.value.current.workspace.config.projectName, 'Smoke project');
  assert.equal(state.value.current.index.status, 'ready');
  assert.equal(readFileSync(path.join(project, '.hlr/cache.sqlite')).subarray(0, 15).toString(), 'SQLite format 3');
  await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".section-heading button")).find(b => b.textContent === "Project settings").click()');
  await waitFor('!!document.querySelector("form select")');
  await window.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('select'); select.value = 'LOWER'; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await window.webContents.executeJavaScript('document.querySelector("form").requestSubmit()');
  await waitFor('!!document.querySelector(".workspace-card")');
  assert.equal(JSON.parse(readFileSync(path.join(project, 'project.config.json'))).idCasing, 'LOWER');
  await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("header button")).find(b => b.textContent === "Application settings").click()');
  await waitFor('!!document.querySelector("form select")');
  await window.webContents.executeJavaScript(`(() => {
    const select = document.querySelector('select'); select.value = 'light'; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await window.webContents.executeJavaScript('document.querySelector("form").requestSubmit()');
  await waitFor('document.documentElement.dataset.theme === "light"');
  assert.equal(new AppConfig(config.filename).get().general.theme, 'light');
  await window.webContents.executeJavaScript('window.hlr.saveSettings({ theme: "dark", language: "en", auto_save_interval_sec: 300 })');
  await window.webContents.reload();
  await waitFor('!!document.querySelector(".workspace-card")');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  const reopened = await window.webContents.executeJavaScript('window.hlr.openProject()');
  assert.equal(reopened.value.current.index.status, 'ready');
  await window.webContents.executeJavaScript('window.hlr.saveProject()');
  assert.deepEqual(errors, []);
  writeFileSync(path.join(os.tmpdir(), 'hlr-desktop-smoke.png'), (await window.webContents.capturePage()).toPNG());
  window.close(); window = null;
  console.log('Desktop smoke test passed: sandbox, preload, offline CSP, create/open, project settings, INI preferences, native SQLite, save, reload.');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(timeout);
  if (window && !window.isDestroyed()) window.close();
  rmSync(root, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
