// Re-recorded resubmission (2026-11-16): parser unchanged from the 720/720 practice build; only this comment added.
// Fast CommonMark 0.31.2 + GFM renderer, byte-exact with marked 18.1.3
// (default options: gfm on, breaks off, pedantic off, async off).
//
// Design: a line-based block parser (no giant tempered paragraph regexes,
// no token objects) that renders straight to HTML, with an inline scanner
// that mirrors marked's tokenizer order. Link reference definitions are
// collected in a first block pass so every inline run sees the full map,
// exactly like marked's deferred inline queue.

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const BULLET = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const BLOCK_CODE_START = '(?: {4}| {0,3}\\t)';
const FENCES_START = ' {0,3}(?:`{3,}|~{3,})';
const BLOCKQUOTE_START = ' {0,3}>';
const HEADING_START = ' {0,3}#{1,6}(?:\\s|$)';
const HR_PAT = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HTML_START = ' {0,3}<[^\\n>]+>\\n';
const TABLE_START = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';
const HTML_BEGIN = ' {0,3}(?:</?(?:' + TAG + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
// Same pattern, but for tests against multi-line input (paragraph/table
// interruption): marked uses (?: +|\n|/?>) there, and (?: +|$|/?>) only for
// the single-line htmlBeginRegex used while scanning list items.
const HTML_BEGIN_NL = ' {0,3}(?:</?(?:' + TAG + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

// Block regexes (anchored at the current position).
const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_HTML = new RegExp(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(?:' + TAG + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i');
const RE_DEF = (() => {
  const label = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
  const title = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
  return new RegExp('^ {0,3}\\[(' + label + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + title + '))? *(?:\\n+|$)');
})();
const RE_TABLE = new RegExp(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|' + HR_PAT + '|' + HEADING_START + '|' + BLOCKQUOTE_START + '|(?: {4}| {0,3}\\t)[^\\n]|' + ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)' + '|' + ' {0,3}(?:[*+-]|1[.)])[ \\t]' + '|' + HTML_BEGIN_NL + ').*(?:\\n|$))*)\\n*|$)');
const RE_BLOCKQUOTE = new RegExp(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + blockquoteParagraphSource() + ')|[^\\n]*)(?:\\n|$))+');
const RE_LIST = new RegExp('^(' + BULLET + ')([ \\t][^\\n]*?)?(?:\\n|$)');

// Inline regexes.
const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const RE_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const RE_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/;
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Emphasis delimiter regexes (GFM flavour: ~ is not punctuation for em/strong).
const PUNCT = '[\\p{P}\\p{S}]';
const PUNCT_GFM = '(?!~)[\\p{P}\\p{S}]';
const PUNCT_SPACE_GFM = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_GFM = '(?:[^\\s\\p{P}\\p{S}]|~)';
const EM_L_DELIM_GFM = new RegExp('^(?:\\*+(?:((?!\\*)' + PUNCT_GFM + ')|([^\\s*]))?)|^_+(?:((?!_)' + PUNCT_GFM + ')|([^\\s_]))?', 'u');
const EM_R_DELIM_AST_GFM = new RegExp(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)' + PUNCT_GFM + '(\\*+)(?=[\\s]|$)'
  + '|' + NOT_PUNCT_SPACE_GFM + '(\\*+)(?!\\*)(?=' + PUNCT_SPACE_GFM + '|$)'
  + '|(?!\\*)' + PUNCT_SPACE_GFM + '(\\*+)(?=' + NOT_PUNCT_SPACE_GFM + ')'
  + '|[\\s](\\*+)(?!\\*)(?=' + PUNCT_GFM + ')'
  + '|(?!\\*)' + PUNCT_GFM + '(\\*+)(?!\\*)(?=' + PUNCT_GFM + ')'
  + '|' + NOT_PUNCT_SPACE_GFM + '(\\*+)(?=' + NOT_PUNCT_SPACE_GFM + ')', 'gu');
const EM_R_DELIM_UND = new RegExp(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)' + PUNCT + '(_+)(?=[\\s]|$)'
  + '|' + '[^\\s\\p{P}\\p{S}]' + '(_+)(?!_)(?=' + '[\\s\\p{P}\\p{S}]' + '|$)'
  + '|(?!_)' + '[\\s\\p{P}\\p{S}]' + '(_+)(?=' + '[^\\s\\p{P}\\p{S}]' + ')'
  + '|[\\s](_+)(?!_)(?=' + PUNCT + ')'
  + '|(?!_)' + PUNCT + '(_+)(?!_)(?=' + PUNCT + ')', 'gu');
const DEL_L_DELIM = new RegExp('^~~?(?:((?!~)' + PUNCT + ')|[^\\s~])', 'u');
const DEL_R_DELIM = new RegExp(
  '^[^~]+(?=[^~])'
  + '|(?!~)' + PUNCT + '(~~?)(?=[\\s]|$)'
  + '|' + '[^\\s\\p{P}\\p{S}]' + '(~~?)(?!~)(?=' + '[\\s\\p{P}\\p{S}]' + '|$)'
  + '|(?!~)' + '[\\s\\p{P}\\p{S}]' + '(~~?)(?=' + '[^\\s\\p{P}\\p{S}]' + ')'
  + '|[\\s](~~?)(?!~)(?=' + PUNCT + ')'
  + '|(?!~)' + PUNCT + '(~~?)(?!~)(?=' + PUNCT + ')'
  + '|' + '[^\\s\\p{P}\\p{S}]' + '(~~?)(?=' + '[^\\s\\p{P}\\p{S}]' + ')', 'gu');

