'use strict';
const { validGroupId } = require('./core');
// Аккаунты соцсетей: добавление кнопкой в виджете (вход, токен в секрет GitHub, запись в config.json) и их состояние.
// Логика без Electron, чтобы её можно было проверить тестами.

const TT_SCOPES = 'user.info.basic,video.upload';
const IG_SCOPES = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights';
// вход через Facebook: один вход = все аккаунты Instagram, привязанные к Страницам этого человека
const FB_SCOPES = 'instagram_basic,instagram_content_publish,instagram_manage_comments,instagram_manage_insights,pages_show_list,pages_read_engagement,business_management';
const EXPIRES_WARN_DAYS = 30;

/** Часть имени секрета из ника: в именах секретов GitHub только латиница, цифры и _ (как secret_suffix в autoposter.py). */
function secretSuffix(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'ACC';
}
const secretNameFor = (platform, name) => `${platform === 'tiktok' ? 'TT_TOKEN' : 'IG_TOKEN'}_${secretSuffix(name)}`;

/** Ник аккаунта: без @, пробелов и символов, которые сломают имя папки. */
function cleanName(s) {
  return String(s || '').trim().replace(/^@+/, '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 40);
}
/** Предложение ника из имени в профиле: латиница/цифры, остальное выбрасываем. */
function suggestName(displayName) {
  return cleanName(String(displayName || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')).replace(/[^A-Za-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').toLowerCase();
}
/**
 * Что не так с ником. accounts: аккаунты всех групп (allAccounts) или одной; group: группа, куда добавляем.
 * Ник уникален во всех группах: по нему автопостер хранит, что уже вышло, и ищет подпапки.
 */
function nameError(name, accounts = [], platform = '', keep = '', group) {
  if (!name) return 'Впиши ник аккаунта.';
  if (/^\./.test(name)) return 'Ник не может начинаться с точки.';
  const clash = accounts.find((a) => a && a.name && a.name.toLowerCase() === name.toLowerCase() && a.name !== keep);
  if (clash && group !== undefined && clash._group !== undefined && clash._group !== group) {
    return `Ник @${name} уже есть в группе «${clash._groupName || clash._group || DEFAULT_GROUP_NAME}». Один ник может быть только в одной группе: убери его там или впиши другой.`;
  }
  if (clash && (clash.platform || 'instagram') !== platform) return `Ник @${name} уже занят аккаунтом ${clash.platform === 'tiktok' ? 'TikTok' : 'Instagram'}: впиши другой (например, ${name}_${platform === 'tiktok' ? 'tt' : 'ig'}).`;
  return '';
}

/**
 * Добавить или переподключить аккаунт в config.json (объект меняется на месте).
 * Тот же ник или тот же аккаунт соцсети (open_id / user_id) = переподключение: имя и секрет остаются прежними.
 * Возвращает { account, replaced }.
 */
function upsertAccount(cfg, entry, { legacy = true } = {}) {
  cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const platform = entry.platform === 'tiktok' ? 'tiktok' : 'instagram';
  const samePlatform = (a) => (a.platform || 'instagram').toLowerCase() === platform;
  const idKey = platform === 'tiktok' ? 'open_id' : 'user_id';
  let i = cfg.accounts.findIndex((a) => a && samePlatform(a) && entry[idKey] && String(a[idKey] || '') === String(entry[idKey]));
  if (i < 0) i = cfg.accounts.findIndex((a) => a && samePlatform(a) && a.name.toLowerCase() === String(entry.name).toLowerCase());
  const old = i >= 0 ? cfg.accounts[i] : null;
  // первый аккаунт Instagram по старой схеме мог работать без token_env (IG_TOKEN): сохраняем как было
  const legacyEnv = legacy && old && i === 0 && platform === 'instagram' && !old.token_env ? 'IG_TOKEN' : '';
  const account = { ...(old || {}), ...entry, platform: undefined };
  account.name = old ? old.name : entry.name;
  account.token_env = (old && old.token_env) || legacyEnv || secretNameFor(platform, account.name);
  if (platform === 'tiktok') { account.platform = 'tiktok'; account.mode = (old && old.mode) || entry.mode || 'inbox'; } else delete account.platform;
  if (old && old.user_id_env && platform === 'instagram' && entry.user_id) delete account.user_id_env; // явный id надёжнее
  for (const k of Object.keys(account)) if (account[k] === undefined || account[k] === '') delete account[k];
  // порядок полей как у ручных записей: name, platform, mode, token_env, остальное
  const ordered = {};
  for (const k of ['name', 'platform', 'mode', 'token_env', 'user_id', 'open_id']) if (k in account) ordered[k] = account[k];
  Object.assign(ordered, account);
  if (old) cfg.accounts[i] = ordered; else cfg.accounts.push(ordered);
  return { account: ordered, replaced: !!old };
}

/** Убрать аккаунт. Возвращает удалённую запись (или null). */
function removeAccount(cfg, name, platform) {
  const list = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const i = list.findIndex((a) => a && a.name === name && (a.platform || 'instagram').toLowerCase() === platform);
  if (i < 0) return null;
  const [gone] = list.splice(i, 1);
  return gone;
}
/** Имя секрета аккаунта (как его ищет autoposter.py). */
function tokenEnvOf(acc, index) {
  if (acc.token_env) return acc.token_env;
  if ((acc.platform || 'instagram') === 'tiktok') return secretNameFor('tiktok', acc.name);
  return index === 0 ? 'IG_TOKEN' : `IG_TOKEN_${index + 1}`;
}

// ---------------------------------------------------------------- вход (OAuth)
function tiktokAuthUrl({ clientKey, redirectUri, state, direct = false }) {
  const q = new URLSearchParams({ client_key: clientKey, scope: TT_SCOPES + (direct ? ',video.publish' : ''), response_type: 'code',
    redirect_uri: redirectUri, state });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}
function instagramAuthUrl({ appId, redirectUri, state }) {
  const q = new URLSearchParams({ enable_fb_login: '0', force_authentication: '1', client_id: appId, redirect_uri: redirectUri,
    response_type: 'code', scope: IG_SCOPES, state });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

/** Вход через Facebook. configId: конфигурация «Входа через Facebook для бизнеса» (если приложение требует её вместо scope). */
function facebookAuthUrl({ appId, redirectUri, state, configId = '' }) {
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, response_type: 'code' });
  if (configId) q.set('config_id', configId); else { q.set('scope', FB_SCOPES); q.set('auth_type', 'rerequest'); }
  return `https://www.facebook.com/v23.0/dialog/oauth?${q}`;
}

/**
 * Пачка аккаунтов Instagram из одного входа через Facebook.
 * list: найденные аккаунты [{ user_id, username, page }], accounts: config.json → accounts.
 * Для каждого: уже подключён (existing = его ник в config.json) или новый (предложенный ник).
 */
function instagramChoices(list, accounts = []) {
  const ig = (accounts || []).filter((a) => a && (a.platform || 'instagram').toLowerCase() === 'instagram');
  return (list || []).map((x) => {
    const same = ig.find((a) => String(a.user_id || '') === String(x.user_id))
      || ig.find((a) => x.username && a.name.toLowerCase() === String(x.username).toLowerCase());
    const out = { ...x, existing: same ? same.name : '', main: !!same && !same._group && (same.token_env || 'IG_TOKEN') === 'IG_TOKEN', name: same ? same.name : cleanName(x.username || '') };
    if (same && same._group !== undefined) { out.group = same._group; out.groupName = same._groupName || ''; }
    return out;
  });
}

/**
 * Проверить выбранные аккаунты перед сохранением. picks: [{ user_id, name }].
 * Возвращает { entries: [{ name, user_id }], errors: ['@ник: что не так'] }.
 */
function planInstagramBatch(picks, accounts = [], group) {
  const entries = [], errors = [], seen = new Set();
  for (const p of picks || []) {
    const name = cleanName(p.name);
    const keep = (accounts || []).find((a) => a && (a.platform || 'instagram') === 'instagram' && String(a.user_id || '') === String(p.user_id));
    // уже подключённый аккаунт обновляем в его же группе, новый идёт в выбранную
    const err = nameError(name, accounts, 'instagram', keep ? keep.name : '', keep && keep._group !== undefined ? keep._group : group);
    if (err) { errors.push(`@${name || p.user_id}: ${err}`); continue; }
    if (!p.user_id) { errors.push(`@${name}: нет ID аккаунта Instagram`); continue; }
    if (seen.has(name.toLowerCase())) { errors.push(`@${name}: этот ник выбран дважды`); continue; }
    seen.add(name.toLowerCase());
    entries.push({ name, user_id: String(p.user_id), ...(keep && keep._group !== undefined ? { group: keep._group } : group !== undefined ? { group } : {}) });
  }
  return { entries, errors };
}

/**
 * Пошаговая настройка входа через Facebook для окна «+ аккаунт»: разделы с шагами, у шага может быть ссылка
 * (url, link — подпись кнопки) и текст для копирования (copy, copyLabel). Ссылки на страницы приложения
 * прямые, когда ID приложения уже вписан, иначе ведут в список приложений.
 */
function facebookGuide({ appId = '', redirect = '', repo = '' } = {}) {
  const dev = 'https://developers.facebook.com';
  const app = (p) => (appId ? `${dev}/apps/${appId}/${p}` : `${dev}/apps/`);
  const pick = appId ? '' : ' (сначала открой приложение Auto из списка)';
  return [
    { title: 'Один раз: подключить вход через Facebook', steps: [
      { text: 'Открой список приложений Meta и зайди в приложение Auto. Войди в Facebook тем аккаунтом, который управляет Страницами.', url: `${dev}/apps/`, link: 'Мои приложения' },
      { text: `Настройки приложения → Основное. Скопируй «ID приложения» и вставь в поле «ID приложения Meta» ниже. Потом у «Секрета приложения» нажми «Показать», введи пароль Facebook, скопируй и вставь в «Секрет приложения Meta». Нажми «Сохранить ключ».${pick}`, url: app('settings/basic/'), link: 'Основные настройки' },
      { text: `Там же, в «Основном»: поле «Домены приложения» — вставь домен ниже (без https). Внизу «+ Добавить платформу» → «Веб-сайт» → «URL-адрес сайта»: адрес возврата (кнопка в следующем шаге его копирует). «Сохранить изменения». Без этого Facebook пишет «Невозможно загрузить URL: домен не включен в список доменов приложения».${pick}`, url: app('settings/basic/'), link: 'Основные настройки', copy: (() => { try { return new URL(redirect).host; } catch { return 'frizy229.github.io'; } })(), copyLabel: 'Скопировать домен' },
      { text: `Добавь продукт «Вход через Facebook» (или «Вход через Facebook для бизнеса»): «Настроить».${pick}`, url: app('add/'), link: 'Добавить продукт' },
      { text: `Вход через Facebook → Настройки → поле «Действительные URI перенаправления для OAuth»: вставь адрес ниже, нажми Enter и «Сохранить изменения». Переключатели «Вход через OAuth клиента» и «Вход через веб-OAuth» должны быть включены.${pick}`, url: app('fb-login/settings/'), link: 'Настройки входа', copy: redirect, copyLabel: 'Скопировать адрес' },
      { text: 'Нажми «Войти через Facebook» в этом окне. Если Facebook пишет «Invalid Scopes» или «Функция недоступна», сделай следующий шаг, иначе пропусти его.' },
      { text: `Только при ошибке: «Вход через Facebook для бизнеса» → Конфигурации → «Создать конфигурацию» → тип «Маркер доступа пользователя» → отметь разрешения из списка (кнопка ниже копирует их) → Создать. Скопируй «ID конфигурации» в поле «ID конфигурации входа» ниже и «Сохранить ключ».${pick}`, url: app('business-login/configurations/'), link: 'Конфигурации', copy: FB_SCOPES.split(',').join(', '), copyLabel: 'Скопировать разрешения' },
      { text: 'Токену GitHub виджета нужно право «Secrets: Read and write» (токен → Edit → Repository permissions → Secrets). Если уже добавлял для TikTok, ничего делать не надо.', url: 'https://github.com/settings/personal-access-tokens', link: 'Токены GitHub' },
    ] },
    { title: 'Каждый новый аккаунт Instagram (~2 минуты)', steps: [
      { text: 'В приложении Instagram на этом аккаунте: Профиль → ☰ → «Тип аккаунта и инструменты» → «Переключиться на профессиональный» → «Автор» или «Бизнес».' },
      { text: 'Создай Страницу Facebook для этого аккаунта (имя любое, можно как ник). У каждого аккаунта Instagram своя Страница.', url: 'https://www.facebook.com/pages/create', link: 'Создать Страницу' },
      { text: 'Привяжи Instagram к Странице: Meta Business Suite → выбери эту Страницу слева вверху → Настройки → «Аккаунты Instagram» (или «Связанные аккаунты») → «Подключить» → войди в Instagram.', url: 'https://business.facebook.com/latest/settings/', link: 'Meta Business Suite' },
      { text: 'Здесь: «Войти через Facebook» → «Изменить настройки» / «Выбрать Страницы» → отметь ВСЕ Страницы и все аккаунты Instagram → «Продолжить». Новые аккаунты будут уже отмечены в списке → «Сохранить отмеченные».' },
      { text: 'Привязал сразу несколько аккаунтов? Достаточно одного входа на все.' },
    ] },
    { title: 'Друг со своей копией', steps: [
      { text: 'Ты: Роли приложения → Роли → «Добавить людей» → «Тестировщик» → имя или ID Facebook друга.', url: app('roles/roles/'), link: 'Роли приложения' },
      { text: 'Друг: принимает приглашение на странице запросов (войдя в свой Facebook), потом в своём виджете вставляет ID и секрет приложения Meta от тебя и входит через Facebook. Его токены попадут только в его репозиторий.', url: `${dev}/requests/`, link: 'Запросы (для друга)' },
    ] },
    ...(repo ? [{ title: 'Если что-то не работает', steps: [
      { text: 'Цветная точка у аккаунта показывает состояние токена. Подробности каждого запуска в журнале.', url: `https://github.com/${repo}/actions`, link: 'Журнал запусков' },
    ] }] : []),
  ];
}

/** Тот же адрес возврата? Сравниваем без хвоста «/», параметров и #. */
const bare = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`.replace(/\/+$/, ''); } catch { return ''; } };
const isRedirect = (url, redirectUri) => !!bare(redirectUri) && bare(url) === bare(redirectUri);

/**
 * Разобрать адрес, на который соцсеть вернула после входа.
 * null = это не наш адрес; {code} = успех; {error} = отказ или подмена (state не совпал).
 */
function parseRedirect(url, redirectUri, state) {
  let x;
  try { x = new URL(String(url).trim()); } catch { return null; }
  if (!isRedirect(x.href, redirectUri)) return null;
  const q = x.searchParams;
  if (q.get('error') || q.get('error_code')) {
    const why = q.get('error_description') || q.get('error_reason') || q.get('error') || q.get('error_code');
    return { error: /access_denied|user_denied|cancel/i.test(why || '') ? 'Вход отменён: доступ не разрешили.' : `Соцсеть отказала: ${why}` };
  }
  if (state && q.get('state') !== state) return { error: 'Адрес от другого входа: начни вход заново.' };
  const code = (q.get('code') || '').replace(/#_?$/, '');
  return code ? { code } : { error: 'В адресе нет кода входа.' };
}

/** Вход через Google или Apple: они блокируют встроенные окна программ, нужен обычный браузер. */
function needsBrowser(url) {
  let h = '';
  try { h = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return h === 'accounts.google.com' || h.endsWith('.accounts.google.com') || h === 'appleid.apple.com';
}

// ---------------------------------------------------------------- состояние аккаунтов
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

/**
 * Состояние аккаунта для виджета. secretNames: имена секретов репозитория (null = токену виджета их не видно),
 * tokens: state.json → tokens (пишет автопостер при каждой публикации).
 * Возвращает { level: ok | warn | bad | unknown, text }.
 */
function accountHealth(acc, index, secretNames, tokens, now = new Date()) {
  const env = tokenEnvOf(acc, index);
  if (Array.isArray(secretNames) && !secretNames.includes(env)) return { level: 'bad', text: `нет токена (секрет ${env}): переподключи аккаунт` };
  const t = (tokens || {})[acc.name];
  const today = now.toISOString().slice(0, 10);
  if (t && t.ok === false) {
    // переподключили после ошибки: ждём следующего запуска, старую ошибку не показываем
    if (acc.connected && acc.connected.slice(0, 10) >= (t.since || '')) return { level: 'unknown', text: 'переподключён, проверится при ближайшей публикации' };
    return { level: 'bad', text: `токен не работает с ${t.since || '?'}: переподключи аккаунт` };
  }
  if (t && t.expires) {
    const left = dayDiff(t.expires, today);
    if (left <= EXPIRES_WARN_DAYS) return { level: 'warn', text: left > 0 ? `вход истекает через ${left} дн.: переподключи заранее` : 'вход истёк: переподключи аккаунт' };
  }
  if (t && t.ok) return { level: 'ok', text: 'работает' };
  return { level: 'unknown', text: acc.connected ? 'подключён, проверится при ближайшей публикации' : 'ещё не проверялся' };
}

// ---------------------------------------------------------------- группы (сетки аккаунтов для разных проектов)
const DEFAULT_GROUP_NAME = 'Основная';
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Группы из config.json: первая всегда «по умолчанию» (id ''), её аккаунты и тексты лежат прямо в config.json. */
function groupList(cfg) {
  const out = [{ id: '', name: (cfg && cfg.group_name) || DEFAULT_GROUP_NAME, node: cfg || {} }];
  for (const g of (cfg && cfg.groups) || []) {
    if (g && validGroupId(g.id) && !out.some((x) => x.id === g.id)) out.push({ id: g.id, name: g.name || g.id, node: g });
  }
  return out;
}
/** Объект группы, в котором лежат её accounts, texts, paused (для группы по умолчанию это сам config.json). */
function groupNode(cfg, gid = '') {
  if (!gid) return cfg;
  const g = (cfg.groups || []).find((x) => x && x.id === gid);
  if (!g) throw new Error('Такой группы уже нет: обнови виджет.');
  return g;
}
/** Аккаунты всех групп, у каждого _group (id) и _groupName. */
function allAccounts(cfg) {
  return groupList(cfg).flatMap((g) => (g.node.accounts || []).filter((a) => a && a.name).map((a) => ({ ...a, _group: g.id, _groupName: g.name })));
}
/** id группы из названия: латиница, цифры, - и _ (кириллица переводится), без повторов. */
function groupIdFor(name, taken = []) {
  const lat = String(name || '').toLowerCase().split('').map((c) => (c in TRANSLIT ? TRANSLIT[c] : c)).join('')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'group';
  let id = validGroupId(lat) ? lat : `g-${lat}`.slice(0, 32);
  for (let n = 2; taken.includes(id); n++) id = `${validGroupId(lat) ? lat : `g-${lat}`.slice(0, 28)}-${n}`;
  return id;
}
function checkWindow(start, end) {
  if (start != null && !HHMM.test(start)) return 'Начало окна: время в виде 10:00.';
  if (end != null && !HHMM.test(end)) return 'Конец окна: время в виде 22:00.';
  if (start && end && start.padStart(5, '0') >= end.padStart(5, '0')) return 'Окно публикаций: начало должно быть раньше конца.';
  return '';
}
/** Новая группа в config.json (объект меняется на месте). Возвращает группу. */
function createGroup(cfg, { name, day_start: ds = '', day_end: de = '' } = {}) {
  const title = String(name || '').trim().slice(0, 40);
  if (!title) throw new Error('Впиши название группы.');
  const list = groupList(cfg);
  if (list.some((g) => g.name.toLowerCase() === title.toLowerCase())) throw new Error(`Группа «${title}» уже есть.`);
  const err = checkWindow(ds || null, de || null);
  if (err) throw new Error(err);
  cfg.groups = Array.isArray(cfg.groups) ? cfg.groups : [];
  const g = { id: groupIdFor(title, [...list.map((x) => x.id), ...cfg.groups.map((x) => x && x.id)]), name: title, accounts: [], paused: [], texts: {} };
  if (ds) g.day_start = ds;
  if (de) g.day_end = de;
  cfg.groups.push(g);
  return g;
}
/** Переименовать группу, поменять её окно публикаций. Для группы по умолчанию окно = общее окно config.json. */
function updateGroup(cfg, gid, { name, day_start: ds, day_end: de } = {}) {
  const node = groupNode(cfg, gid);
  if (name !== undefined) {
    const title = String(name || '').trim().slice(0, 40);
    if (!title) throw new Error('Впиши название группы.');
    if (groupList(cfg).some((g) => g.id !== gid && g.name.toLowerCase() === title.toLowerCase())) throw new Error(`Группа «${title}» уже есть.`);
    if (gid) node.name = title; else if (title === DEFAULT_GROUP_NAME) delete cfg.group_name; else cfg.group_name = title;
  }
  const err = checkWindow(ds === undefined || ds === '' ? null : ds, de === undefined || de === '' ? null : de)
    || checkWindow(ds || node.day_start || cfg.day_start || '10:00', de || node.day_end || cfg.day_end || '22:00');
  if (err) throw new Error(err);
  for (const [k, v] of [['day_start', ds], ['day_end', de]]) {
    if (v === undefined) continue;
    if (v) node[k] = v; else if (gid) delete node[k]; // пусто: как в основной группе
  }
  return node;
}
/** Убрать группу: только пустую (без аккаунтов). Папки очередей проверяет вызывающий. */
function removeGroup(cfg, gid) {
  if (!gid) throw new Error('Основную группу убрать нельзя.');
  const g = groupNode(cfg, gid);
  if ((g.accounts || []).length) throw new Error(`В группе «${g.name || gid}» ещё есть аккаунты: сначала убери их.`);
  cfg.groups = cfg.groups.filter((x) => x !== g);
  return g;
}

module.exports = {
  DEFAULT_GROUP_NAME, groupList, groupNode, allAccounts, groupIdFor, createGroup, updateGroup, removeGroup, checkWindow,
  TT_SCOPES, IG_SCOPES, FB_SCOPES, facebookAuthUrl, facebookGuide, instagramChoices, planInstagramBatch, secretSuffix, secretNameFor, cleanName, suggestName, nameError, upsertAccount, removeAccount, tokenEnvOf,
  tiktokAuthUrl, instagramAuthUrl, isRedirect, parseRedirect, needsBrowser, accountHealth,
};
