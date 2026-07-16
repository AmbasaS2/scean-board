import { extension_settings, getContext } from '../../../../scripts/extensions.js';

const EXT_NAME = 'scene-board';
const DISPLAY_NAME = '🧭 Scene Board';
const VERSION = '1.0.7';
const ctx = getContext();
const UI_PREFIX = EXT_NAME === 'scene-board-beta' ? 'sbb' : 'sb';
const MESSAGE_EDIT_SELECTOR = '.mes_edit,.edit_mes,.mes_edit_button,[class*="mes_edit"],[class*="edit_mes"]';
const MAX_RECENT_BOARDS = 3;

const defaults = {
  enabled: true,
  autoParse: true,
  hideOriginal: true,
  fontSize: 13,
  autoLineBreak: true,
  hideChatNumber: false,
  recentByCharacter: {},
  boardsByCharacter: {},
  clearedAtByCharacter: {},
  clearedAllAt: 0,
  activeCharacterFilter: 'all',
};

if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
let settings = Object.assign({}, defaults, extension_settings[EXT_NAME]);
settings.recentByCharacter = settings.recentByCharacter && typeof settings.recentByCharacter === 'object' ? settings.recentByCharacter : {};
settings.boardsByCharacter = settings.boardsByCharacter && typeof settings.boardsByCharacter === 'object' ? settings.boardsByCharacter : {};
settings.clearedAtByCharacter = settings.clearedAtByCharacter && typeof settings.clearedAtByCharacter === 'object' && !Array.isArray(settings.clearedAtByCharacter) ? settings.clearedAtByCharacter : {};
settings.clearedAllAt = Math.max(0, Number(settings.clearedAllAt || 0));
settings.fontSize = Math.max(11, Math.min(18, Number(settings.fontSize || 13)));
settings.autoLineBreak = settings.autoLineBreak !== false;
settings.hideChatNumber = settings.hideChatNumber === true;
// Scene Board is intentionally a single-switch extension: enabled means parse latest reply and separate the trailing board.
settings.autoParse = true;
settings.hideOriginal = true;
if (settings.activeCharacterFilter === 'current') settings.activeCharacterFilter = 'all';
if (Object.hasOwn(settings, 'includeNext')) delete settings.includeNext;
if (Object.hasOwn(settings, 'builtInDesign')) delete settings.builtInDesign;

let saveTimer = null;
let currentRecentIndex = 0;
let lastInlinePayload = null;

const RUNTIME_KEY = `__sceneBoardRuntime_${EXT_NAME}`;
const runtime = window[RUNTIME_KEY] || (window[RUNTIME_KEY] = {
  eventBindings: [],
  externalUpdateHandler: null,
  settingsSaveReady: false,
  pendingSettingsSave: false,
  pendingSettingsSaveNow: false,
});
if (runtime.settingsSaveReady !== true) runtime.settingsSaveReady = false;
if (runtime.pendingSettingsSave !== true) runtime.pendingSettingsSave = false;
if (runtime.pendingSettingsSaveNow !== true) runtime.pendingSettingsSaveNow = false;

function offEventSourceBinding(binding) {
  if (!binding?.source || !binding?.event || !binding?.handler) return;
  try {
    if (typeof binding.source.off === 'function') binding.source.off(binding.event, binding.handler);
    else if (typeof binding.source.removeListener === 'function') binding.source.removeListener(binding.event, binding.handler);
    else if (typeof binding.source.removeEventListener === 'function') binding.source.removeEventListener(binding.event, binding.handler);
  } catch {}
}
function teardownRuntimeEvents() {
  try {
    if (runtime.externalUpdateHandler) document.removeEventListener('scene-board:external-update', runtime.externalUpdateHandler);
  } catch {}
  runtime.externalUpdateHandler = null;
  if (Array.isArray(runtime.eventBindings)) runtime.eventBindings.forEach(offEventSourceBinding);
  runtime.eventBindings = [];
}
function bindRuntimeEvent(source, event, handler) {
  if (!source || !event || typeof source.on !== 'function' || typeof handler !== 'function') return;
  try {
    source.on(event, handler);
    runtime.eventBindings.push({ source, event, handler });
  } catch {}
}