const RE_PUNCT = new RegExp('^((?![*_])[\\s\\p{P}\\p{S}])', 'u');
const RE_ANY_PUNCT = new RegExp('\\\\(' + PUNCT + ')', 'gu');
const RE_ANY_PUNCT_OUTSIDE_CODE = new RegExp('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + PUNCT + ')', 'gu');
const RE_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\(\)]|\((?:\\[\s\S]|[^\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

function blockquoteParagraphSource() {
  // A paragraph inside a blockquote capture: like the GFM paragraph but a
  // bare list marker (any number, even with nothing after it) ends it.
  // The fences/html alternatives are marked's full-line forms, as in its
  // paragraph builder (not the bare FENCES_START / $-form HTML_BEGIN).
  const listInterrupt = ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';
  const fencesLine = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
  // No leading ^ here: marked's edit() strips ^ when it splices a pattern
  // into another regex, and this pattern is embedded mid-regex.
  return '([^\\n]+(?:\\n(?!' + HR_PAT + '|' + HEADING_START + '|' + BLOCKQUOTE_START + '|' + fencesLine + '|' + listInterrupt + '|' + HTML_BEGIN_NL + '|[ \\t]+\\n)[^\\n]+)*)';
}

// --- helpers ---------------------------------------------------------------
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESCAPE_TEST = /[&<>"']/;
const RE_ESCAPE_REPLACE = /[&<>"']/g;
const RE_ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(html, encode) {
  if (encode) {
    if (RE_ESCAPE_TEST.test(html)) return html.replace(RE_ESCAPE_REPLACE, (c) => ESCAPE_MAP[c]);
  } else if (RE_ESCAPE_TEST_NO_ENCODE.test(html)) {
    return html.replace(RE_ESCAPE_REPLACE_NO_ENCODE, (c) => ESCAPE_MAP[c]);
  }
  return html;
}

function decodeNumericRefs(text) {
  if (!RE_NUMERIC_REF.test(text)) return text;
  return text.replace(RE_NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const ch = str.charAt(l - suffLen - 1);
    if (ch === c && !invert) suffLen++;
    else if (ch !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Column (0-based) of the first non-whitespace char, expanding tabs to
// 4-column stops. Returns line.length when the line is blank.
function firstNonWsCol(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else return col;
  }
  return col;
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// --- inline machinery ------------------------------------------------------
// A "run" is one inline span (a paragraph's text, a heading's text, a link
// label, ...). State is shared across nested runs exactly like marked's
// lexer state: inLink / inRawBlock persist out of a nested run, linkEmitted
// is restored, and a rejected link restores inRawBlock.

const RE_LINK_LABEL_INNER = '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]`])*?';
const RE_BLOCK_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const RE_LINK = new RegExp('^!?\\[(' + RE_LINK_LABEL_INNER + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)');
const RE_REFLINK = new RegExp('^!?\\[(' + RE_LINK_LABEL_INNER + ')\\]\\[(' + RE_BLOCK_LABEL + ')\\]');
const RE_NOLINK = new RegExp('^!?\\[(' + RE_BLOCK_LABEL + ')\\](?:\\[\\])?');
const RE_TEXT_GFM = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/;

const RE_REFLINK_SEARCH = (() => {
  const boundedBlock = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
  const boundedInline = '(?:[^\\[\\]`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]`]*?';
  const reflink = '!?\\[(' + boundedInline + ')\\]\\[(' + boundedBlock + ')\\]';
  const nolink = '!?\\[(' + boundedBlock + ')\\](?:\\[\\])?';
  return new RegExp(reflink + '|' + nolink + '(?!\\()', 'g');
})();

// Last delimiter run in `src` that can close emphasis/strong/del.
// A run can close only when not preceded by ASCII whitespace or the start.
function scanClosers(src) {
  let star = -1, under = -1, tilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else if (ch === '*') star = i;
      else under = i;
    }
    i = j - 1;
  }
  return { star, under, tilde };
}

function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(RE_BLOCK_SKIP)) {
    if (RE_LINK.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(RE_REFLINK_SEARCH)) {
    const m0 = m[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(m0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

// Hide links, code spans, html and escapes so emphasis/del do not see
// their delimiters. Length-preserving: emStrong lines maskedSrc up with src.
function maskSrc(src, links) {
  let masked = src;
  if (links && src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(text, links)) {
          return '[' + text.replace(RE_REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(RE_REFLINK_SEARCH, maskReflink);
  }
  masked = masked.replace(RE_ANY_PUNCT_OUTSIDE_CODE, (m0, code, punct) => {
    if (punct) return '+'.repeat(m0.length);
    if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return m0;
  });
  masked = masked.replace(RE_BLOCK_SKIP, (m0, a, empty, b) => {
    // marked keeps a code span's leading backticks in the mask.
    const o = b ? b.length : 0;
    return m0.slice(0, o) + '[' + 'a'.repeat(m0.length - o - 2) + ']';
  });
  return masked;
}

const RE_PUNCT_TEST = /^((?![*_])[\s\p{P}\p{S}])/u;
const RE_UNICODE_ALNUM = /[\p{L}\p{N}]/u;

// Emphasis / strong. Returns { raw, html } or null. `fullMask` is the masked
// whole run; `src` is the unconsumed remainder (same length relationship as
// marked: srcStart = fullMask.length - src.length).
function emStrong(src, fullMask, prevChar, ctx, st, closers, mode) {
  const m = EM_L_DELIM_GFM.exec(src);
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
  const delim = m[0][0];
  const midRun = prevChar === delim;
  const srcStart = fullMask.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && fullMask[runStart - 1] === delim) runStart--;
  const runPrevChar = [...fullMask.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!RE_PUNCT_TEST.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!RE_PUNCT_TEST.exec(prevChar);
  if (m[4] && RE_UNICODE_ALNUM.test(prevChar)) return null;
  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLen = [...m[0]].length - 1;
    let rDelim, rLen, delimTotal = lLen, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLen;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delim === '*' && !runPrevPunct));
    if (delim !== '*' && delim !== '_') return null;
    const endRe = delim === '*' ? EM_R_DELIM_AST_GFM : EM_R_DELIM_UND;
    const lastCloser = delim === '*' ? closers.star : closers.under;
    const winStart = fullMask.length - src.length + lLen;
    if (lastCloser < winStart) return null;
    const masked = fullMask.slice(-1 * src.length + lLen);
    const lastInWin = lastCloser - winStart;
    endRe.lastIndex = 0;
    let match;
    while ((match = endRe.exec(masked)) !== null) {
      if (match.index > lastInWin) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLen = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLen;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLen) % 3)) {
          midDelimTotal += rLen;
          continue;
        }
      }
      delimTotal -= rLen;
      if (delimTotal > 0) continue;
      rLen = Math.min(rLen, rLen + delimTotal + midDelimTotal);
      const lastCharLen = [...match[0]][0].length;
      const raw = src.slice(0, lLen + match.index + lastCharLen + rLen);
      if (Math.min(lLen, rLen) % 2) {
        const text = raw.slice(1, -1);
        const inner = inline(text, ctx, st, mode);
        return { raw, out: mode === 'text' ? inner : '<em>' + inner + '</em>' };
      }
      const text = raw.slice(2, -2);
      const inner = inline(text, ctx, st, mode);
      return { raw, out: mode === 'text' ? inner : '<strong>' + inner + '</strong>' };
    }
  }
  return null;
}

function del(src, fullMask, prevChar, ctx, st, closers, mode) {
  const m = DEL_L_DELIM.exec(src);
  if (!m) return null;
  const nextChar = m[1] || '';
  if (!nextChar || !prevChar || RE_PUNCT_TEST.exec(prevChar)) {
    const lLen = [...m[0]].length - 1;
    let rDelim, rLen, delimTotal = lLen;
    const lastCloser = closers.tilde;
    const winStart = fullMask.length - src.length + lLen;
    if (lastCloser < winStart) return null;
    const masked = fullMask.slice(-1 * src.length + lLen);
    const lastInWin = lastCloser - winStart;
    DEL_R_DELIM.lastIndex = 0;
    let match;
    while ((match = DEL_R_DELIM.exec(masked)) !== null) {
      if (match.index > lastInWin) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLen = [...rDelim].length;
      if (rLen !== lLen) continue;
      if (match[3] || match[4]) {
        delimTotal += rLen;
        continue;
      }
      delimTotal -= rLen;
      if (delimTotal > 0) continue;
      rLen = Math.min(rLen, rLen + delimTotal);
      const lastCharLen = [...match[0]][0].length;
      const raw = src.slice(0, lLen + match.index + lastCharLen + rLen);
      const text = raw.slice(lLen, -lLen);
      const inner = inline(text, ctx, st, mode);
      return { raw, out: mode === 'text' ? inner : '<del>' + inner + '</del>' };
    }
  }
  return null;
}

// --- inline tokenizers (direct rendering) ----------------------------------

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = RE_INLINE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = RE_TAG.exec(tokenSrc) || RE_AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Renders a link/image label (nested inline run) and applies marked's
// "no links inside links" rule. Returns { raw, out } or null when rejected.
function outputLink(cap, href, title, raw, ctx, st, mode) {
  const text = cap[1].replace(/\\([\[\]])/g, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = st.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = inline(text, ctx, st, isImage ? 'text' : mode);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      st.inRawBlock = outerInRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }
  if (mode === 'text') return { raw, out: inner };
  if (isImage) {
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return { raw, out: escapeHtml(inner) };
    let out = '<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(inner) + '"';
    if (title) out += ' title="' + escapeHtml(title) + '"';
    out += '>';
    return { raw, out };
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { raw, out: inner };
  let out = '<a href="' + escapeHtml(cleanHref) + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  out += '>' + inner + '</a>';
  return { raw, out };
}

function tryLink(src, ctx, st, mode) {
  if (st.linkParenPossible === false) return null;
  const cap = RE_LINK.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (trimmedUrl.charAt(0) === '<') {
    if (trimmedUrl.charAt(trimmedUrl.length - 1) !== '>') return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (href.charAt(0) === '<') href = href.slice(1, -1);
  return outputLink(cap,
    href ? href.replace(RE_ANY_PUNCT, '$1') : href,
    title ? title.replace(RE_ANY_PUNCT, '$1') : title,
    cap[0], ctx, st, mode);
}

function tryReflink(src, ctx, st, mode) {
  let cap = RE_REFLINK.exec(src);
  if (!cap) cap = RE_NOLINK.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    return { raw: ch, out: ch };
  }
  return outputLink(cap, link.href, link.title || null, cap[0], ctx, st, mode);
}

function tryAutolink(src, st, mode) {
  const cap = RE_AUTOLINK.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  if (mode === 'text') return { raw: cap[0], out: text };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { raw: cap[0], out: escapeHtml(text, true) };
  return { raw: cap[0], out: '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>' };
}

function tryUrl(src, st, mode) {
  let cap = RE_URL.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = RE_BACKPEDAL.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  if (mode === 'text') return { raw: cap[0], out: text };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { raw: cap[0], out: escapeHtml(text, true) };
  return { raw: cap[0], out: '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>' };
}

function renderInlineToken(src, ctx, st, mode, fullMask, closers, prevChar) {
  // Returns { raw, out } for the token starting at src[0], or null.
  let cap, r;
  if ((cap = RE_ESCAPE.exec(src))) {
    const text = cap[1];
    return { raw: cap[0], out: mode === 'text' ? text : escapeHtml(text) };
  }
  if ((cap = RE_TAG.exec(src))) {
    if (!st.inLink && /^<a /i.test(cap[0])) st.inLink = true;
    else if (st.inLink && /^<\/a>/i.test(cap[0])) st.inLink = false;
    if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(cap[0])) st.inRawBlock = true;
    else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(cap[0])) st.inRawBlock = false;
    return { raw: cap[0], out: cap[0] };
  }
  if ((r = tryLink(src, ctx, st, mode))) return r;
  if ((r = tryReflink(src, ctx, st, mode))) return r;
  if ((r = emStrong(src, fullMask, prevChar, ctx, st, closers, mode))) return r;
  if ((cap = RE_INLINE_CODE.exec(src))) {
    let text = cap[2].replace(/\n/g, ' ');
    const hasNonSpace = /[^ ]/.test(text);
    const hasSpaceBothEnds = text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ';
    if (hasNonSpace && hasSpaceBothEnds) text = text.substring(1, text.length - 1);
    return { raw: cap[0], out: mode === 'text' ? text : '<code>' + escapeHtml(text, true) + '</code>' };
  }
  if ((cap = RE_BR.exec(src))) {
    return { raw: cap[0], out: mode === 'text' ? '' : '<br>' };
  }
  if ((r = del(src, fullMask, prevChar, ctx, st, closers, mode))) return r;
  if ((r = tryAutolink(src, st, mode))) return r;
  if (!st.inLink && (r = tryUrl(src, st, mode))) return r;
  return null;
}

// Main inline renderer. `st` is the shared lexer state; `mode` is 'html'
// or 'text' (image alt text). Renders straight to a string, no tokens.
function inline(src, ctx, st, mode) {
  const prevLPP = st.linkParenPossible;
  st.linkParenPossible = prevLPP && src.includes(')');
  try {
    return inlineInner(src, ctx, st, mode);
  } finally {
    st.linkParenPossible = prevLPP;
  }
}

function inlineInner(src, ctx, st, mode) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const fullMask = needsMask ? maskSrc(src, ctx.links) : src;
  const closers = needsMask ? scanClosers(fullMask) : { star: -1, under: -1, tilde: -1 };
  let out = '';
  let keepPrev = false;
  let prevChar = '';
  while (src) {
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    const r = renderInlineToken(src, ctx, st, mode, fullMask, closers, prevChar);
    if (r) {
      src = src.slice(r.raw.length);
      out += r.out;
      continue;
    }
    const cap = RE_TEXT_GFM.exec(src);
    if (cap) {
      const raw = cap[0];
      src = src.slice(raw.length);
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      keepPrev = true;
      if (mode === 'text') {
        out += st.inRawBlock ? raw : decodeNumericRefs(raw);
      } else if (st.inRawBlock) {
        out += raw;
      } else {
        const text = decodeNumericRefs(raw);
        out += /[&<>"']/.test(text) ? escapeHtml(text) : text;
      }
      continue;
    }
    // Should not happen (text always matches a non-empty src), but guard
    // against an infinite loop the way marked does.
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return out;
}

// --- block parsing -----------------------------------------------------------
// Mirrors marked's block loop order: space, code, fences, heading, hr,
// blockquote, list, html, def, table, lheading, paragraph, text. Nodes are
// minimal objects; inline text is rendered later so every run sees the full
// link-definition map (marked's deferred inline queue).

const RE_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_HTML_BEGIN = new RegExp('^' + HTML_BEGIN_NL);
const RE_HR_LINE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const RE_BLOCKQUOTE_LINE = /^ {0,3}>/;
const RE_FENCES_LINE = /^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/;
const RE_LIST_INTERRUPT = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;
const RE_SETEXT_LINE = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_BULL_SPACE = /^ {0,3}(?:[*+-]|\d{1,9}[.)]) /;
const RE_DELIM_ROW = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;
// A line that looks like a table delimiter row (marked's lheading guard
// form, not the stricter RE_DELIM_ROW): such a line can never start, or
// continue, a setext heading.
const RE_TABLE_DELIM_GUARD = /^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/;
const RE_TRIM_TRAILING_BLANK = /\n[ \t]*\n[ \t]*$/;

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(/^\s+/);
    if (mi === null) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

function isTableStartAt(src, pos) {
  const eol = src.indexOf('\n', pos);
  if (eol === -1) return false;
  const header = src.slice(pos, eol);
  if (!/^ *[^ \n]/.test(header)) return false;
  const dStart = eol + 1;
  const dEol = src.indexOf('\n', dStart);
  const delimLine = (dEol === -1 ? src.slice(dStart) : src.slice(dStart, dEol)).replace(/[ \t]+$/, '');
  if (!RE_DELIM_ROW.test(delimLine)) return false;
  return !!RE_TABLE.exec(src.slice(pos));
}

// Paragraph / text / setext accumulation starting at src[0] (a non-blank
// line). Returns { k:'p'|'t'|'h', text, depth?, consumed }.
function parseTextBlock(src, top) {
  let pos = 0;
  const lines = [];
  let eol = src.indexOf('\n');
  let line = eol === -1 ? src : src.slice(0, eol);
  lines.push(line);
  // marked's lheading first-line guard: the paragraph's first line must not
  // be a table delimiter row (other first-line guards cannot occur here:
  // code/fences/heading/hr/blockquote/list/html are tried before this).
  let lheadingOk = !RE_TABLE_DELIM_GUARD.test(line);
  pos = eol === -1 ? src.length : eol + 1;
  while (pos < src.length) {
    const ls = pos;
    eol = src.indexOf('\n', pos);
    line = eol === -1 ? src.slice(pos) : src.slice(pos, eol);
    const nextPos = eol === -1 ? src.length : eol + 1;
    // A blank line ends the paragraph, except a whitespace-only line at
    // end of input: marked's paragraph lookahead needs a newline after the
    // spaces ([ \t]+\n), so a trailing run of spaces stays in the text.
    if (isBlank(line) && (line.length === 0 || eol !== -1)) break;
    const setext = RE_SETEXT_LINE.exec(line);
    if (setext && lheadingOk) {
      return { k: 'h', d: setext[1][0] === '=' ? 1 : 2, text: lines.join('\n').trim(), consumed: ls + line.length };
    }
    if (RE_HR_LINE.test(src.slice(ls))
      || RE_HEADING_LINE.test(src.slice(ls))
      || RE_BLOCKQUOTE_LINE.test(src.slice(ls))
      || RE_FENCES_LINE.test(src.slice(ls))
      || RE_LIST_INTERRUPT.test(src.slice(ls))
      || RE_HTML_BEGIN.test(src.slice(ls))) break;
    if (isTableStartAt(src, ls)) {
      // marked tries lheading before the paragraph's table interrupt: a
      // setext underline on the next line still forms a heading, unless
      // this line is itself a table delimiter row (lheading forbids those
      // as continuation lines).
      const nextEol = src.indexOf('\n', nextPos);
      const nextLine = nextEol === -1 ? src.slice(nextPos) : src.slice(nextPos, nextEol);
      if (!(lheadingOk && RE_SETEXT_LINE.test(nextLine) && !RE_TABLE_DELIM_GUARD.test(line))) break;
    }
    // marked's lheading guard on continuation lines is only the bullet
    // start (any bullet, even bare); an indented line does NOT block a
    // setext heading (blockCode is only in the first-line guard, and the
    // first line can never be indented code here).
    if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])/.test(line)) lheadingOk = false;
    lines.push(line);
    pos = nextPos;
    if (eol === -1) break;
  }
  const text = lines.join('\n');
  if (!top) return { k: 't', text: lines[0], consumed: lines[0].length };
  return { k: 'p', text, consumed: text.length };
}

