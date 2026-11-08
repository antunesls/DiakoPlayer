'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const DEFAULTS = {
  port: 26538,
  hostname: '0.0.0.0',
  // Quando true, cada aparelho novo precisa ser aprovado no PC antes de controlar.
  authEnabled: true,
  secret: crypto.randomBytes(32).toString('hex'),
  authorizedClients: [],
  startUrl: 'https://music.youtube.com/',
  lastUrl: null,
  resumeLastUrl: true,
  minimizeToTray: true,
  autoDismissYouThere: true,
  window: { width: 1280, height: 800 },
};

let file;
let data;

function load() {
  file = path.join(app.getPath('userData'), 'diakoplayer-config.json');
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
  save();
  return data;
}

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function get(key) {
  return key ? data[key] : data;
}

function set(patch) {
  data = { ...data, ...patch };
  save();
  return data;
}

module.exports = { load, get, set };