function liveContext() { return window.SillyTavern?.getContext?.() || ctx || {}; }
function esc(value = '') { return String(value).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function plain(value = '') { const d = document.createElement('div'); d.innerHTML = String(value || ''); return d.textContent || d.innerText || ''; }
function norm(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function uid(prefix = 'sb') { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function hash(value = '') { let h = 2166136261; const s = String(value || ''); for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); } return (h>>>0).toString(36); }
function clampFontSize(value) { return Math.max(11, Math.min(18, Number(value || 13))); }
function toast(message, tone = 'info') {
  try {
    const api = window.toastr || ctx?.toastr;
    if (api) {
      const method = tone === 'error' ? 'error' : tone === 'warn' ? 'warning' : tone === 'success' ? 'success' : 'info';
      if (typeof api[method] === 'function') { api[method](String(message || '')); return; }
    }
  } catch {}
}
function settingsSaveCanStart() {
  if (runtime.settingsSaveReady === true) return true;
  try {
    const live = liveContext();
    if (document.readyState === 'complete' && Array.isArray(live?.chat)) {
      runtime.settingsSaveReady = true;
      return true;
    }
  } catch {}
  return false;
}
function commitSettingsSave(now = false) {
  clearTimeout(saveTimer);
  const run = () => {
    try {
      if (now && typeof ctx?.saveSettings === 'function') ctx.saveSettings();
      else ctx?.saveSettingsDebounced?.();
    } catch (e) { console.error('[Scene Board] save failed', e); }
  };
  if (now) run(); else saveTimer = setTimeout(run, 180);
}
function markSettingsSaveReady() {
  runtime.settingsSaveReady = true;
  if (!runtime.pendingSettingsSave) return;
  const now = runtime.pendingSettingsSaveNow === true;
  runtime.pendingSettingsSave = false;
  runtime.pendingSettingsSaveNow = false;
  commitSettingsSave(now);
}
function saveSettings(now = false) {
  clearTimeout(saveTimer);
  try {
    settings.fontSize = clampFontSize(settings.fontSize);
    extension_settings[EXT_NAME] = Object.assign({}, settings);
  } catch (e) {
    console.error('[Scene Board] settings snapshot failed', e);
    return;
  }
  if (!settingsSaveCanStart()) {
    runtime.pendingSettingsSave = true;
    runtime.pendingSettingsSaveNow = runtime.pendingSettingsSaveNow || now;
    return;
  }
  commitSettingsSave(now);
}
function persistChat() {
  try {
    if (typeof ctx?.saveChatDebounced === 'function') ctx.saveChatDebounced();
    else if (typeof ctx?.saveChat === 'function') ctx.saveChat();
    else if (typeof window.saveChatDebounced === 'function') window.saveChatDebounced();
    else if (typeof window.saveChat === 'function') window.saveChat();
  } catch (e) { console.warn('[Scene Board] chat save skipped', e); }
}

function cleanName(value = '') {
  const out = norm(String(value || '').replace(/🧭/g, ''));
  return /sillytavern\s*system/i.test(out) ? '' : out;
}
function currentCharacterName() {
  const live = liveContext();
  const id = live.characterId ?? ctx?.characterId;
  const chars = live.characters || ctx?.characters || [];
  const fromList = (id !== undefined && id !== null && id !== '') ? (chars?.[id]?.name || chars?.[id]?.data?.name || '') : '';
  return cleanName(live.character?.name || ctx?.character?.name || fromList || live.name2 || ctx?.name2 || '') || 'Current Character';
}
function currentCharacterKey() {
  const live = liveContext();
  const id = live.characterId ?? ctx?.characterId;
  const chars = live.characters || ctx?.characters || [];
  const charObj = (id !== undefined && id !== null && id !== '') ? (chars?.[id] || {}) : {};
  const name = currentCharacterName();
  const avatar = charObj.avatar || charObj.data?.avatar || charObj.filename || charObj.file_name || '';
  if (id !== undefined && id !== null && id !== '') return `char:${id}:${name}`;
  if (avatar) return `avatar:${avatar}:${name}`;
  return `name:${name}`;
}
function currentChatKey() {
  const live = liveContext();
  const id = live.characterId ?? ctx?.characterId ?? currentCharacterName();
  const chatName = live.chatId || live.chat_id || live.chatName || live.chat_name || live.chatFile || live.currentChatId || 'current';
  return hash(`${id}::${chatName}`);
}
function stripOriginalMes(entry = {}) {
  const copy = Object.assign({}, entry || {});
  delete copy.originalMes;
  return copy;
}
function ensureCharacterStores(charKey = currentCharacterKey()) {
  if (!settings.recentByCharacter[charKey] || !Array.isArray(settings.recentByCharacter[charKey])) settings.recentByCharacter[charKey] = [];
  if (!settings.boardsByCharacter[charKey] || !Array.isArray(settings.boardsByCharacter[charKey])) settings.boardsByCharacter[charKey] = [];
  if (settings.recentByCharacter[charKey].length > MAX_RECENT_BOARDS) settings.recentByCharacter[charKey] = settings.recentByCharacter[charKey].slice(0, MAX_RECENT_BOARDS);
  return { recent: settings.recentByCharacter[charKey], saved: settings.boardsByCharacter[charKey] };
}
function applyFontSize() {
  try { document.documentElement.style.setProperty('--sb-user-font-size', `${clampFontSize(settings.fontSize)}px`); } catch {}
}

function fallbackMessageHtml(markdown = '') {
  const raw = String(markdown || '');
  const parts = raw.split(/```/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `<pre><code>${esc(part).replace(/^\w+\n/, '')}</code></pre>`;
    return esc(part).replace(/\n/g, '<br>');
  }).join('');
}
function renderMessageHtml(markdown, payload) {
  try {
    const formatter = ctx?.messageFormatting || window?.messageFormatting;
    if (typeof formatter === 'function') {
      const out = formatter(String(markdown || ''), payload?.source || currentCharacterName(), payload?.msg?.is_system || false, payload?.msg?.is_user || false);
      if (out) return out;
    }
  } catch {}
  return fallbackMessageHtml(markdown);
}
function setMessageText(payload, value) {
  if (!payload?.textEl?.length) return;
  payload.textEl.html(renderMessageHtml(value, payload));
}
function readableFromHtmlish(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  if (!/[<][a-zA-Z!/]/.test(raw)) return raw;
  const box = document.createElement('div');
  box.innerHTML = raw;
  box.querySelectorAll('pre').forEach((node) => {
    const code = node.querySelector('code');
    const text = (code || node).textContent || '';
    node.replaceWith(document.createTextNode('\n```\n' + text.trim() + '\n```\n'));
  });
  box.querySelectorAll('code').forEach((node) => {
    const text = node.textContent || '';
    node.replaceWith(document.createTextNode('`' + text.trim() + '`'));
  });
  box.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
  box.querySelectorAll('p, div, li').forEach(el => { if (el.nextSibling) el.appendChild(document.createTextNode('\n')); });
  return (box.textContent || box.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
}
function messageSourceText(raw = '', textEl = null) {
  const source = String(raw || '');
  if (source) return readableFromHtmlish(source) || plain(source);
  const html = textEl?.html?.() || '';
  return readableFromHtmlish(html) || plain(html || textEl?.text?.() || '');
}
function messagePayloadFromElement(mes) {
  if (!mes || !mes.matches?.('.mes')) return null;
  if ($(mes).closest('.sb-popover,.sb-modal-backdrop,#scene-board-settings,#extensions_settings,#extensions_settings2').length) return null;
  const textEl = $(mes).find('.mes_text').first();
  if (!textEl.length) return null;
  const idxRaw = mes.getAttribute('mesid') || mes.getAttribute('data-mesid') || mes.dataset?.mesid || '';
  const idx = Number(idxRaw);
  const live = liveContext();
  const msg = Number.isFinite(idx) ? (live?.chat?.[idx] || ctx?.chat?.[idx] || null) : null;
  if (msg?.is_system) return null;
  const isUser = msg?.is_user === true || mes.classList.contains('user_mes') || $(mes).hasClass('user_mes');
  const source = cleanName(msg?.name || $(mes).find('.name_text .ch_name, .name_text, .mes_name, .name').first().text()) || currentCharacterName();
  const text = messageSourceText(msg?.mes || '', textEl);
  return { mes, textEl, idx, msg, isUser, source, text };
}
function messagePayloadFromTarget(target) {
  const mes = target?.closest?.('.mes');
  return messagePayloadFromElement(mes);
}
function payloadFromEventArgs(args = []) {
  for (const arg of args) {
    if (!arg) continue;
    if (arg?.nodeType === 1 && arg?.matches?.('.mes')) return messagePayloadFromElement(arg);
    if (arg?.target?.nodeType === 1) {
      const p = messagePayloadFromTarget(arg.target);
      if (p) return p;
    }
    const idxCandidate = Number(arg?.mesid ?? arg?.messageId ?? arg?.index ?? arg?.id ?? arg);
    if (Number.isFinite(idxCandidate)) {
      const el = document.querySelector(`.mes[mesid="${idxCandidate}"], .mes[data-mesid="${idxCandidate}"]`);
      if (el) return messagePayloadFromElement(el);
    }
  }
  return null;
}
function latestCharacterPayload() {
  const list = Array.from(document.querySelectorAll('.mes'));
  for (let i = list.length - 1; i >= 0; i--) {
    const payload = messagePayloadFromElement(list[i]);
    if (payload && !payload.isUser) return payload;
  }
  return null;
}


function originalMessageBackup(payload) {
  const scene = payload?.msg?.extra?.sceneBoard;
  if (!scene) return '';
  const charKey = scene.characterKey || currentCharacterKey();
  const chatKey = scene.chatKey || currentChatKey();
  const messageId = String(scene.messageId || messageIdForPayload(payload) || '');
  const found = recentList(charKey).find((entry) => {
    if (!entry?.originalMes) return false;
    if (entry.chatKey && chatKey && entry.chatKey !== chatKey) return false;
    if (entry.messageId && messageId && String(entry.messageId) !== messageId) return false;
    return sameEntry(entry, scene);
  });
  return String(found?.originalMes || '').trimEnd();
}
function shouldSkipRestoredMessage(msg, source = '') {
  const marker = String(msg?.extra?.sceneBoardRestoredHash || '');
  if (!marker) return false;
  const currentHash = hash(String(source || '').trimEnd());
  if (currentHash === marker) return true;
  try { delete msg.extra.sceneBoardRestoredHash; } catch {}
  persistChat();
  return false;
}
function ensureRestoreButton(mes) {
  if (!mes?.matches?.('.mes')) return false;
  const payload = messagePayloadFromElement(mes);
  const $mes = $(mes);
  const existing = $mes.find('.sb-restore-original-btn').first();
  const canRestore = !!(payload?.msg?.extra?.sceneBoard && originalMessageBackup(payload));
  if (!canRestore) {
    existing.remove();
    return false;
  }
  if (existing.length) return true;
  const edit = $mes.find(MESSAGE_EDIT_SELECTOR).first();
  if (!edit.length) return false;
  const button = $('<div class="mes_button sb-restore-original-btn interactable" role="button" tabindex="0" title="씬보드 분리 전 원문으로 복구" aria-label="씬보드 분리 전 원문으로 복구">복구</div>');
  edit.after(button);
  return true;
}
function syncRestoreButtonsFromRecent() {
  try {
    $('.sb-restore-original-btn').remove();
    const entries = currentChatRecentList().slice(0, MAX_RECENT_BOARDS);
    for (const entry of entries) {
      if (!String(entry?.originalMes || '').trimEnd()) continue;
      const idx = Number(entry?.messageIndex);
      if (!Number.isFinite(idx)) continue;
      const mes = document.querySelector(`.mes[mesid="${idx}"], .mes[data-mesid="${idx}"]`);
      if (mes) ensureRestoreButton(mes);
    }
  } catch {}
}
function removeRecentForRestoredMessage(payload, scene = {}) {
  const charKey = scene?.characterKey || currentCharacterKey();
  const chatKey = scene?.chatKey || currentChatKey();
  const messageId = String(scene?.messageId || messageIdForPayload(payload) || '');
  const store = recentList(charKey);
  settings.recentByCharacter[charKey] = store.filter((entry) => {
    if (scene?.text && sameEntry(entry, scene)) return false;
    return !(entry?.chatKey === chatKey && messageId && String(entry?.messageId || '') === messageId);
  });
  if (charKey === currentCharacterKey()) {
    const list = currentChatRecentList(charKey);
    currentRecentIndex = Math.min(currentRecentIndex, Math.max(0, list.length - 1));
  }
}
function restoreOriginalMessage(payload) {
  const msg = payload?.msg;
  if (!msg || payload?.isUser) return false;
  const original = originalMessageBackup(payload);
  if (!original) {
    toast('복구할 원문을 찾지 못했습니다.', 'warn');
    return false;
  }
  if (!confirm('씬보드 분리 전 원문으로 복구할까요?\n이 메시지의 분리된 씬보드 카드는 제거되며, 보관함에 따로 저장한 카드는 유지됩니다.')) return false;

  const scene = Object.assign({}, msg.extra?.sceneBoard || {});
  msg.extra = msg.extra || {};
  msg.mes = original;
  msg.extra.sceneBoardRestoredHash = hash(original);
  try { delete msg.extra.sceneBoard; } catch {}
  try { delete msg.extra.sceneBoardOriginalMes; } catch {}
  // A translated display copy can otherwise cover the restored source after reload.
  // Translation caches remain untouched; only the currently forced display text is cleared.
  try { delete msg.extra.display_text; } catch {}

  removeRecentForRestoredMessage(payload, scene);
  setMessageText(payload, original);
  persistChat();
  saveSettings(true);
  refreshScenePrompt();
  renderInlinePanel();
  syncRestoreButtonsFromRecent();
  toast('분리 전 원문으로 복구했습니다.', 'success');
  return true;
}

const EXPLICIT_TAG_RE = /^(?:scene[-_ ]?board|scene[-_ ]?slate|scene[-_ ]?state|state[-_ ]?panel|status[-_ ]?panel|status|state|slate|infoboard|info[-_ ]?board|info[-_ ]?panel|hud|yaml|json|markdown|md|text)\b/i;
const TIME_LABEL_RE = /(?:📅|🗓|⏰|🕰|🕒|\b(?:time|date|day|datetime|timestamp|timeline|hour|when|season|current\s*time|scene\s*time|story\s*time|in[-\s]?story\s*time)\b|시간|날짜|일시|시각|요일|계절|현재\s*시간|배경\s*시간|작중\s*시간)/i;
const PLACE_LABEL_RE = /(?:📍|🧭|🏠|🏫|🏰|\b(?:location|place|setting|scene|background|where|venue|area|position|corridor|room|hall|street|current\s*location|current\s*place)\b|위치|장소|현재\s*위치|배경|무대|공간|지역|복도|방|홀|거리)/i;
const EXTRA_LABEL_RE = /(?:🌙|☀️|⛅|🌧|🌦|❄️|🔥|\b(?:characters?|cast|participants?|people|outfits?|clothes?|clothing|inventory|items?|belongings|mood|atmosphere|emotion|weather|status|state|relationship|quest|objective|summary|notes?)\b|등장인물|인물|캐릭터|복장|의상|소지품|물건|분위기|감정|기분|상태|날씨|관계|퀘스트|목표|요약|메모)/i;
const KEY_LINE_RE = /^\s*(?:[-*+]\s*)?(?:[\[【(（]\s*)?[A-Za-z가-힣 _\-/]{1,42}(?:\s*[\]】)）])?\s*[:：|=\-]/;
const PANEL_WRAPPER_RE = /^\s*<Info_panel>\s*([\s\S]*?)\s*<\/Info_panel>\s*$/i;
const BRACKET_LABEL_SEGMENT_RE = /[\[【(（]\s*[^\]】)）\n]{1,48}\s*[:：|=\-]\s*[^\[【\n]*[\]】)）]/g;
function stripPanelWrapper(value = '') {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  const m = text.match(PANEL_WRAPPER_RE);
  return m ? String(m[1] || '').trim() : text;
}
function stripFenceWrapper(value = '') {
  let text = stripPanelWrapper(value);
  const m = text.match(/^\s*```([^\n`]*)\n([\s\S]*?)\n?```\s*$/);
  if (!m) return text;
  return stripPanelWrapper(String(m[2] || '').trimEnd());
}
function originalFenceTag(value = '') {
  const m = String(value || '').match(/^\s*```([^\n`]*)/);
  return m ? String(m[1] || '').trim() : '';
}
function splitInlineRowMarkers(line = '') {
  const raw = String(line || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/\s+(?=(?:[📅🗓⏰🕰🕒📍🧭🏠🏫🏰]|(?:Date|날짜|Time|시간|Location|Place|장소|위치|Weather|날씨)\s*[:：]))/g)
    .map(x => x.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [];
}
function hasInlineLabelValue(line = '') {
  const raw = String(line || '').trim();
  if (!raw) return false;
  // Keep `Label: value` together. Auto line break may split rows by pipes/markers,
  // but it must not turn `Soundtrack: song` into `Soundtrack:` + `song`.
  return /^\s*(?:[-*+]\s*)?(?:[\[【(（]\s*)?[A-Za-z가-힣 _\-/]{1,42}(?:\s*[\]】)）])?\s*[:：]\s*\S/.test(raw);
}
function splitSceneBoardLine(line = '') {
  const raw = String(line || '').trim();
  if (!raw) return [];
  const bracketed = raw.match(BRACKET_LABEL_SEGMENT_RE);
  if (bracketed && bracketed.length >= 2) return bracketed.map(x => x.trim());
  const piped = raw.split(/\s+\|\s+/).map(x => x.trim()).filter(Boolean);
  if (piped.length >= 2) {
    const keyed = piped.filter(x => KEY_LINE_RE.test(x) || TIME_LABEL_RE.test(x) || PLACE_LABEL_RE.test(x) || EXTRA_LABEL_RE.test(x)).length;
    if (keyed >= 1) {
      const out = [];
      for (const part of piped) {
        if (hasInlineLabelValue(part)) {
          out.push(part);
          continue;
        }
        const markerParts = splitInlineRowMarkers(part);
        out.push(...(markerParts.length ? markerParts : [part]));
      }
      return out;
    }
  }
  if (hasInlineLabelValue(raw)) return [];
  const markerParts = splitInlineRowMarkers(raw);
  if (markerParts.length) return markerParts;
  return [];
}
function sceneBoardLines(value = '') {
  const text = stripFenceWrapper(value);
  const out = [];
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const raw = String(line || '').trim();
    if (!raw) continue;
    const parts = splitSceneBoardLine(raw);
    if (parts.length) out.push(...parts);
    else out.push(raw);
  }
  return out;
}
function labelStats(block = '') {
  const lines = sceneBoardLines(block);
  let time = false, place = false, extra = 0, keyLines = 0;
  for (const line of lines) {
    if (KEY_LINE_RE.test(line)) keyLines++;
    if (TIME_LABEL_RE.test(line)) time = true;
    if (PLACE_LABEL_RE.test(line)) place = true;
    if (EXTRA_LABEL_RE.test(line)) extra++;
  }
  return { lines, time, place, extra, keyLines };
}
function looksLikeSceneBoard(block = '', tag = '') {
  const raw = String(block || '').trim();
  if (!raw) return false;
  if (raw.length > 6000) return false;
  const stats = labelStats(raw);
  if (stats.lines.length < 1 || stats.lines.length > 60) return false;
  const explicit = EXPLICIT_TAG_RE.test(String(tag || originalFenceTag(raw) || ''));
  if (stats.time && stats.place) return true;
  if (stats.lines.length === 1 && (stats.time || stats.place) && stats.extra >= 2) return true;
  if (explicit && (stats.time || stats.place) && (stats.extra >= 1 || stats.keyLines >= 2)) return true;
  if ((stats.time || stats.place) && stats.extra >= 2 && stats.keyLines >= 2) return true;
  return false;
}
function splitTrailingPlainBlock(source = '') {
  const text = String(source || '').replace(/\r\n/g, '\n').trimEnd();
  if (!text) return null;
  const paragraphParts = text.split(/\n{2,}/);
  if (paragraphParts.length > 1) {
    const last = paragraphParts[paragraphParts.length - 1].trimEnd();
    const body = paragraphParts.slice(0, -1).join('\n\n').trimEnd();
    if (body && looksLikeSceneBoard(last, '')) return { body, board: last, mode: 'plain-paragraph' };
  }
  const lines = text.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (end < 0) return null;
  let start = end;
  let keyLikeCount = 0;
  for (; start >= 0; start--) {
    const line = lines[start] || '';
    if (!line.trim()) { start++; break; }
    const keyLike = KEY_LINE_RE.test(line) || TIME_LABEL_RE.test(line) || PLACE_LABEL_RE.test(line) || EXTRA_LABEL_RE.test(line);
    if (!keyLike && keyLikeCount > 0) { start++; break; }
    if (keyLike) keyLikeCount++;
    const span = end - start + 1;
    if (span >= 20) break;
  }
  start = Math.max(0, start);
  const candidate = lines.slice(start, end + 1).join('\n').trimEnd();
  const body = lines.slice(0, start).join('\n').trimEnd();
  const candidateStats = labelStats(candidate);
  if (body && (keyLikeCount >= 1 || candidateStats.keyLines >= 2) && looksLikeSceneBoard(candidate, '')) return { body, board: candidate, mode: 'plain-lines' };
  return null;
}
function splitSceneBoard(text = '') {
  const source = String(text || '').replace(/\r\n/g, '\n').trimEnd();
  if (!source) return null;
  const panel = source.match(/(?:\n{0,3})(<Info_panel>[\s\S]*?<\/Info_panel>\s*)$/i);
  if (panel && looksLikeSceneBoard(panel[1], 'info_panel')) {
    const body = source.slice(0, panel.index).trimEnd();
    if (body) return { body, board: panel[1].trimEnd(), mode: 'info-panel', tag: 'info_panel' };
  }
  const fenced = source.match(/(?:\n{0,3})(```([^\n`]*)\n[\s\S]*?\n?```\s*)$/);
  if (fenced && looksLikeSceneBoard(fenced[1], fenced[2] || '')) {
    const body = source.slice(0, fenced.index).trimEnd();
    if (body) return { body, board: fenced[1].trimEnd(), mode: 'fenced', tag: String(fenced[2] || '').trim() };
  }
  return splitTrailingPlainBlock(source);
}
function boardInnerText(board = '') { return stripFenceWrapper(board).trim(); }
function shouldJoinLooseLabelLine(line = '', next = '') {
  const current = String(line || '').trim();
  const following = String(next || '').trim();
  if (!current || !following) return false;
  if (!/[:：]$/.test(current)) return false;
  if (/^<\/?[A-Za-z][^>]*>$/.test(current)) return false;
  if (/^```/.test(current) || /^```/.test(following)) return false;
  if (/^<\/?[A-Za-z][^>]*>$/.test(following)) return false;
  // Do not merge bracket-style board segments like [Date:] because those are meant to remain literal.
  if (/^[[【].*[:：]\s*[]】]$/.test(current)) return false;
  // Keep clear new fields separate; only merge when a label was split from its value.
  if (/^[A-Za-z가-힣][A-Za-z가-힣0-9_ .()\/\-]{0,40}\s*[:：]\s*$/.test(following)) return false;
  return /^[A-Za-z가-힣][A-Za-z가-힣0-9_ .()\/\-]{0,40}\s*[:：]\s*$/.test(current);
}
function displaySceneBoardLines(value = '') {
  const sourceLines = sceneBoardLines(value).map(line => String(line || '').trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i];
    const next = sourceLines[i + 1] || '';
    if (shouldJoinLooseLabelLine(line, next)) {
      out.push(`${line} ${next}`.replace(/\s+/g, ' ').trim());
      i++;
      continue;
    }
    out.push(line);
  }
  return out;
}
function displayBoardText(board = '') {
  const inner = boardInnerText(board);
  if (!settings.autoLineBreak) return inner;
  return displaySceneBoardLines(inner).join('\n').trim();
}
function renderAutoLineBoard(board = '') {
  const lines = displaySceneBoardLines(board);
  if (!lines.length) return '';
  const rows = lines.map(line => `<div class="${UI_PREFIX}-line-row">${esc(line)}</div>`).join('');
  return `<div class="${UI_PREFIX}-line-board">${rows}</div>`;
}
function renderBoardHtml(board = '', inCard = false) {
  if (settings.autoLineBreak !== false) {
    const lineBoard = renderAutoLineBoard(board);
    if (lineBoard) return lineBoard;
  }
  const className = inCard ? '' : ` class="${UI_PREFIX}-board-text"`;
  return `<pre${className}>${esc(boardInnerText(board))}</pre>`;
}
function readLabelValue(board = '', labels = []) {
  const lines = sceneBoardLines(board);
  for (const line of lines) {
    for (const label of labels) {
      const re = new RegExp(`^\\s*(?:[-*+]\\s*)?(?:[\\[【(（]\\s*)?${label}(?:\\s*[\\]】)）])?\\s*[:：|=\\-]\\s*(.+)$`, 'i');
      const m = line.match(re);
      if (m) return norm(String(m[1] || '').replace(/[\]】)）]\s*$/, ''));
    }
  }
  return '';
}
function cleanMetaLine(line = '') {
  return norm(String(line || '')
    .replace(/^\s*(?:[-*+]\s*)?/, '')
    .replace(/^[📅🗓⏰🕰🕒📍🧭🏠🏫🏰\s]+/, '')
    .replace(/^\s*(?:time|date|day|datetime|timestamp|timeline|season|location|place|setting|scene|background|where|venue|area|position|현재\s*시간|배경\s*시간|작중\s*시간|시간|날짜|일시|시각|요일|계절|현재\s*위치|위치|장소|배경|무대|공간|지역)\s*[:：|=\-]\s*/i, ''));
}
function fallbackMetaLine(board = '', type = 'time') {
  const lines = sceneBoardLines(board);
  const re = type === 'place' ? PLACE_LABEL_RE : TIME_LABEL_RE;
  const found = lines.find(line => re.test(line));
  return found ? cleanMetaLine(found) : '';
}
function boardMeta(board = '') {
  let time = readLabelValue(board, ['time','date','day','datetime','timestamp','timeline','season','current\\s*time','scene\\s*time','story\\s*time','시간','날짜','일시','시각','요일','계절','현재\\s*시간','배경\\s*시간','작중\\s*시간']);
  let location = readLabelValue(board, ['location','place','setting','scene','background','where','venue','area','position','current\\s*location','위치','장소','현재\\s*위치','배경','무대','공간','지역']);
  if (!time) time = fallbackMetaLine(board, 'time');
  if (!location) location = fallbackMetaLine(board, 'place');
  return { time, location };
}


function messageIdForPayload(payload) {
  const msg = payload?.msg || {};
  return String(msg.id || msg.send_date || payload?.mes?.getAttribute?.('mesid') || payload?.idx || hash(payload?.text || ''));
}
function messageIndexForPayload(payload) {
  const raw = payload?.mes?.getAttribute?.('mesid') || payload?.mes?.getAttribute?.('data-mesid') || payload?.mes?.dataset?.mesid || payload?.idx;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function messageNumberForPayload(payload) {
  const idx = messageIndexForPayload(payload);
  return Number.isFinite(idx) ? idx + 1 : null;
}
function entryMessageLabel(entry = {}) {
  const n = Number(entry?.messageNumber);
  if (Number.isFinite(n) && n > 0) return `#${n}`;
  const idx = Number(entry?.messageIndex);
  if (Number.isFinite(idx) && idx >= 0) return `#${idx + 1}`;
  const id = String(entry?.messageId || '').trim();
  if (/^\d+$/.test(id)) return `#${Number(id) + 1}`;
  return '#?';
}
function makeEntry(payload, board, body, splitMode = '') {
  const meta = boardMeta(board);
  const chatKey = currentChatKey();
  const messageId = messageIdForPayload(payload);
  return {
    id: uid('scene'),
    messageId,
    messageHash: hash(`${chatKey}::${messageId}::${board}`),
    messageIndex: messageIndexForPayload(payload),
    messageNumber: messageNumberForPayload(payload),
    characterKey: currentCharacterKey(),
    characterName: currentCharacterName(),
    chatKey,
    sourceName: payload?.source || currentCharacterName(),
    text: String(board || '').trimEnd(),
    body: String(body || '').trimEnd(),
    originalMes: String(payload?.msg?.mes || payload?.text || `${body || ''}

${board || ''}` || '').trimEnd(),
    time: meta.time,
    location: meta.location,
    splitMode,
    createdAt: Date.now(),
  };
}
function recentList(charKey = currentCharacterKey()) { return ensureCharacterStores(charKey).recent; }
function savedList(charKey = currentCharacterKey()) { return ensureCharacterStores(charKey).saved; }
function currentChatRecentList(charKey = currentCharacterKey()) {
  const chatKey = currentChatKey();
  return recentList(charKey).filter(entry => entry?.chatKey === chatKey);
}
function sameEntry(a = {}, b = {}) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  const sameChat = !!a.chatKey && !!b.chatKey && a.chatKey === b.chatKey;
  if (!sameChat) return false;
  if (a.messageHash && b.messageHash && a.messageHash === b.messageHash) return true;
  if (a.messageId && b.messageId && a.messageId === b.messageId) return true;
  return !!a.text && a.text === b.text;
}
function addRecent(entry) {
  if (!entry?.text) return null;
  const store = recentList(entry.characterKey);
  const existingIndex = store.findIndex(item => sameEntry(item, entry));
  const existing = existingIndex >= 0 ? store[existingIndex] : null;
  const merged = Object.assign({}, entry);
  if (!String(merged.originalMes || '').trimEnd() && String(existing?.originalMes || '').trimEnd()) {
    merged.originalMes = String(existing.originalMes).trimEnd();
  }
  if (!String(merged.originalMes || '').trimEnd()) delete merged.originalMes;
  if (existingIndex === 0 && JSON.stringify(store[0]) === JSON.stringify(merged)) {
    currentRecentIndex = 0;
    if (merged.chatKey === currentChatKey()) applyScenePrompt(store[0]);
    return store[0];
  }
  if (existingIndex >= 0) store.splice(existingIndex, 1);
  store.unshift(merged);
  while (store.length > MAX_RECENT_BOARDS) store.pop();
  currentRecentIndex = 0;
  if (merged.chatKey === currentChatKey()) applyScenePrompt(merged);
  saveSettings();
  setTimeout(() => syncRestoreButtonsFromRecent(), 0);
  return merged;
}
function saveBoard(entry) {
  if (!entry?.text) return false;
  const store = savedList(entry.characterKey || currentCharacterKey());
  const exists = store.some(item => sameEntry(item, entry));
  if (!exists) {
    const savedEntry = stripOriginalMes(Object.assign({}, entry, { savedAt: Date.now() }));
    delete savedEntry.messageIndex;
    delete savedEntry.messageNumber;
    store.unshift(savedEntry);
  }
  saveSettings(true);
  renderInlinePanel();
  if ($('.sb-popover').length) renderLibrary();
  toast(exists ? '이미 저장된 씬보드입니다.' : '씬보드에 저장했습니다.', exists ? 'info' : 'success');
  return true;
}
function isSaved(entry) {
  if (!entry) return false;
  return savedList(entry.characterKey || currentCharacterKey()).some(item => sameEntry(item, entry));
}
function deleteRecentEntry(entry) {
  if (!entry?.text) return false;
  const charKey = entry.characterKey || currentCharacterKey();
  const store = recentList(charKey);
  const before = store.length;
  const filtered = store.filter(x => !sameEntry(x, entry));
  settings.recentByCharacter[charKey] = filtered;
  if (charKey === currentCharacterKey()) {
    const currentList = currentChatRecentList(charKey);
    currentRecentIndex = Math.min(currentRecentIndex, Math.max(0, currentList.length - 1));
  }
  const payload = latestCharacterPayload() || lastInlinePayload;
  const scene = payload?.msg?.extra?.sceneBoard;
  if (scene && sameEntry(scene, entry)) {
    try { delete payload.msg.extra.sceneBoard; } catch {}
    try { delete payload.msg.extra.sceneBoardOriginalMes; } catch {}
    persistChat();
  }
  refreshScenePrompt();
  saveSettings(true);
  renderInlinePanel();
  syncRestoreButtonsFromRecent();
  toast(before !== filtered.length ? '삭제했습니다.' : '삭제할 씬보드가 없습니다.', before !== filtered.length ? 'success' : 'info');
  return before !== filtered.length;
}