// --- blockquote / list (mirror marked's Tokenizer) ---------------------------
// Blockquote and list nodes carry a `raw` string (marked's token raw) that
// the surrounding blockquote's merge logic needs; rendering ignores it.

const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_STRIP = /^ {0,3}>[ \t]?/gm;

function parseBlockquote(src, ctx) {
  const cap = RE_BLOCKQUOTE.exec(src);
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  const blocks = [];
  while (lines.length > 0) {
    let seen = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (RE_BQ_START.test(lines[p])) { chunk.push(lines[p]); seen = true; }
      else if (!seen) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h.replace(RE_BQ_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
      .replace(RE_BQ_SETEXT, '\n    $1')
      .replace(RE_BQ_STRIP, '');
    raw = raw ? raw + '\n' + h : h;
    blockParse(u, ctx, true, true, blocks);
    if (lines.length === 0) break;
    const last = blocks.at(-1);
    if (last && (last.k === 'code' || last.k === 'h' || last.k === 'hr' || last.k === 'html' || last.k === 'table')) break;
    if (last && last.k === 'bq') {
      const b = lines.join('\n');
      const m = last.raw + '\n' + b.replace(RE_BQ_STRIP, '');
      const f = parseBlockquote(m, ctx);
      if (!f) break;
      blocks[blocks.length - 1] = f;
      const y = m.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) raw = raw + '\n' + A.join('\n');
      lines = lines.slice(A.length);
      if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      break;
    } else if (last && last.k === 'list') {
      const b = last.raw + '\n' + lines.join('\n');
      const m = parseList(b, ctx);
      if (!m) continue;
      blocks[blocks.length - 1] = m;
      const f = m.raw.length > last.raw.length
        ? b.slice(last.raw.length + 1, m.raw.length).split('\n').length
        : 0;
      if (f > 0) raw = raw + '\n' + lines.slice(0, f).join('\n');
      lines = lines.slice(f);
      continue;
    }
  }
  return { k: 'bq', blocks, raw, rawLen: raw.length };
}

