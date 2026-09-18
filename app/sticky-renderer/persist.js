// Renderer notes.json / defaults.json access. Same files the main process and
// sidecar also write — do not claim a single writer. saveNote replaces the
// matched record in full (unknown fields survive only if the caller passed
// the object from findNote).
'use strict';

function translateContainerPath(filePath, opts) {
  opts = opts || {};
  const fs = opts.fs || require('fs');
  const path = opts.path || require('path');
  const platform = opts.platform || process.platform;
  if (!filePath) return filePath;
  if (platform !== 'win32') return filePath;

  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('file:///')) {
    normalized = normalized.slice(8);
  } else if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  }

  if (normalized.startsWith('workspace/')) {
    normalized = '/' + normalized;
  }

  if (normalized.startsWith('/workspace/')) {
    const parts = normalized.slice(11).split('/');
    const workspaceName = parts[0];
    const relativePath = parts.slice(1).join('\\');

    let currentDir = opts.cwd || process.cwd();
    try {
      const remote = require('@electron/remote');
      if (remote && remote.app) {
        currentDir = remote.app.getAppPath();
      }
    } catch (e) {
      /* no remote in tests / some builds */
    }

    let projectRoot = currentDir;
    for (let i = 0; i < 5; i++) {
      if (path.basename(projectRoot).toLowerCase() === workspaceName.toLowerCase()) {
        return path.join(projectRoot, relativePath);
      }
      const parent = path.dirname(projectRoot);
      if (parent === projectRoot) break;
      projectRoot = parent;
    }

    projectRoot = currentDir;
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(projectRoot, 'package.json'))) {
        return path.join(projectRoot, relativePath);
      }
      const parent = path.dirname(projectRoot);
      if (parent === projectRoot) break;
      projectRoot = parent;
    }
  }

  return filePath;
}

function createPersist(d) {
  d = d || {};
  const fs = d.fs || require('fs');
  const path = d.path || require('path');
  const os = d.os || require('os');
  const homedir = d.homedir || os.homedir();
  const stickysDir = path.join(homedir, '.hyperia', 'stickys');
  const notesJson = path.join(stickysDir, 'notes.json');
  const stickyDefaultsPath = path.join(stickysDir, 'defaults.json');
  const cfgPath = path.join(homedir, '.hyperia', 'hyperia.json');

  function readNotes() {
    try {
      const arr = JSON.parse(fs.readFileSync(notesJson, 'utf8'));
      if (Array.isArray(arr)) {
        return arr.filter((n) => n && typeof n === 'object' && typeof n.id === 'string');
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  function writeNotes(notes) {
    try {
      fs.mkdirSync(stickysDir, {recursive: true});
      fs.writeFileSync(notesJson, JSON.stringify(notes, null, 2), 'utf8');
    } catch (e) {
      console.error(e);
    }
  }

  function findNote(id) {
    return readNotes().find((n) => n.id === id);
  }

  function saveNote(note) {
    const notes = readNotes();
    const idx = notes.findIndex((n) => n.id === note.id);
    if (idx >= 0) notes[idx] = note;
    else notes.push(note);
    writeNotes(notes);
  }

  return {
    fs,
    path,
    os,
    stickysDir,
    notesJson,
    stickyDefaultsPath,
    cfgPath,
    readNotes,
    writeNotes,
    findNote,
    saveNote,
    translateContainerPath: (p) => translateContainerPath(p, {fs, path, platform: process.platform, cwd: d.cwd})
  };
}

module.exports = {createPersist, translateContainerPath};