function applyScenePrompt(entry = null) {
  if (!entry) entry = currentChatRecentList()[0];
  const text = entry?.text || '';
  const prompt = text ? `[Scene Board]\nThe following scene board is the current state reference. Use it to keep date, time, place, cast, belongings, weather, and mood consistent. Do not repeat the board unless the user explicitly asks for it.\n\n${text}` : '';
  try {
    if (typeof ctx?.setExtensionPrompt === 'function') {
      const types = ctx.extension_prompt_types || window.extension_prompt_types || {};
      const position = types.IN_CHAT ?? types.BEFORE_PROMPT ?? 1;
      ctx.setExtensionPrompt(EXT_NAME, prompt, position, 0, false);
      return true;
    }
  } catch (e) { console.warn('[Scene Board] setExtensionPrompt failed', e); }
  return !prompt;
}
function clearScenePrompt() {
  try { if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(EXT_NAME, '', 0, 0, false); } catch {}
}
function refreshScenePrompt() {
  const entry = currentChatRecentList()[0];
  if (entry) applyScenePrompt(entry);
  else clearScenePrompt();
}

function clearCutoffForCharacter(charKey = currentCharacterKey()) {
  return Math.max(Number(settings.clearedAllAt || 0), Number(settings.clearedAtByCharacter?.[charKey] || 0));
}
function wasCleared(entry, charKey = entry?.characterKey || currentCharacterKey()) {
  if (!entry) return false;
  const cutoff = clearCutoffForCharacter(charKey);
  if (!cutoff) return false;
  return Number(entry.createdAt || entry.savedAt || 0) <= cutoff;
}
function clearSceneBoardExtrasInLoadedChat(charKey = null) {
  const chat = liveContext()?.chat || ctx?.chat || [];
  let changed = false;
  for (const msg of chat) {
    const scene = msg?.extra?.sceneBoard;
    if (charKey && String(scene?.characterKey || '') !== String(charKey)) continue;
    if (scene) {
      try { delete msg.extra.sceneBoard; changed = true; } catch {}
    }
    if (msg?.extra?.sceneBoardOriginalMes) {
      try { delete msg.extra.sceneBoardOriginalMes; changed = true; } catch {}
    }
  }
  if (changed) persistChat();
}
function processPayload(payload, opts = {}) {
  if (!settings.enabled || !payload || payload.isUser) return false;
  ensureRestoreButton(payload.mes);
  const latest = latestCharacterPayload();
  if (latest?.mes && payload.mes !== latest.mes && !opts.force) return false;
  const msg = payload.msg;
  const existing = msg?.extra?.sceneBoard;
  if (existing?.text) {
    const entry = Object.assign({}, stripOriginalMes(existing), {
      characterKey: existing.characterKey || currentCharacterKey(),
      characterName: existing.characterName || currentCharacterName(),
      chatKey: existing.chatKey || currentChatKey(),
    });
    const cached = recentList(entry.characterKey).find((item) => sameEntry(item, entry));
    if (String(cached?.originalMes || '').trimEnd()) entry.originalMes = String(cached.originalMes).trimEnd();
    if (wasCleared(entry)) {
      try { delete msg.extra.sceneBoard; } catch {}
      persistChat();
      return false;
    }
    if (msg?.extra) {
      const cleanScene = stripOriginalMes(entry);
      if (existing.characterKey !== cleanScene.characterKey || existing.chatKey !== cleanScene.chatKey || existing.originalMes) {
        msg.extra.sceneBoard = cleanScene;
        persistChat();
      }
    }
    addRecent(entry);
    lastInlinePayload = payload;
    renderInlinePanel();
    ensureRestoreButton(payload.mes);
    return true;
  }
  const source = messageSourceText(msg?.mes || payload.text || '', payload.textEl);
  if (shouldSkipRestoredMessage(msg, source)) {
    ensureRestoreButton(payload.mes);
    return false;
  }
  const split = splitSceneBoard(source);
  if (!split?.board) return false;
  const entry = makeEntry(payload, split.board, split.body, split.mode || '');
  if (msg) {
    msg.extra = msg.extra || {};
    msg.extra.sceneBoard = stripOriginalMes(entry);
    msg.mes = split.body;
  }
  setMessageText(payload, split.body);
  persistChat();
  addRecent(entry);
  lastInlinePayload = payload;
  renderInlinePanel();
  ensureRestoreButton(payload.mes);
  return true;
}
function parseLatestMessage(force = false) {
  if (!settings.enabled) return false;
  const payload = latestCharacterPayload();
  if (!payload) return false;
  lastInlinePayload = payload;
  const ok = processPayload(payload, { force });
  if (!ok) renderInlinePanel();
  return ok;
}
function inlineEntry() {
  const list = currentChatRecentList();
  if (!list.length) return null;
  if (currentRecentIndex < 0) currentRecentIndex = 0;
  if (currentRecentIndex >= list.length) currentRecentIndex = list.length - 1;
  return list[currentRecentIndex] || null;
}