// List item continuation: marked builds one regex per content indent R and
// caches them; a tiny Map does the same here.
const _rxCache = new Map();
function rxFor(key, make) {
  let re = _rxCache.get(key);
  if (!re) { re = make(); _rxCache.set(key, re); }
  return re;
}
const RE_LIST_ITEM_RE = (bullet) => rxFor('li:' + bullet,
  () => new RegExp('^( {0,3}' + bullet + ')((?:[\\t ][^\\n]*)?(?:\\n|$))'));
const RE_NEXT_BULLET = (r) => rxFor('nb:' + r,
  () => new RegExp('^ {0,' + Math.max(0, Math.min(3, r - 1)) + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))'));
const RE_HR_R = (r) => rxFor('hr:' + r,
  () => new RegExp('^ {0,' + Math.max(0, Math.min(3, r - 1)) + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'));
const RE_FENCES_BEGIN = (r) => rxFor('fe:' + r,
  () => new RegExp('^ {0,' + Math.max(0, Math.min(3, r - 1)) + '}(?:```|~~~)'));
const RE_HEADING_BEGIN = (r) => rxFor('he:' + r,
  () => new RegExp('^ {0,' + Math.max(0, Math.min(3, r - 1)) + '}#{1,6}(?:\\s|$)'));
const RE_HTML_BEGIN_R = (r) => rxFor('ht:' + r,
  () => new RegExp('^ {0,' + Math.max(0, Math.min(3, r - 1)) + '}(?:</?(?:' + TAG + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'));
const RE_BQ_BEGIN = (r) => rxFor('bq:' + r,
  () => new RegExp('^ {0,' + Math.max(0, Math.min(3, r - 1)) + '}>'));
const RE_SETEXT_LINE_F = /^ {0,3}(?:=+|-+) *$/;
const RE_BLANK_LINE = /^[ \t]*$/;
const RE_LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const RE_DOUBLE_BLANK_END = /\n[ \t]*\n[ \t]*$/;
// marked's GFM lheading regex, used to decide whether a setext-looking line
// inside a list item is indented away instead of forming a heading.
const RE_LHEADING_TEST = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)])|(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)])| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;

