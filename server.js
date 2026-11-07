#!/usr/bin/env node
/**
 * espn-statcrew — on-demand ESPN -> StatCrew XML feed for Ross XPression DataLinq
 *
 * Pulls the ESPN college-football boxscore for the chosen game, reshapes it into
 * StatCrew-style XML, serves it at /feed.xml and (optionally) writes it to a file
 * for your XPression "football statcrew" XML Linq source. Players are keyed by
 * jersey (code + uni), so team\player<code=@Key_Stat@>\rush / att resolves unchanged.
 *
 * Everything is configured from the Settings window in the control panel and saved
 * to settings.json next to this file. Environment variables set in start.bat
 * (PORT, OUT_FILE, EVENT_ID, AUTO) still work and override the saved settings.
 *
 *   /            control panel (open in a browser)
 *   /feed.xml    latest StatCrew XML
 *   /api/pull    fetch ESPN + rebuild the XML (the button calls this)
 *   /api/status  current game + last pull info
 *   /api/settings, /api/pickfolder, /api/checkfolder, /api/mkdir, /api/ls  (settings window)
 *   /api/scoreboard?date=YYYYMMDD   list games to pick from
 *   /health      plain status
 *
 * Node 18+ (global fetch). No dependencies, no install, no admin.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const UA = 'curl/8.5.0'; // ESPN's WAF rejects browser/custom UAs from some IPs but allows curl-style
const IS_WIN = process.platform === 'win32';
const AUTO_CHOICES = [0, 5000, 15000, 30000, 60000, 120000];

// ---- settings ---------------------------------------------------------------
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DEFAULTS = {
  port: 8089,
  writeFile: false,        // also write the XML to a file
  outFolder: '',
  outName: 'livestats.xml',
  startupGame: 'last',     // 'last' | 'fixed' | 'none'
  startupEventId: '',
  startupAutoMs: 0,        // refresh mode when the server starts
  openBrowser: true,       // open the control panel when the server starts
  lastEventId: '',         // remembered automatically
};

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.warn('[warn] settings.json unreadable, using defaults:', e.message); }
  return { ...DEFAULTS, ...saved };
}
function saveSettings() {
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

// start.bat variables win over saved settings; the panel shows those fields as locked.
const ENV = {
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : null,
  outFile: (process.env.OUT_FILE || '').trim().replace(/^"|"$/g, ''),
  eventId: (process.env.EVENT_ID || '').trim(),
  autoMs: process.env.AUTO ? (parseInt(process.env.AUTO, 10) || 0) * 1000 : null,
};
const locked = [];
if (ENV.port) locked.push('port');
if (ENV.outFile) locked.push('output');
if (ENV.eventId) locked.push('startupGame');
if (ENV.autoMs !== null) locked.push('startupAutoMs');

let settings = loadSettings();

function effectivePort() { return ENV.port || settings.port; }
function effectiveOutFile() {
  if (ENV.outFile) return ENV.outFile;
  if (!settings.writeFile || !settings.outFolder) return '';
  return path.join(settings.outFolder, settings.outName || DEFAULTS.outName);
}
function startupEventId() {
  if (ENV.eventId) return ENV.eventId;
  if (settings.startupGame === 'fixed') return settings.startupEventId || '';
  if (settings.startupGame === 'last') return settings.lastEventId || '';
  return '';
}
function startupAutoMs() { return ENV.autoMs !== null ? ENV.autoMs : settings.startupAutoMs; }

const state = {
  eventId: startupEventId() || null,
  gameLabel: null,
  xml: null,
  updated: null,
  error: null,
  teams: [],       // [{vh,code,name,score,players}]
  playerCount: 0,
  preview: [],     // [{vh, code, name, stats:[...] }] rushing preview
  autoMs: 0,       // 0 = manual; else auto-pull interval in ms
  nextAt: null,    // timestamp of next scheduled auto pull
  fileError: null, // last output-file write failure
  fileWritten: null,
};

// ---- ESPN category -> StatCrew element + attribute names --------------------
const TAG = {
  rushing: 'rush', passing: 'pass', receiving: 'rcv', fumbles: 'fumbles',
  defensive: 'defense', interceptions: 'intercept',
  kickReturns: 'koret', puntReturns: 'puntret', kicking: 'fgs', punting: 'punt',
};
const LABELS = {
  rushing: { CAR: 'att', YDS: 'yds', AVG: 'avg', TD: 'td', LONG: 'long' },
  passing: { YDS: 'yds', AVG: 'avg', TD: 'td', INT: 'int', QBR: 'qbr', RTG: 'rtg' },
  receiving: { REC: 'no', YDS: 'yds', AVG: 'avg', TD: 'td', LONG: 'long', TGTS: 'tgts' },
  fumbles: { FUM: 'fum', LOST: 'lost', REC: 'rec' },
  defensive: { TOT: 'tot', SOLO: 'solo', SACKS: 'sacks', TFL: 'tfl', PD: 'pd', 'QB HTS': 'qh', TD: 'td' },
  interceptions: { INT: 'no', YDS: 'yds', TD: 'td' },
  kickReturns: { NO: 'no', YDS: 'yds', AVG: 'avg', LONG: 'long', TD: 'td' },
  puntReturns: { NO: 'no', YDS: 'yds', AVG: 'avg', LONG: 'long', TD: 'td' },
  kicking: { FG: 'fg', PCT: 'pct', LONG: 'long', XP: 'xp', PTS: 'pts' },
  punting: { NO: 'no', YDS: 'yds', AVG: 'avg', TB: 'tb', LONG: 'long', 'IN 20': 'inside20' },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sanitize(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'x';
}
function nameLastFirst(a) {
  if (a && a.lastName && a.firstName) return `${a.lastName},${a.firstName}`;
  const dn = (a && a.displayName) || '';
  const w = dn.trim().split(/\s+/);
  if (w.length < 2) return dn;
  const last = w.pop();
  return `${last},${w.join(' ')}`;
}

// map one athlete row in one category to {tag, attrs{}}
function mapCategory(catName, labels, stats) {
  const tag = TAG[catName] || sanitize(catName);
  const known = LABELS[catName] || {};
  const attrs = {};
  labels.forEach((label, i) => {
    const val = stats[i];
    if (val == null || val === '') return;
    if (label === 'C/ATT') {                       // passing completions/attempts
      const [comp, att] = String(val).split('/');
      if (comp != null) attrs.comp = comp;
      if (att != null) attrs.att = att;
      return;
    }
    if (label === 'SACKS' && String(val).includes('-')) { // passing sacks-yards
      const [n, y] = String(val).split('-');
      attrs.sacks = n; attrs.sackyds = y;
      return;
    }
    attrs[known[label] || sanitize(label)] = val;
  });
  return { tag, attrs };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
  return r.json();
}

// Build the StatCrew XML for one ESPN event id.
async function buildXml(eventId) {
  const data = await fetchJson(`${ESPN}/summary?event=${encodeURIComponent(eventId)}`);
  const comp = (((data.header || {}).competitions) || [])[0] || {};
  const competitors = comp.competitors || [];
  const homeAwayById = {}, scoreById = {};
  for (const c of competitors) {
    if (c.team && c.team.id) { homeAwayById[c.team.id] = c.homeAway; scoreById[c.team.id] = c.score; }
  }
  const st = comp.status || {};
  const statusXml = `  <status state="${esc((st.type || {}).state)}" period="${esc(st.period)}" ` +
    `clock="${esc(st.displayClock)}" detail="${esc((st.type || {}).detail || (st.type || {}).shortDetail)}"/>\n`;

  const teamsOut = [];      // for XML, ordered V then H
  const teamsMeta = [];     // for UI
  const previewOut = [];

  for (const tb of (data.boxscore || {}).players || []) {
    const team = tb.team || {};
    const vh = homeAwayById[team.id] === 'home' ? 'H' : 'V';
    // merge categories per athlete
    const byAthlete = new Map();
    for (const cat of tb.statistics || []) {
      const labels = cat.labels || [];
      for (const row of cat.athletes || []) {
        const a = row.athlete || {};
        const key = a.id || `${a.jersey}|${a.displayName}`;
        if (!byAthlete.has(key)) {
          byAthlete.set(key, { uni: a.jersey != null ? String(a.jersey) : '', name: nameLastFirst(a), disp: a.displayName || '', cats: {} });
        }
        const { tag, attrs } = mapCategory(cat.name, labels, row.stats || []);
        byAthlete.get(key).cats[tag] = attrs;
      }
    }
    // emit players
    let playersXml = '';
    let count = 0;
    for (const p of byAthlete.values()) {
      count++;
      const open = `    <player uni="${esc(p.uni)}" code="${esc(p.uni)}" name="${esc(p.name)}" disp="${esc(p.disp)}" gp="1">`;
      const kids = Object.entries(p.cats).map(([tag, attrs]) => {
        const a = Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
        return `      <${tag} ${a}/>`;
      }).join('\n');
      playersXml += `${open}\n${kids}\n    </player>\n`;
      if (p.cats.rush) {
        previewOut.push({ vh, code: p.uni, name: p.disp || p.name, stats: p.cats.rush });
      }
    }
    const name = team.location || team.displayName || team.abbreviation || '';
    const teamXml = `  <team vh="${vh}" id="${esc(team.id)}" name="${esc(name)}" code="${esc(team.abbreviation)}" score="${esc(scoreById[team.id])}">\n${playersXml}  </team>\n`;
    teamsOut.push({ vh, xml: teamXml });
    teamsMeta.push({ vh, code: team.abbreviation, name, score: scoreById[team.id], players: count });
  }

  teamsOut.sort((a, b) => (a.vh === 'V' ? -1 : 1) - (b.vh === 'V' ? -1 : 1));
  const gen = new Date().toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<fbgame source="ESPN" gameid="${esc(eventId)}" generated="${gen}">\n` +
    statusXml + teamsOut.map(t => t.xml).join('') + `</fbgame>\n`;

  const label = teamsMeta.length === 2
    ? `${teamsMeta.find(t => t.vh === 'V')?.code || '?'} @ ${teamsMeta.find(t => t.vh === 'H')?.code || '?'}`
    : eventId;

  return { xml, teamsMeta, previewOut, label, count: teamsMeta.reduce((n, t) => n + t.players, 0) };
}


function writeOutFile() {
  const out = effectiveOutFile();
  if (!out || !state.xml) { state.fileError = null; return; }
  try {
    fs.writeFileSync(out, state.xml);
    state.fileError = null; state.fileWritten = new Date().toISOString();
  } catch (e) {
    state.fileError = e.code === 'ENOENT'
      ? `Can't write ${out}: the folder doesn't exist. Create it in Settings.`
      : `Can't write ${out}: ${e.message}`;
    console.warn('[warn] output file:', state.fileError);
  }
}

let pulling = false;
async function pull() {
  if (pulling) return;                 // don't overlap a fetch already in flight
  if (!state.eventId) throw new Error('No game selected. Enter an ESPN event id or find one by date.');
  pulling = true;
  try {
    const { xml, teamsMeta, previewOut, label, count } = await buildXml(state.eventId);
    state.xml = xml;
    state.updated = new Date().toISOString();
    state.teams = teamsMeta;
    state.preview = previewOut;
    state.playerCount = count;
    state.gameLabel = label;
    state.error = null;
    writeOutFile();
    console.log(`[pull] ${state.updated}  ${label}  ${count} players  ${Buffer.byteLength(xml)}B`);
  } finally {
    pulling = false;
  }
}

let autoTimer = null;
function scheduleAuto(ms) {
  ms = Number(ms) || 0;
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  state.autoMs = ms;
  state.nextAt = ms > 0 ? Date.now() + ms : null;
  if (ms > 0) autoTimer = setInterval(autoTick, ms);
  console.log(ms > 0 ? `[auto] every ${ms / 1000}s` : '[auto] off (manual)');
}
async function autoTick() {
  state.nextAt = Date.now() + state.autoMs; // restart the countdown before pulling
  if (!state.eventId) return;               // wait quietly until a game is chosen
  try { await pull(); }
  catch (e) { state.error = e.message; console.warn('[auto]', e.message); }
}

// ---- folder helpers (settings window) ----------------------------------------
function checkFolder(p) {
  if (!p) return { exists: false, isDir: false, writable: false };
  if (!path.isAbsolute(p)) return { exists: false, isDir: false, writable: false, error: 'Use a full path, like D:\\Data\\Football' };
  let st;
  try { st = fs.statSync(p); } catch { return { exists: false, isDir: false, writable: false }; }
  if (!st.isDirectory()) return { exists: true, isDir: false, writable: false, error: 'That path is a file, not a folder' };
  try { fs.accessSync(p, fs.constants.W_OK); return { exists: true, isDir: true, writable: true }; }
  catch { return { exists: true, isDir: true, writable: false, error: 'This folder is read-only for your account' }; }
}

function listDir(p) {
  if (!p) {
    if (IS_WIN) {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        try { fs.accessSync(d); drives.push(d); } catch {}
      }
      return { path: '', parent: null, dirs: drives.map(d => ({ name: d, path: d })) };
    }
    p = '/';
  }
  const full = path.resolve(p);
  const dirs = fs.readdirSync(full, { withFileTypes: true })
    .filter(d => { try { return d.isDirectory() && !d.name.startsWith('$'); } catch { return false; } })
    .map(d => ({ name: d.name, path: path.join(full, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const up = path.dirname(full);
  const parent = up === full ? (IS_WIN ? '' : null) : up;
  return { path: full, parent, dirs };
}

// Native Windows folder dialog via PowerShell (no admin, no install).
let picking = false;
function pickFolderNative(initial) {
  return new Promise((resolve, reject) => {
    if (!IS_WIN) return reject(new Error('The Windows folder dialog is only available on Windows.'));
    if (picking) return reject(new Error('A folder dialog is already open. Check behind your other windows.'));
    picking = true;
    const ps = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = 'Choose the folder for the XPression XML file'",
      '$d.ShowNewFolderButton = $true',
      'if ($env:PICK_INITIAL -and (Test-Path -LiteralPath $env:PICK_INITIAL)) { $d.SelectedPath = $env:PICK_INITIAL }',
      '$o = New-Object System.Windows.Forms.Form',
      '$o.TopMost = $true; $o.ShowInTaskbar = $false',
      "if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], {
      env: { ...process.env, PICK_INITIAL: initial || '' }, windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { picking = false; reject(new Error('Could not start PowerShell: ' + e.message)); });
    child.on('close', code => {
      picking = false;
      if (code !== 0) return reject(new Error('The folder dialog failed to open' + (err ? `: ${err.trim().split('\n')[0]}` : '.')));
      resolve(out.trim() || null);   // null = cancelled
    });
  });
}

function openBrowser(url) {
  try {
    const cmd = IS_WIN ? ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } catch {}
}

function settingsPayload() {
  return {
    settings,
    effective: { port: effectivePort(), outFile: effectiveOutFile() },
    env: { port: ENV.port, outFile: ENV.outFile || null, eventId: ENV.eventId || null, autoMs: ENV.autoMs },
    locked, platform: process.platform, nativePicker: IS_WIN, autoChoices: AUTO_CHOICES,
  };
}

// ---- http -------------------------------------------------------------------
const INDEX = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); }
  catch { return '<h1>index.html not found next to server.js</h1>'; }
})();

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
// Settings and folder endpoints only answer the control panel on this PC:
// local requests, same origin, JSON bodies.
function guardLocal(req, res) {
  if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: 'Settings can only be changed from this PC.' }); return false; }
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch {}
    if (!ok) { sendJson(res, 403, { ok: false, error: 'Cross-origin request refused.' }); return false; }
  }
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
    sendJson(res, 415, { ok: false, error: 'Expected JSON.' }); return false;
  }
  return true;
}

const SETTINGS_API = new Set(['/api/settings', '/api/pickfolder', '/api/checkfolder', '/api/mkdir', '/api/ls']);

async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (SETTINGS_API.has(p) && !guardLocal(req, res)) return;

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(INDEX); return;
    }
    if (p === '/feed.xml') {
      if (!state.xml) { res.writeHead(503, { 'Content-Type': 'application/xml' }); res.end('<!-- no feed pulled yet -->'); return; }
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(state.xml); return;
    }
    if (p === '/api/status') {
      sendJson(res, 200, {
        eventId: state.eventId, game: state.gameLabel, updated: state.updated,
        teams: state.teams, playerCount: state.playerCount, preview: state.preview,
        error: state.error, outFile: effectiveOutFile() || null,
        fileError: state.fileError, fileWritten: state.fileWritten,
        autoMs: state.autoMs, nextAt: state.nextAt,
      }); return;
    }
    if (p === '/api/setgame' && req.method === 'POST') {
      const body = await readBody(req);
      state.eventId = String(body.eventId || '').trim() || null;
      state.gameLabel = null; state.xml = null; state.updated = null; state.teams = []; state.preview = []; state.playerCount = 0;
      if (state.eventId && state.eventId !== settings.lastEventId) {
        settings.lastEventId = state.eventId;
        try { saveSettings(); } catch (e) { console.warn('[warn] could not save settings:', e.message); }
      }
      sendJson(res, 200, { ok: true, eventId: state.eventId }); return;
    }
    if (p === '/api/pull' && req.method === 'POST') {
      await pull(); sendJson(res, 200, { ok: true, game: state.gameLabel, updated: state.updated, playerCount: state.playerCount, teams: state.teams, preview: state.preview }); return;
    }
    if (p === '/api/setauto' && req.method === 'POST') {
      const body = await readBody(req);
      scheduleAuto(Number(body.ms) || 0);
      sendJson(res, 200, { ok: true, autoMs: state.autoMs, nextAt: state.nextAt }); return;
    }

    // ---- settings window ----
    if (p === '/api/settings' && req.method === 'GET') { sendJson(res, 200, { ok: true, ...settingsPayload() }); return; }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const next = { ...settings };
      const problems = [];
      if (b.port !== undefined) {
        const n = parseInt(b.port, 10);
        if (!(n >= 1 && n <= 65535)) problems.push('Port must be a number from 1 to 65535.');
        else next.port = n;
      }
      if (b.writeFile !== undefined) next.writeFile = !!b.writeFile;
      if (b.outFolder !== undefined) next.outFolder = String(b.outFolder).trim().replace(/^"|"$/g, '');
      if (b.outName !== undefined) {
        const name = String(b.outName).trim() || DEFAULTS.outName;
        if (/[\\/:*?"<>|]/.test(name)) problems.push('The file name can\'t contain \\ / : * ? " < > |');
        else next.outName = name;
      }
      if (next.writeFile && !next.outFolder) problems.push('Choose a folder for the output file, or turn file output off.');
      if (next.writeFile && next.outFolder && !path.isAbsolute(next.outFolder)) problems.push('The output folder must be a full path, like D:\\Data\\Football.');
      if (b.startupGame !== undefined) {
        if (!['last', 'fixed', 'none'].includes(b.startupGame)) problems.push('Unknown startup game option.');
        else next.startupGame = b.startupGame;
      }
      if (b.startupEventId !== undefined) next.startupEventId = String(b.startupEventId).replace(/[^0-9]/g, '');
      if (next.startupGame === 'fixed' && !next.startupEventId) problems.push('Enter the ESPN event id to load at startup.');
      if (b.startupAutoMs !== undefined) {
        const ms = Number(b.startupAutoMs);
        if (!AUTO_CHOICES.includes(ms)) problems.push('Unknown refresh mode.');
        else next.startupAutoMs = ms;
      }
      if (b.openBrowser !== undefined) next.openBrowser = !!b.openBrowser;
      if (problems.length) { sendJson(res, 400, { ok: false, error: problems.join(' ') }); return; }

      // Port change: bind the new port first, so a busy port fails cleanly.
      let newUrl = null;
      if (!ENV.port && next.port !== currentPort) {
        try {
          const s = await listenOn(next.port);
          const old = server;
          server = s; currentPort = next.port;
          newUrl = `http://localhost:${currentPort}/`;
          setTimeout(() => { old.close(); if (old.closeAllConnections) old.closeAllConnections(); }, 1500);
          console.log(`[port] moved to ${currentPort}. Feed URL is now http://localhost:${currentPort}/feed.xml`);
        } catch (e) {
          sendJson(res, 409, { ok: false, error: e.code === 'EADDRINUSE' ? `Port ${next.port} is already in use. Pick another.` : `Couldn't use port ${next.port}: ${e.message}` });
          return;
        }
      }

      const outBefore = effectiveOutFile();
      settings = next;
      saveSettings();
      if (effectiveOutFile() !== outBefore) writeOutFile(); // rewrite the current feed to the new spot right away
      if (!effectiveOutFile()) state.fileError = null;
      console.log('[settings] saved');
      sendJson(res, 200, { ok: true, newUrl, ...settingsPayload() }); return;
    }
    if (p === '/api/pickfolder' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const picked = await pickFolderNative(String(b.initial || ''));
        sendJson(res, 200, { ok: true, path: picked, cancelled: !picked });
      } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
      return;
    }
    if (p === '/api/checkfolder') { sendJson(res, 200, { ok: true, ...checkFolder(u.searchParams.get('path') || '') }); return; }
    if (p === '/api/mkdir' && req.method === 'POST') {
      const b = await readBody(req);
      const dir = String(b.path || '').trim();
      if (!dir || !path.isAbsolute(dir)) { sendJson(res, 400, { ok: false, error: 'Use a full path, like D:\\Data\\Football' }); return; }
      try { fs.mkdirSync(dir, { recursive: true }); sendJson(res, 200, { ok: true, ...checkFolder(dir) }); }
      catch (e) { sendJson(res, 200, { ok: false, error: `Couldn't create the folder: ${e.message}` }); }
      return;
    }
    if (p === '/api/ls') {
      try { sendJson(res, 200, { ok: true, ...listDir(u.searchParams.get('path') || '') }); }
      catch (e) { sendJson(res, 200, { ok: false, error: `Can't open that folder: ${e.message}` }); }
      return;
    }

    if (p === '/api/scoreboard') {
      const date = (u.searchParams.get('date') || '').replace(/[^0-9]/g, '');
      const url = `${ESPN}/scoreboard?groups=80&limit=200${date ? `&dates=${date}` : ''}`;
      const d = await fetchJson(url);
      const games = (d.events || []).map(e => ({
        id: e.id, name: e.name, short: e.shortName,
        state: ((e.status || {}).type || {}).state, detail: ((e.status || {}).type || {}).shortDetail,
      }));
      sendJson(res, 200, { games }); return;
    }
    if (p === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`event=${state.eventId || ''}\nupdated=${state.updated || 'never'}\nplayers=${state.playerCount}\nerror=${state.error || 'none'}\nfile=${effectiveOutFile() || 'off'}\nfileError=${state.fileError || 'none'}\n`); return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  } catch (e) {
    state.error = e.message;
    if (p.startsWith('/api/')) sendJson(res, 500, { ok: false, error: e.message });
    else { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(e.message); }
    console.warn('[err]', p, e.message);
  }
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.once('error', reject);
    s.listen(port, () => { s.removeListener('error', reject); resolve(s); });
  });
}

let server = null;
let currentPort = effectivePort();
listenOn(currentPort).then(s => {
  server = s;
  const url = `http://localhost:${currentPort}`;
  console.log(`espn-statcrew running: ${url}`);
  console.log(`XPression feed URL:    ${url}/feed.xml`);
  console.log(`Settings file:         ${SETTINGS_FILE}`);
  if (effectiveOutFile()) console.log(`Writing XML to:        ${effectiveOutFile()}`);
  if (locked.length) console.log(`From start.bat:        ${locked.join(', ')} (these override the Settings window)`);
  if (state.eventId) console.log(`Startup game:          ${state.eventId}`);
  const auto = startupAutoMs();
  if (auto > 0) scheduleAuto(auto);
  if (settings.openBrowser && !process.env.NO_BROWSER) openBrowser(url);
}).catch(e => {
  console.error(e.code === 'EADDRINUSE'
    ? `Port ${currentPort} is already in use. Close the other copy, or change "port" in settings.json.`
    : `Could not start: ${e.message}`);
  process.exit(1);
});