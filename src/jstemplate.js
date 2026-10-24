'use strict';
// The original frontend scripts embed tiny PHP snippets for translated strings,
// e.g. '<?php l('game.confirm'); ?>'. This resolves them without a PHP runtime.
// Only the forms that actually occur are supported: l()/ll() calls, string
// literals joined with '.', and a bare `echo ' '`.
const VERSION = 'twlan-node';

function parsePhpArray(src) {
  const params = {};
  for (const m of src.matchAll(/["'](\w+)["']\s*=>\s*["']([^"']*)["']/g)) params[m[1]] = m[2];
  return params;
}

function evalExpression(expr, translate) {
  const parts = [];
  const re = /\s*(?:(?:l|ll)\(\s*(["'])([\w.]+)\1\s*(?:,\s*array\(([^)]*)\))?\s*\)|(["'])((?:\\.|(?!\4).)*)\4|(phpversion\(\))|(Globals::[A-Z_]+))\s*(?:\.|$)/gy;
  let m;
  while ((m = re.exec(expr)) !== null) {
    if (m[2]) parts.push(translate(m[2], m[3] ? parsePhpArray(m[3]) : {}));
    else if (m[5] !== undefined) parts.push(m[5]);
    else parts.push(VERSION);
    if (re.lastIndex >= expr.length) break;
  }
  return parts.join('');
}

function runBlock(code, translate) {
  return code.split(';').map((s) => s.trim()).filter(Boolean)
    .map((stmt) => {
      if (/^namespace\s/.test(stmt)) return '';
      return evalExpression(stmt.replace(/^echo\s+/, ''), translate);
    }).join('');
}

function processJs(text, translate) {
  return text.replace(/(.?)<\?php([\s\S]*?)\?>/g, (all, before, code) => {
    let out = runBlock(code, translate);
    // Inside a JS string literal the quote character must be escaped.
    if (before === "'" || before === '"') out = out.replace(/\\/g, '\\\\').split(before).join(`\\${before}`);
    return before + out;
  });
}

module.exports = { processJs };
