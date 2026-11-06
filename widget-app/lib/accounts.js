'use strict';
// Аккаунты соцсетей: добавление кнопкой в виджете (вход, токен в секрет GitHub, запись в config.json) и их состояние.
// Логика без Electron, чтобы её можно было проверить тестами.

const TT_SCOPES = 'user.info.basic,video.upload';
const IG_SCOPES = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights';
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
function nameError(name, accounts = [], platform = '', keep = '') {
  if (!name) return 'Впиши ник аккаунта.';
  if (/^\./.test(name)) return 'Ник не может начинаться с точки.';
  const clash = accounts.find((a) => a && a.name && a.name.toLowerCase() === name.toLowerCase() && a.name !== keep);
  if (clash && (clash.platform || 'instagram') !== platform) return `Ник @${name} уже занят аккаунтом ${clash.platform === 'tiktok' ? 'TikTok' : 'Instagram'}: впиши другой (например, ${name}_${platform === 'tiktok' ? 'tt' : 'ig'}).`;
  return '';
}

/**
 * Добавить или переподключить аккаунт в config.json (объект меняется на месте).
 * Тот же ник или тот же аккаунт соцсети (open_id / user_id) = переподключение: имя и секрет остаются прежними.
 * Возвращает { account, replaced }.
 */
function upsertAccount(cfg, entry) {
  cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const platform = entry.platform === 'tiktok' ? 'tiktok' : 'instagram';
  const samePlatform = (a) => (a.platform || 'instagram').toLowerCase() === platform;
  const idKey = platform === 'tiktok' ? 'open_id' : 'user_id';
  let i = cfg.accounts.findIndex((a) => a && samePlatform(a) && entry[idKey] && String(a[idKey] || '') === String(entry[idKey]));
  if (i < 0) i = cfg.accounts.findIndex((a) => a && samePlatform(a) && a.name.toLowerCase() === String(entry.name).toLowerCase());
  const old = i >= 0 ? cfg.accounts[i] : null;
  // первый аккаунт Instagram по старой схеме мог работать без token_env (IG_TOKEN): сохраняем как было
  const legacyEnv = old && i === 0 && platform === 'instagram' && !old.token_env ? 'IG_TOKEN' : '';
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

module.exports = {
  TT_SCOPES, IG_SCOPES, secretSuffix, secretNameFor, cleanName, suggestName, nameError, upsertAccount, removeAccount, tokenEnvOf,
  tiktokAuthUrl, instagramAuthUrl, isRedirect, parseRedirect, accountHealth,
};
