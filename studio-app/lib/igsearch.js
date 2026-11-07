'use strict';
// Поиск рилсов Instagram по хэштегу через официальный Graph API Meta (Instagram Hashtag Search).
// Открытого поиска без входа у Instagram нет, а поиск «под своим логином» Instagram быстро блокирует.
// Нужен токен Instagram через Facebook (как IG_TOKEN автопостера): право instagram_basic и
// доступ к функции «Instagram Public Content Access» у приложения. Лимит Meta: 30 разных хэштегов за 7 дней
// на аккаунт (повторный поиск того же хэштега не считается).

const API = 'https://graph.facebook.com/v23.0';
const FIELDS = 'id,media_type,caption,permalink,like_count,comments_count,timestamp,media_url';

/** Запрос → хэштеги: «#казино #эвелон» → [казино, эвелон]; «эвелон казино» → [эвелонказино]. До 3. */
function hashtagsOf(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  const tags = s.includes('#') ? s.split('#').map((t) => t.trim().split(/\s+/)[0]) : [s.replace(/\s+/g, '')];
  return [...new Set(tags.map((t) => t.replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean))].slice(0, 3);
}

/** Понятный текст ошибки Graph API. */
function igError(j, status) {
  const e = (j && j.error) || {};
  const m = e.message || `HTTP ${status}`;
  if (e.code === 190) return 'Токен Instagram недействителен или истёк: вставь новый в Настройках → «Поиск в Instagram».';
  if (e.code === 10 || e.code === 200 || /permission|public content/i.test(m)) {
    return `Meta не даёт искать по хэштегам: функция «Instagram Public Content Access» у твоего приложения не одобрена (нужна проверка Meta, это долго и не всегда проходит).\n`
      + 'Что можно уже сейчас: 1) ищи по аккаунту: напиши @ник или вставь ссылку на профиль (работает для публичных бизнес- и авторских аккаунтов, ревью не нужно); '
      + '2) вставь ссылки на нужные рилсы в поле «Добавить по ссылке» вверху.';
  }
  if (e.code === 24 || /30 unique hashtags|hashtag.*limit/i.test(m)) return 'Лимит Meta: не больше 30 разных хэштегов за 7 дней на аккаунт. Ищи по уже использованным хэштегам или подожди.';
  if (e.code === 4 || e.code === 17 || e.code === 32) return 'Meta временно ограничила запросы: подожди несколько минут.';
  return `Instagram (Meta): ${m}`;
}

async function getJson(fetch, url) {
  const r = await fetch(url);
  let j = null;
  try { j = await r.json(); } catch { /* не JSON */ }
  if (!r.ok || !j || j.error) throw Object.assign(new Error(igError(j, r.status)), { code: 'IG', meta: j && j.error });
  return j;
}

/** Найти Instagram-аккаунт токена: [{id, username}] (Страницы Facebook с привязанным Instagram). */
async function igAccounts(fetch, token) {
  const j = await getJson(fetch, `${API}/me/accounts?fields=instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(token)}`);
  const list = (j.data || []).map((p) => p.instagram_business_account).filter(Boolean).map((a) => ({ id: String(a.id), username: a.username || '' }));
  if (list.length) return list;
  // токен системного пользователя или Страницы может не видеть /me/accounts — тогда user_id вводится вручную
  return [];
}

/** Рилс (видео) из ответа Graph API → карточка выдачи. */
function normMedia(m, tag) {
  const cap = String(m.caption || '').trim();
  const first = cap.split('\n').map((x) => x.trim()).find(Boolean) || '';
  return {
    id: String(m.id), url: m.permalink || '', title: first.slice(0, 120) || `#${tag}`, duration: 0,
    channel: `#${tag}`, views: Number(m.like_count) || 0, likes: Number(m.like_count) || 0, comments: Number(m.comments_count) || 0,
    thumb: '', date: m.timestamp ? String(m.timestamp).slice(0, 10).replace(/-/g, '') : '', platform: 'instagram', kind: 'reel',
  };
}

/** Аккаунты из запроса: «@ник», «instagram.com/ник» (без /reel/ и /p/). До 3. */
function accountsOf(q) {
  const out = [];
  const s = String(q || '');
  for (const m of s.matchAll(/instagram\.com\/(?!reels?\/|p\/|tv\/|stories\/|explore\/)([\w.]+)/gi)) out.push(m[1]);
  for (const m of s.matchAll(/(?:^|\s)@([\w.]{2,30})/g)) out.push(m[1]);
  return [...new Set(out.map((x) => x.toLowerCase().replace(/\.$/, '')))].slice(0, 3);
}