function refreshSceneBoardExternal() {
  try { renderInlinePanel(); } catch {}
  try { renderLibrary(); } catch {}
}
function exposeSceneBoardApi() {
  try {
    window.SceneBoardExtensions = window.SceneBoardExtensions || {};
    window.SceneBoardExtensions[EXT_NAME] = Object.assign(window.SceneBoardExtensions[EXT_NAME] || {}, {
      refresh: refreshSceneBoardExternal,
      renderInlinePanel,
      renderLibrary,
    });
    if (EXT_NAME === 'scene-board') window.SceneBoard = window.SceneBoardExtensions[EXT_NAME];
    if (EXT_NAME === 'scene-board-beta') window.SceneBoardBeta = window.SceneBoardExtensions[EXT_NAME];
  } catch {}
}

function renderInlinePanel() {
  $('.sb-inline-panel').remove();
  syncRestoreButtonsFromRecent();
  if (!settings.enabled) return;
  const payload = latestCharacterPayload() || lastInlinePayload;
  if (!payload?.mes || payload.isUser) return;
  const list = currentChatRecentList();
  if (!list.length) return;
  const entry = inlineEntry();
  if (!entry) return;
  const saved = isSaved(entry);
  const numberHtml = settings.hideChatNumber
    ? ''
    : `<span class="sb-inline-number" title="${esc(`${currentRecentIndex + 1}/${list.length}`)}">${esc(entryMessageLabel(entry))}</span>`;
  const html = `
    <div class="sb-inline-panel" data-scene-board-ignore="true">
      ${renderBoardHtml(entry.text)}
      <div class="sb-inline-footer">
        <div class="sb-inline-nav">
          <button class="sb-save-btn" type="button">${saved ? '저장됨' : '저장'}</button>
          <button class="sb-inline-delete-btn" type="button">삭제</button>
          <button class="sb-arrow sb-prev" type="button" ${list.length <= 1 ? 'disabled' : ''}>‹</button>
          ${numberHtml}
          <button class="sb-arrow sb-next" type="button" ${list.length <= 1 ? 'disabled' : ''}>›</button>
        </div>
      </div>
    </div>`;
  const panel = $(html);
  payload.textEl.after(panel);
}


