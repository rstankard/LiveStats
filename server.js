#!/usr/bin/env node
/**
 * espn-statcrew — on-demand ESPN -> StatCrew XML feed for Ross XPression DataLinq
 *
 * Click "HIT ME" in the browser control panel; the server fetches the ESPN
 * college-football boxscore for the chosen game, reshapes it into StatCrew-style
 * XML, and serves it at /feed.xml for your XPression "football statcrew" DataLinq
 * source. Players are keyed by jersey (code + uni), so your existing
 * team\player<code=@Key_Stat@>\rush / att mappings resolve unchanged.
 *
 *   /            control panel (open in a browser)
 *   /feed.xml    latest StatCrew XML   (point XPression DataLinq here)
 *   /api/pull    fetch ESPN + rebuild the XML (the button calls this)
 *   /api/status  current game + last pull info
 *   /api/scoreboard?date=YYYYMMDD   list games to pick from
 *   /health      plain status
 *
 * Node 18+ (global fetch). No dependencies, no install, no admin.
 *
 * Env (all optional): PORT (default 8089), EVENT_ID, OUT_FILE (also write XML to a path).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const CONFIG = {
  port: parseInt(process.env.PORT || '8089', 10),
  eventId: (process.env.EVENT_ID || '').trim(),
  outFile: process.env.OUT_FILE || '',
  autoMs: (parseInt(process.env.AUTO || '0', 10) || 0) * 1000, // AUTO in seconds; 0 = manual
};
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const UA = 'curl/8.5.0'; // ESPN's WAF rejects browser/custom UAs from some IPs but allows curl-style

const state = {
  eventId: CONFIG.eventId || null,
  gameLabel: null,
  xml: null,
  updated: null,
  error: null,
  teams: [],       // [{vh,code,name,score,players}]
  playerCount: 0,
  preview: [],     // [{vh, code, name, stats:[...] }] rushing preview
  autoMs: 0,       // 0 = manual; else auto-pull interval in ms
  nextAt: null,    // timestamp of next scheduled auto pull
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
    if (CONFIG.outFile) {
      try { fs.writeFileSync(CONFIG.outFile, xml); }
      catch (e) { console.warn('[warn] OUT_FILE write failed:', e.message); }
    }
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
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
        error: state.error, outFile: CONFIG.outFile || null,
        autoMs: state.autoMs, nextAt: state.nextAt,
      }); return;
    }
    if (p === '/api/setgame' && req.method === 'POST') {
      const body = await readBody(req);
      state.eventId = String(body.eventId || '').trim() || null;
      state.gameLabel = null; state.xml = null; state.updated = null; state.teams = []; state.preview = []; state.playerCount = 0;
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
      res.end(`event=${state.eventId || ''}\nupdated=${state.updated || 'never'}\nplayers=${state.playerCount}\nerror=${state.error || 'none'}\n`); return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  } catch (e) {
    state.error = e.message;
    if (p.startsWith('/api/')) sendJson(res, 500, { ok: false, error: e.message });
    else { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(e.message); }
    console.warn('[err]', p, e.message);
  }
});

server.listen(CONFIG.port, () => {
  console.log(`espn-statcrew running: http://localhost:${CONFIG.port}`);
  console.log(`XPression feed URL:    http://localhost:${CONFIG.port}/feed.xml`);
  if (state.eventId) console.log(`preloaded event: ${state.eventId}`);
  if (CONFIG.autoMs > 0) scheduleAuto(CONFIG.autoMs);
});
