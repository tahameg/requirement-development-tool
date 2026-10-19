const { app } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
const pg = require('pg');
const root = mkdtempSync(path.join(os.tmpdir(), 'hlr-collab-ui-'));
app.setPath('userData', path.join(root, 'profile'));
let window, server, pool, admin, failed = false;
const schema = 'ui_' + randomUUID().replaceAll('-', '_');
const timeout = setTimeout(() => { console.error('Collaboration UI timed out'); app.exit(1); }, 60000);
const load = file => import(pathToFileURL(path.resolve('dist', file)));
async function script(js) { return window.webContents.executeJavaScript(js); }
async function waitFor(js) { for (let i = 0; i < 200; i++) { if (await script(js)) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('Timed out: ' + js); }
async function click(text) { await script(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('Missing button: '+${JSON.stringify(text)}); b.click(); })()`); }
async function fill(selector, value) { await script(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
async function command(cmd) { const r = await script(`window.hlr.collab(${JSON.stringify(cmd)})`); assert.equal(r.ok, true, r.error); return r.value; }
app.whenReady().then(async () => {
  if (!process.env.HLR_TEST_DATABASE_URL) throw new Error('Set HLR_TEST_DATABASE_URL to an isolated test database');
  admin = new pg.Client({ connectionString: process.env.HLR_TEST_DATABASE_URL }); await admin.connect(); await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = new pg.Pool({ connectionString: process.env.HLR_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  const { PgServerStore, runMigrations } = await load('server/store/index.js'); const connection = await pool.connect(); try { await runMigrations(connection); } finally { connection.release(); }
  const { CollabServer } = await load('server/httpServer.js');
  server = new CollabServer({ store: new PgServerStore(pool, { ownsPool: true }), dataDir: path.join(root, 'server'), host: '127.0.0.1', port: 0, discovery: false });
  const info = await server.start();
  const { AppConfig } = await load('main/config/appConfig.js'); const { DesktopService } = await load('main/services/desktopService.js'); const { createDesktopWindow } = await load('main/window.js');
  window = await createDesktopWindow(new DesktopService(new AppConfig(path.join(root, 'config.ini'))));
  const errors = []; window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent==='Team server'&&!b.disabled)"); await click('Team server');
  await waitFor('!!document.querySelector("input[placeholder=\\"https://192.168.1.20:8443\\"]")');
  await fill('input[placeholder="https://192.168.1.20:8443"]', server.getBaseUrl()); await click('Connect');
  await waitFor('!!document.querySelector(".trust-card")'); await click('Trust and continue');
  await waitFor('!!document.querySelector("input[name=setupToken]")');
  await fill('input[name=username]', 'owner'); await fill('input[name=displayName]', 'Team Owner'); await fill('input[name=password]', 'password123'); await fill('input[name=setupToken]', info.setupToken);
  await click('Set up server'); await waitFor('!!document.querySelector(".lobby")');
  await fill('input[name=name]', 'Flight Control'); await click('Create room');
  await waitFor('!!document.querySelector(".room-home")');
  await command({ action: 'op', op: { opId: randomUUID(), kind: 'hierarchy', payload: { action: 'addComponent', objectType: 'REQUIREMENT', parentId: null, name: 'Navigation', prefix: 'NAV', description: '' } } });
  let state = await command({ action: 'state' }); const componentId = state.workspace.domains.REQUIREMENT.components[0].id;
  await command({ action: 'op', op: { opId: randomUUID(), kind: 'hierarchy', payload: { action: 'addRequirementSet', objectType: 'REQUIREMENT', parentId: componentId, name: 'Guidance', prefix: 'GUID', description: '' } } });
  await waitFor(`!!document.querySelector('[data-node-key="${componentId}"] .tree-toggle')`);
  await script(`document.querySelector('[data-node-key="${componentId}"] .tree-toggle').click()`);
  await waitFor("[...document.querySelectorAll('.tree-select')].some(b=>b.textContent.includes('Guidance'))");
  await script("[...document.querySelectorAll('.tree-select')].find(b=>b.textContent.includes('Guidance')).click()");
  await waitFor('!!document.querySelector(".room-grid")'); await click('Add requirement');
  await waitFor('!!document.querySelector(".row-draft textarea")'); await fill('.row-draft textarea', 'The controller shall preserve shared requirements.');
  await script('document.querySelector(".row-draft .btn-primary").click()');
  await waitFor('document.querySelector("tbody")?.textContent.includes("preserve shared requirements") && !document.querySelector(".row-draft")');
  await script('document.querySelector("button[aria-label^=\\"Edit REQ\\"]").click()'); await waitFor('!!document.querySelector(".row-draft textarea")'); await fill('.row-draft textarea', 'The controller shall share edits in real time.');
  await waitFor('document.querySelector("tbody")?.textContent.includes("share edits in real time")'); await click('Save and close');
  await waitFor('!document.querySelector(".row-draft")');
  await click('Revisions'); await waitFor('!!document.querySelector("input[name=message]")'); await fill('input[name=message]', 'Reviewed baseline'); await click('Save revision');
  await waitFor('document.querySelector("main")?.textContent.includes("Reviewed baseline")');
  assert.equal((await command({ action: 'state' })).workspace.domains.REQUIREMENT.requirementSets[0].items.length, 1);
  assert.equal(await script('typeof require'), 'undefined');
  assert.equal(await script('fetch("https://example.com").then(()=>false,()=>true)'), true);
  writeFileSync(path.join(os.tmpdir(), 'hlr-collaboration-smoke.png'), (await window.webContents.capturePage()).toPNG());
  assert.equal(errors.filter(e => !e.includes('Content Security Policy') && !e.includes('Refused to connect')).length, 0, errors.join('\n'));
  console.log('Collaboration desktop smoke passed: TLS trust, setup, room creation, live add/edit, revisions, sandbox.');
}).catch(async error => { console.error(error); failed = true; if (window && !window.isDestroyed()) { console.error(await script('document.body.innerText')); writeFileSync(path.join(os.tmpdir(), 'hlr-collaboration-failure.png'), (await window.webContents.capturePage()).toPNG()); } }).finally(async () => {
  clearTimeout(timeout); if (window && !window.isDestroyed()) window.destroy(); if (server) await server.stop(); else if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  rmSync(root, { recursive: true, force: true }); app.exit(failed ? 1 : 0);
});