function parseList(src, ctx) {
  const cap = RE_LIST.exec(src);
  if (!cap) return null;
  const full = src;
  let pos = 0;
  const bullet = cap[1].trim();
  const ordered = bullet.length > 1;
  const start = ordered ? +bullet.slice(0, -1) : '';
  const bulletPat = ordered ? '\\d{1,9}\\' + bullet.slice(-1) : '\\' + bullet;
  const itemRe = RE_LIST_ITEM_RE(bulletPat);
  const items = [];
  let loose = false;
  let p = false; // a previous item ended with a double blank line
  while (pos < full.length) {
    const rest = full.slice(pos);
    const t = itemRe.exec(rest);
    if (!t || RE_HR.test(rest)) break;
    const itemStart = pos;
    pos += t[0].length;
    const g = t[2].split('\n', 1)[0];
    const b = t[1].length;
    let m = g.replace(/^[ \t]+/, (v) => expandTabs(v, b));
    const f0 = full.slice(pos).split('\n', 1)[0];
    const y0 = !m.trim();
    let R;
    let d = '';
    let y = y0;
    let f = f0;
    let u = false;
    if (y) {
      R = b + 1;
    } else {
      R = m.search(/[^ ]/);
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    if (y && RE_BLANK_LINE.test(f)) {
      pos += f.length + 1;
      u = true;
    }
    if (!u) {
      const nextBullet = RE_NEXT_BULLET(R);
      const hrR = RE_HR_R(R);
      const fencesR = RE_FENCES_BEGIN(R);
      const headingR = RE_HEADING_BEGIN(R);
      const htmlR = RE_HTML_BEGIN_R(R);
      const bqR = RE_BQ_BEGIN(R);
      while (pos < full.length) {
        const U = full.slice(pos).split('\n', 1)[0];
        f = U;
        const Z = f.replace(/^[ \t]+/, (me) => expandTabs(me));
        if (fencesR.test(f) || headingR.test(f) || htmlR.test(f) || bqR.test(f) || nextBullet.test(f) || hrR.test(f)) break;
        if (Z.search(/[^ ]/) >= R || !f.trim()) {
          d += '\n' + Z.slice(R);
        } else {
          if (y || m.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || fencesR.test(m) || headingR.test(m) || htmlR.test(m) || hrR.test(m)) break;
          const qe = RE_SETEXT_LINE_F.test(f) && RE_LHEADING_TEST.test(m + '\n' + f)
            ? '    ' + Z.replace(/^ {0,3}/, '')
            : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        pos += U.length + 1;
        m = Z.slice(R);
      }
    }
    const A = full.slice(itemStart, pos);
    if (!loose) {
      if (p) loose = true;
      else if (RE_DOUBLE_BLANK_END.test(A)) p = true;
    }
    items.push({ task: RE_LIST_IS_TASK.test(d), loose: false, text: d, raw: A, blocks: null, checked: false, hadLooseSpacer: false });
  }
  const lastItem = items.at(-1);
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  const raw = full.slice(0, pos).trimEnd();
  for (const item of items) {
    const blocks = [];
    const res = blockParse(item.text, ctx, false, false, blocks);
    item.blocks = blocks;
    item.hadLooseSpacer = res.hadLooseSpacer;
    if (!loose && res.hadLooseSpacer) loose = true;
  }
  for (const item of items) {
    const first = item.blocks[0];
    if (item.task && (first?.k === 't' || first?.k === 'p')) {
      const tm = /^\[([ xX])\]/.exec(item.text);
      if (tm) item.checked = tm[1] !== ' ';
      item.text = item.text.replace(RE_LIST_TASK_STRIP, '');
      first.text = first.text.replace(RE_LIST_TASK_STRIP, '');
    } else if (item.task) {
      item.task = false;
    }
  }
  if (loose) for (const item of items) item.loose = true;
  return { k: 'list', ordered, start, loose, items, raw, rawLen: raw.length };
}

// The block loop. `out` is the shared node array; `canMerge` lets the first
// paragraph created here merge into out's last paragraph (blockquote
// continuation). Returns { hadLooseSpacer, endedWithSpace } for the caller.
function blockParse(src, ctx, top, canMerge, out) {
  let clip = canMerge;
  let hadLooseSpacer = false;
  let endedWithSpace = false;
  let guard = Infinity;
  while (src) {
    if (src.length >= guard) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    guard = src.length;
    let cap;
    // space
    if ((cap = RE_NEWLINE.exec(src))) {
      src = src.slice(cap[0].length);
      const last = out.at(-1);
      if (cap[0].length === 1 && last !== undefined) {
        endedWithSpace = false;
      } else {
        if (/\n.*\n/.test(cap[0])) hadLooseSpacer = true;
        endedWithSpace = true;
        // marked pushes a space token here; it renders nothing, but it is
        // the last token, so a following code/def/text/paragraph cannot
        // merge into the block before it.
        out.push({ k: 'space' });
      }
      continue;
    }
    endedWithSpace = false;
    // indented code
    if ((cap = RE_CODE.exec(src))) {
      const raw = trimTrailingBlankLines(cap[0]);
      const text = raw.replace(RE_CODE_REMOVE_INDENT, '');
      src = src.slice(raw.length);
      const last = out.at(-1);
      if (last && (last.k === 'p' || last.k === 't')) last.text += '\n' + text;
      else out.push({ k: 'code', text });
      continue;
    }
    // fences
    if ((cap = RE_FENCES.exec(src))) {
      const raw = cap[0];
      const text = indentCodeCompensation(raw, cap[3] || '');
      const lang = cap[2] ? cap[2].trim().replace(RE_ANY_PUNCT, '$1') : cap[2];
      src = src.slice(raw.length);
      out.push({ k: 'code', text, lang });
      continue;
    }
    // ATX heading
    if ((cap = RE_HEADING.exec(src))) {
      let text = cap[2].trim();
      if (/#$/.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || /[ \t]$/.test(trimmed)) text = trimmed.trim();
      }
      src = src.slice(rtrim(cap[0], '\n').length);
      out.push({ k: 'h', d: cap[1].length, text });
      continue;
    }
    // hr
    if ((cap = RE_HR.exec(src))) {
      src = src.slice(rtrim(cap[0], '\n').length);
      out.push({ k: 'hr' });
      continue;
    }
    // blockquote
    let node;
    if ((node = parseBlockquote(src, ctx))) {
      src = src.slice(node.rawLen);
      out.push(node);
      continue;
    }
    // list
    if ((node = parseList(src, ctx))) {
      src = src.slice(node.rawLen);
      out.push(node);
      continue;
    }
    // html block
    if ((cap = RE_HTML.exec(src))) {
      const raw = trimTrailingBlankLines(cap[0]);
      src = src.slice(raw.length);
      out.push({ k: 'html', text: raw });
      continue;
    }
    // link reference definition
    if ((cap = RE_DEF.exec(src))) {
      if (cap[2].charAt(0) !== '<' && findClosingBracket(cap[2], '()') !== -1) {
        // not a definition; fall through to paragraph/text
      } else {
        const raw = rtrim(cap[0], '\n');
        const tag = normalizeLabel(cap[1]);
        const href = cap[2] ? cap[2].replace(/^<(.*)>$/, '$1').replace(RE_ANY_PUNCT, '$1') : '';
        const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(RE_ANY_PUNCT, '$1') : cap[3];
        src = src.slice(raw.length);
        const last = out.at(-1);
        if (last && (last.k === 'p' || last.k === 't')) last.text += '\n' + raw;
        else if (!ctx.links[tag]) ctx.links[tag] = { href, title };
        continue;
      }
    }
    // table (gfm)
    if ((cap = RE_TABLE.exec(src))) {
      if (cap[2].includes('|') || cap[2].includes(':')) {
        const headers = splitCells(cap[1]);
        const aligns = cap[2].replace(/^\||\| *$/g, '').split('|');
        const rows = cap[3] && cap[3].trim() ? cap[3].replace(/\n[ \t]*$/, '').split('\n') : [];
        if (headers.length === aligns.length) {
          const align = aligns.map((a) => {
            if (/^ *-+: *$/.test(a)) return 'right';
            if (/^ *:-+: *$/.test(a)) return 'center';
            if (/^ *:-+ *$/.test(a)) return 'left';
            return null;
          });
          const header = headers.map((h, i) => ({ text: h, align: align[i] }));
          const body = rows.map((row) => splitCells(row, header.length).map((cell, i) => ({ text: cell, align: align[i] })));
          src = src.slice(rtrim(cap[0], '\n').length);
          out.push({ k: 'table', header, rows: body });
          continue;
        }
      }
      // not a table: fall through to paragraph/text
    }
    // paragraph / text / setext heading
    const res = parseTextBlock(src, top);
    if (res) {
      if (res.k === 'p') {
        const last = out.at(-1);
        if (clip && last && last.k === 'p') last.text += '\n' + res.text;
        else out.push(res);
        clip = false;
      } else if (res.k === 't') {
        const last = out.at(-1);
        if (last && last.k === 't') last.text += '\n' + res.text;
        else out.push(res);
      } else {
        out.push(res);
      }
      src = src.slice(res.consumed);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return { hadLooseSpacer, endedWithSpace };
}

// --- rendering ---------------------------------------------------------------

function runInline(text, ctx, st, mode) {
  st.inRawBlock = false;
  return inline(text, ctx, st, mode);
}

function renderBlocks(nodes, ctx, st) {
  let out = '';
  for (const node of nodes) out += renderBlock(node, ctx, st);
  return out;
}

function renderBlock(node, ctx, st) {
  switch (node.k) {
    case 'space':
      return '';
    case 'p':
      return '<p>' + runInline(node.text, ctx, st, 'html') + '</p>\n';
    case 't':
      return runInline(node.text, ctx, st, 'html');
    case 'h':
      return '<h' + node.d + '>' + runInline(node.text, ctx, st, 'html') + '</h' + node.d + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      const langString = (node.lang || '').match(/^\S*/)?.[0];
      const code = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
      if (!langString) return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
      return '<pre><code class="language-' + escapeHtml(langString) + '">' + escapeHtml(code, true) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'bq':
      return '<blockquote>\n' + renderBlocks(node.blocks, ctx, st) + '</blockquote>\n';
    case 'list': {
      let body = '';
      for (const item of node.items) body += renderListItem(item, node, ctx, st);
      const type = node.ordered ? 'ol' : 'ul';
      const startAttr = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
    }
    case 'table': {
      let header = '';
      for (const cell of node.header) header += renderTableCell(cell, true, ctx, st);
      header = '<tr>\n' + header + '</tr>\n';
      let body = '';
      for (const row of node.rows) {
        let cells = '';
        for (const cell of row) cells += renderTableCell(cell, false, ctx, st);
        body += '<tr>\n' + cells + '</tr>\n';
      }
      if (body) body = '<tbody>' + body + '</tbody>';
      return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
    }
    default:
      return '';
  }
}

function renderTableCell(cell, isHeader, ctx, st) {
  const tag = isHeader ? 'th' : 'td';
  const open = cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>';
  return open + runInline(cell.text, ctx, st, 'html') + '</' + tag + '>\n';
}

function renderListItem(item, list, ctx, st) {
  const checkbox = item.task
    ? '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
    : '';
  const blocks = item.blocks;
  let body = '';
  if (item.task && list.loose) {
    const first = blocks[0];
    if (first && (first.k === 'p' || first.k === 't')) {
      body += '<p>' + checkbox + runInline(first.text, ctx, st, 'html') + '</p>\n';
      for (let i = 1; i < blocks.length; i++) body += renderListItemBlock(blocks[i], item, ctx, st);
    } else {
      body += '<p>' + checkbox + '</p>';
      for (const b of blocks) body += renderListItemBlock(b, item, ctx, st);
    }
  } else {
    if (checkbox) body += checkbox;
    for (const b of blocks) body += renderListItemBlock(b, item, ctx, st);
  }
  return '<li>' + body + '</li>\n';
}

function renderListItemBlock(block, item, ctx, st) {
  if (block.k === 't') {
    return item.loose
      ? '<p>' + runInline(block.text, ctx, st, 'html') + '</p>\n'
      : runInline(block.text, ctx, st, 'html');
  }
  return renderBlock(block, ctx, st);
}

/** The HTML marked 18.1.3 renders for `markdown` with default options. */
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const ctx = { links: Object.create(null) };
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  const nodes = [];
  blockParse(src, ctx, true, false, nodes);
  return renderBlocks(nodes, ctx, st);
}