function setupSettingsPanel() {
  if ($('#scene-board-settings').length) return;
  const html = `
  <div id="scene-board-settings" class="inline-drawer sb-settings-root">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b class="inline-drawer-title">${esc(DISPLAY_NAME)}</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content sb-settings-content" style="display:none;">
      <div class="sb-setting-row">
        <label><input id="sb-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}> Scene Board 활성화</label>
      </div>
      <div class="sb-setting-row">
        <label><input id="sb-auto-line-break" type="checkbox" ${settings.autoLineBreak !== false ? 'checked' : ''}> 자동 줄바꿈</label>
      </div>
      <div class="sb-setting-row">
        <label><input id="sb-hide-chat-number" type="checkbox" ${settings.hideChatNumber === true ? 'checked' : ''}> 채팅 번호 숨기기</label>
      </div>
      <div class="sb-setting-row sb-font-size-row">
        <label for="sb-settings-font-size">씬보드 글씨 크기</label>
        <div class="sb-font-size-inline">
          <input id="sb-settings-font-size" class="text_pole sb-font-size-input" type="number" min="11" max="18" step="1" value="${esc(clampFontSize(settings.fontSize))}">
          <span class="sb-font-size-unit">px</span>
        </div>
      </div>
      <div class="sb-settings-foot"><span><b>${savedList().length}</b>개 저장됨</span></div>
    </div>
  </div>`;
  ($('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings')).append(html);
  $('#sb-enabled').on('change', function(){
    settings.enabled = !!this.checked;
    settings.autoParse = true;
    settings.hideOriginal = true;
    saveSettings(true);
    if (!settings.enabled) {
      $('.sb-inline-panel').remove();
      clearScenePrompt();
    } else {
      // Re-enabling should not re-insert an old Scene Board.
      // The next newly rendered character reply will be parsed and applied.
      clearScenePrompt();
    }
  });
  $('#sb-auto-line-break').on('change', function(){
    settings.autoLineBreak = !!this.checked;
    saveSettings(true);
    renderInlinePanel();
    if ($('.sb-popover').length) renderLibrary();
  });
  $('#sb-hide-chat-number').on('change', function(){
    settings.hideChatNumber = !!this.checked;
    saveSettings(true);
    renderInlinePanel();
  });
}
function updateSavedCount() { $('#scene-board-settings .sb-settings-foot span').html(`<b>${savedList().length}</b>개 저장됨`); }
function setupExtensionsMenuButton() {
  const menu = document.querySelector('#extensionsMenu');
  if (!menu || document.getElementById('sb-extension-menu-button')) return;
  const item = document.createElement('div');
  item.id = 'sb-extension-menu-button';
  item.className = 'list-group-item flex-container flexGap5 interactable';
  item.innerHTML = `<span class="sb-menu-icon" aria-hidden="true">🧭</span><span class="sb-menu-title">Scene Board</span>`;
  menu.appendChild(item);
}
function closeLibrary() { $('.sb-popover').remove(); }
function allCharacterKeys() {
  return Object.keys(settings.boardsByCharacter || {}).filter(key => Array.isArray(settings.boardsByCharacter[key]) && settings.boardsByCharacter[key].length);
}
function characterLabelForKey(key) {
  const arr = settings.boardsByCharacter?.[key] || settings.recentByCharacter?.[key] || [];
  return cleanName(arr?.[0]?.characterName || key.replace(/^(char|avatar|name):/, '').split(':').pop()) || 'Unknown';
}
function activeFilterKey() {
  const f = settings.activeCharacterFilter || 'all';
  if (f === 'current') return 'all';
  if (f === 'all') return 'all';
  return f;
}
function filteredSavedBoards() {
  const key = activeFilterKey();
  if (key === 'all') {
    return Object.values(settings.boardsByCharacter || {}).flat().sort((a,b) => Number(b.savedAt || b.createdAt || 0) - Number(a.savedAt || a.createdAt || 0));
  }
  return savedList(key).slice();
}
function openLibrary() {
  closeLibrary();
  const html = `
    <div class="sb-popover" role="dialog" aria-label="Scene Board">
      <div class="sb-head">
        <div><b>Scene Board</b><span>캐릭터별로 저장한 상태창을 모아 봅니다.</span></div>
        <div class="sb-head-actions"><button class="sb-settings-btn" type="button" title="설정">⚙</button><button class="sb-close" type="button" title="닫기">×</button></div>
      </div>
      <div class="sb-library-settings" hidden>
        <button id="sb-reset-current" type="button">현재 캐릭터 씬보드 초기화</button>
        <button id="sb-reset-all" type="button">씬보드 내역 전체 초기화</button>
        <label>글씨 크기 <input id="sb-font-size" type="number" min="11" max="18" value="${esc(settings.fontSize)}"></label>
      </div>
      <div class="sb-body">
        <aside class="sb-side"></aside>
        <main class="sb-main"><div id="sb-list" class="sb-list"></div></main>
      </div>
    </div>`;
  $('body').append(html);
  renderLibrary();
}
function renderLibrary() {
  const pop = $('.sb-popover');
  if (!pop.length) return;
  const keys = allCharacterKeys();
  const side = pop.find('.sb-side').empty();
  if (settings.activeCharacterFilter === 'current') settings.activeCharacterFilter = 'all';
  const addSide = (key, label) => side.append(`<button type="button" class="sb-filter ${activeFilterKey() === key ? 'on' : ''}" data-key="${esc(key)}">${esc(label)}</button>`);
  addSide('all', '전체');
  keys.forEach(k => addSide(k, characterLabelForKey(k)));
  const list = pop.find('#sb-list').empty();
  const cards = filteredSavedBoards();
  if (!cards.length) {
    list.append('<div class="sb-empty">저장된 씬보드가 없습니다.</div>');
  } else {
    for (const card of cards) {
      list.append(`
        <article class="sb-card" data-id="${esc(card.id)}" data-char="${esc(card.characterKey || '')}">
          <div class="sb-card-tools">
            <button class="sb-card-copy" type="button" title="복사" aria-label="복사">📋</button>
            <button class="sb-card-delete" type="button" title="삭제" aria-label="삭제">🗑️</button>
          </div>
          ${renderBoardHtml(card.text, true)}
        </article>`);
    }
  }
  pop.find('#sb-font-size').val(settings.fontSize);
  updateSavedCount();
}
function deleteSavedBoard(charKey, id) {
  const list = savedList(charKey);
  const before = list.length;
  settings.boardsByCharacter[charKey] = list.filter(x => x.id !== id);
  saveSettings(true);
  renderLibrary();
  if (before !== settings.boardsByCharacter[charKey].length) toast('삭제했습니다.', 'success');
}
function copyText(value) {
  const text = String(value || '');
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(value) {
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function setupEvents() {
  teardownRuntimeEvents();
  runtime.externalUpdateHandler = refreshSceneBoardExternal;
  document.addEventListener('scene-board:external-update', runtime.externalUpdateHandler);

  const es = ctx?.eventSource;
  const et = ctx?.event_types || {};
  if (es && typeof es.on === 'function') {
    const bind = (name, fn) => { if (et[name]) bindRuntimeEvent(es, et[name], fn); };
    bind('APP_READY', () => {
      markSettingsSaveReady();
      if (settings.enabled) {
        refreshScenePrompt();
        renderInlinePanel();
      }
      syncRestoreButtonsFromRecent();
    });
    bind('CHARACTER_MESSAGE_RENDERED', (...args) => {
      if (!settings.enabled) return;
      setTimeout(() => {
        const payload = payloadFromEventArgs(args) || latestCharacterPayload();
        if (payload && !payload.isUser) processPayload(payload);
        if (payload?.mes) ensureRestoreButton(payload.mes);
      }, 180);
    });
    bind('MESSAGE_RENDERED', (...args) => {
      if (!settings.enabled) return;
      setTimeout(() => {
        const payload = payloadFromEventArgs(args);
        if (payload && !payload.isUser && latestCharacterPayload()?.mes === payload.mes) processPayload(payload);
        if (payload?.mes) ensureRestoreButton(payload.mes);
      }, 220);
    });
    bind('CHAT_CHANGED', () => {
      currentRecentIndex = 0;
      $('.sb-inline-panel').remove();
      setTimeout(() => {
                if (!settings.enabled) {
          syncRestoreButtonsFromRecent();
          return;
        }
        // Re-read the latest rendered reply in this chat. This restores its own
        // cached card without ever borrowing the previous chat's recent card.
        if (!parseLatestMessage(false)) {
          refreshScenePrompt();
          renderInlinePanel();
        }
        syncRestoreButtonsFromRecent();
      }, 200);
    });
  }
  $(document).off('click.sceneBoard').on('click.sceneBoard', function(e) {
    const t = e.target;
    if ($(t).closest('#sb-extension-menu-button').length) { e.preventDefault(); e.stopPropagation(); return openLibrary(); }
    if ($(t).closest('.sb-close').length) { e.preventDefault(); e.stopPropagation(); return closeLibrary(); }
    if ($(t).closest('.sb-settings-btn').length) { e.preventDefault(); e.stopPropagation(); const box = $('.sb-library-settings'); box.prop('hidden', !box.prop('hidden')); return; }
    if ($(t).closest('.sb-prev').length) { e.preventDefault(); e.stopPropagation(); const len = currentChatRecentList().length; if (len) { currentRecentIndex = (currentRecentIndex + 1) % len; renderInlinePanel(); } return; }
    if ($(t).closest('.sb-next').length) { e.preventDefault(); e.stopPropagation(); const len = currentChatRecentList().length; if (len) { currentRecentIndex = (currentRecentIndex - 1 + len) % len; renderInlinePanel(); } return; }
    const restore = $(t).closest('.sb-restore-original-btn');
    if (restore.length) { e.preventDefault(); e.stopPropagation(); const payload = messagePayloadFromTarget(restore[0]); if (payload) restoreOriginalMessage(payload); return; }
    if ($(t).closest('.sb-save-btn').length) { e.preventDefault(); e.stopPropagation(); const entry = inlineEntry(); if (entry) saveBoard(entry); return; }
    if ($(t).closest('.sb-inline-delete-btn').length) { e.preventDefault(); e.stopPropagation(); const entry = inlineEntry(); if (entry) deleteRecentEntry(entry); return; }
    const filter = $(t).closest('.sb-filter');
    if (filter.length) { e.preventDefault(); e.stopPropagation(); settings.activeCharacterFilter = String(filter.data('key') || 'all'); saveSettings(); renderLibrary(); return; }
    if ($(t).closest('#sb-reset-current').length) {
      e.preventDefault(); e.stopPropagation();
      const key = currentCharacterKey();
      if (!confirm('현재 캐릭터의 저장된 씬보드를 모두 삭제할까요?')) return;
      settings.boardsByCharacter[key] = [];
      settings.recentByCharacter[key] = [];
      settings.clearedAtByCharacter[key] = Date.now();
      clearSceneBoardExtrasInLoadedChat(key);
      clearScenePrompt();
      currentRecentIndex = 0;
      $('.sb-inline-panel').remove();
      saveSettings(true); renderLibrary(); updateSavedCount(); syncRestoreButtonsFromRecent(); toast('현재 캐릭터 씬보드를 초기화했습니다.', 'success'); return;
    }
    if ($(t).closest('#sb-reset-all').length) {
      e.preventDefault(); e.stopPropagation();
      if (!confirm('저장된 씬보드 내역 전체를 삭제할까요?')) return;
      settings.boardsByCharacter = {};
      settings.recentByCharacter = {};
      settings.clearedAtByCharacter = {};
      settings.clearedAllAt = Date.now();
      clearSceneBoardExtrasInLoadedChat(null);
      clearScenePrompt();
      currentRecentIndex = 0;
      $('.sb-inline-panel').remove();
      saveSettings(true); renderLibrary(); updateSavedCount(); syncRestoreButtonsFromRecent(); toast('씬보드 내역 전체를 초기화했습니다.', 'success'); return;
    }
    const del = $(t).closest('.sb-card-delete');
    if (del.length) { e.preventDefault(); e.stopPropagation(); const card = del.closest('.sb-card'); deleteSavedBoard(String(card.data('char') || ''), String(card.data('id') || '')); return; }
    const copy = $(t).closest('.sb-card-copy');
    if (copy.length) { e.preventDefault(); e.stopPropagation(); const card = copy.closest('.sb-card'); const entry = savedList(String(card.data('char') || '')).find(x => x.id === String(card.data('id') || '')); if (entry) copyText(entry.text).then(ok => toast(ok ? '복사했습니다.' : '복사에 실패했습니다.', ok ? 'success' : 'warn')); return; }
  });
  $(document).off('change.sceneBoard').on('change.sceneBoard', '#sb-font-size, #sb-settings-font-size', function(){ settings.fontSize = clampFontSize($(this).val()); applyFontSize(); saveSettings(true); renderLibrary(); });
  $(document).off('keydown.sceneBoard').on('keydown.sceneBoard', function(e){
    if ((e.key === 'Enter' || e.key === ' ') && $(e.target).closest('.sb-restore-original-btn').length) {
      e.preventDefault(); e.stopPropagation();
      const payload = messagePayloadFromTarget(e.target);
      if (payload) restoreOriginalMessage(payload);
      return;
    }
    if (e.key === 'Escape' && $('.sb-popover').length) closeLibrary();
  });
}
function boot() {
  runtime.booted = true;
  runtime.version = VERSION;
  applyFontSize();
  setupSettingsPanel();
  setupExtensionsMenuButton();
  setupEvents();
  settingsSaveCanStart();
  exposeSceneBoardApi();
  if (settings.enabled) {
    refreshScenePrompt();
    renderInlinePanel();
  }
  syncRestoreButtonsFromRecent();
}

if (typeof jQuery === 'function') jQuery(() => { try { boot(); } catch (e) { console.error('[Scene Board] boot failed', e); } });
else document.addEventListener('DOMContentLoaded', () => { try { boot(); } catch (e) { console.error('[Scene Board] boot failed', e); } });