/**
 * Рилсы публичного бизнес- или авторского аккаунта через business_discovery (право instagram_basic, без Public Content Access).
 * Личные аккаунты Meta не отдаёт.
 */
async function searchAccount(fetch, cfg, name, { limit = 50 } = {}) {
  const tok = encodeURIComponent(cfg.token), uid = encodeURIComponent(cfg.userId);
  const fields = `business_discovery.username(${name}){username,media.limit(${limit}){id,media_type,caption,permalink,like_count,comments_count,timestamp,thumbnail_url}}`;
  let j;
  try { j = await getJson(fetch, `${API}/${uid}?fields=${encodeURIComponent(fields)}&access_token=${tok}`); } catch (e) {
    const m = (e.meta && e.meta.message) || e.message;
    if (e.code === 'IG' && (e.meta && (e.meta.code === 110 || e.meta.code === 100 || e.meta.error_subcode === 2207013) || /business_discovery|Invalid user id|cannot be accessed|username/i.test(m))) {
      throw Object.assign(new Error(`Аккаунт @${name} не найден или личный: Meta отдаёт только публичные бизнес- и авторские аккаунты. Для остальных вставляй ссылки на рилсы.`), { code: 'IG' });
    }
    throw e;
  }
  const media = (((j.business_discovery || {}).media || {}).data) || [];
  return media.filter((m) => m.media_type === 'VIDEO' && m.permalink).map((m) => ({ ...normMedia(m, name), channel: `@${name}`, title: String(m.caption || '').split('\n').map((x) => x.trim()).find(Boolean)?.slice(0, 120) || `@${name}`, thumb: m.thumbnail_url || '' }));
}

/** Instagram: если в запросе есть @ник или ссылка на профиль — по аккаунту, иначе по хэштегу. */
async function searchInstagram(fetch, cfg, q, o = {}) {
  const names = accountsOf(q);
  if (!names.length) return searchHashtags(fetch, cfg, q, o);
  if (!cfg || !cfg.token || !cfg.userId) throw Object.assign(new Error('Поиск в Instagram не настроен: вставь токен в Настройках → «Поиск в Instagram».'), { code: 'IG_SETUP' });
  const out = [], errs = [];
  for (const n of names) {
    try { out.push(...await searchAccount(fetch, cfg, n, o)); } catch (e) { errs.push(e.message); }
  }
  if (!out.length) throw new Error(errs.join('\n') || `У @${names.join(', @')} нет рилсов.`);
  return out.sort((a, b) => b.likes - a.likes).slice(0, o.limit || 50);
}

/**
 * Поиск: для каждого хэштега — популярные (top_media) и свежие (recent_media) публикации, только видео.
 * cfg: {token, userId}. Возвращает карточки без повторов, по лайкам.
 */
async function searchHashtags(fetch, cfg, q, { limit = 50 } = {}) {
  if (!cfg || !cfg.token || !cfg.userId) throw Object.assign(new Error('Поиск в Instagram не настроен: вставь токен в Настройках → «Поиск в Instagram».'), { code: 'IG_SETUP' });
  const tags = hashtagsOf(q);
  if (!tags.length) throw new Error('Для Instagram напиши хэштег, например «#evelone» или «эвелон».');
  const tok = encodeURIComponent(cfg.token), uid = encodeURIComponent(cfg.userId);
  const out = [], seen = new Set(), missing = [];
  for (const tag of tags) {
    // eslint-disable-next-line no-await-in-loop
    const h = await getJson(fetch, `${API}/ig_hashtag_search?user_id=${uid}&q=${encodeURIComponent(tag)}&access_token=${tok}`);
    const hid = h.data && h.data[0] && h.data[0].id;
    if (!hid) { missing.push(tag); continue; }
    for (const edge of ['top_media', 'recent_media']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await getJson(fetch, `${API}/${hid}/${edge}?user_id=${uid}&fields=${FIELDS}&limit=50&access_token=${tok}`);
      for (const m of r.data || []) {
        if (m.media_type !== 'VIDEO' || !m.permalink || seen.has(m.permalink)) continue;
        seen.add(m.permalink);
        out.push(normMedia(m, tag));
      }
    }
  }
  if (!out.length && missing.length === tags.length) throw new Error(`Хэштега ${tags.map((t) => `#${t}`).join(', ')} в Instagram нет.`);
  return out.sort((a, b) => b.likes - a.likes).slice(0, limit);
}

module.exports = { API, accountsOf, searchAccount, searchInstagram, hashtagsOf, igError, igAccounts, normMedia, searchHashtags };
