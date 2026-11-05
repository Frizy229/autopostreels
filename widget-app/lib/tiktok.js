'use strict';
// Экран подтверждения публикации в TikTok (требования Direct Post API): логика без интерфейса.

const PRIVACY_LABEL = {
  PUBLIC_TO_EVERYONE: 'Все',
  MUTUAL_FOLLOW_FRIENDS: 'Друзья (взаимные подписки)',
  FOLLOWER_OF_CREATOR: 'Подписчики',
  SELF_ONLY: 'Только я',
};
const MUSIC_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

/** Подпись согласия: зависит от выбранного типа коммерческого контента. */
function consentText(commercial) {
  const c = commercial || {};
  if (c.on && c.branded) return { text: 'Публикуя, я принимаю Политику брендированного контента и Подтверждение использования музыки TikTok.', links: [BRANDED_URL, MUSIC_URL] };
  return { text: 'Публикуя, я принимаю Подтверждение использования музыки TikTok.', links: [MUSIC_URL] };
}

/** Подсказка при включённом коммерческом контенте. */
function commercialLabel(commercial) {
  const c = commercial || {};
  if (!c.on) return '';
  if (c.your_brand && c.branded) return 'Ваш ролик будет помечен как «Платное партнёрство».';
  if (c.branded) return 'Ваш ролик будет помечен как «Платное партнёрство».';
  if (c.your_brand) return 'Ваш ролик будет помечен как «Продвижение собственного бренда».';
  return '';
}

/** Варианты приватности строго из creator_info (без значения по умолчанию). */
function privacyOptions(creator) {
  return ((creator && creator.privacy_level_options) || []).map((v) => ({ value: v, label: PRIVACY_LABEL[v] || v }));
}

/** Проверка формы. Возвращает список ошибок (пусто = можно публиковать). */
function validate(form, creator) {
  const errs = [];
  const f = form || {};
  const options = (creator && creator.privacy_level_options) || [];
  if (!f.title || !String(f.title).trim()) errs.push('Укажите название ролика.');
  if (String(f.title || '').length > 2200) errs.push('Название длиннее 2200 символов.');
  if (!f.privacy_level) errs.push('Выберите, кто может смотреть ролик.');
  else if (options.length && !options.includes(f.privacy_level)) errs.push('Эта настройка приватности вам недоступна.');
  const c = f.commercial || {};
  if (c.on && !(c.your_brand || c.branded)) errs.push('Для коммерческого контента выберите «Ваш бренд» или «Брендированный контент».');
  if (c.on && c.branded && f.privacy_level === 'SELF_ONLY') errs.push('Брендированный контент нельзя сделать приватным.');
  if (!f.consent) errs.push('Нужно подтвердить согласие с условиями TikTok.');
  return errs;
}

/** Содержимое <имя>.tiktok.json, которое читает автопостер. */
function toSettings(form, creator) {
  const errs = validate(form, creator);
  if (errs.length) throw new Error(errs.join(' '));
  const c = form.commercial || {};
  return {
    consent: true,
    consent_at: new Date().toISOString(),
    title: String(form.title).trim(),
    privacy_level: form.privacy_level,
    disable_comment: creator && creator.comment_disabled ? true : !form.allow_comment,
    disable_duet: creator && creator.duet_disabled ? true : !form.allow_duet,
    disable_stitch: creator && creator.stitch_disabled ? true : !form.allow_stitch,
    commercial: { on: !!c.on, your_brand: !!(c.on && c.your_brand), branded: !!(c.on && c.branded) },
    is_aigc: !!form.is_aigc,
  };
}

const stemOf = (p) => p.replace(/\.[^./]+$/, '');

/**
 * Какие рилсы ждут подтверждения: прямой TikTok-аккаунт, ещё не опубликовано, нет .tiktok.json.
 * queue: [{name, videos, tiktok:[пути *.tiktok.json]}], accounts: из config.json.
 */
function pendingConfirm(queue, state, accounts) {
  const posted = (state && state.posted_acc) || {};
  const skipped = (state && state.skipped) || {};
  const tts = (accounts || []).filter((a) => a && (a.platform || '').toLowerCase() === 'tiktok' && (a.mode || 'inbox') === 'direct');
  const out = [];
  for (const f of queue || []) {
    const done = new Set(f.tiktok || []);
    for (const v of f.videos || []) {
      const parts = v.split('/');
      const sub = parts.length > 1 ? parts[0].toLowerCase().replace(/^@/, '') : '';
      const targets = tts.filter((a) => !sub || sub.includes(String(a.name).toLowerCase()));
      for (const a of targets) {
        const id = `${f.name}/${v}`;
        if ((posted[a.name] || {})[id] || `${a.name}|${id}` in skipped) continue;
        if (done.has(`${stemOf(v)}.tiktok.json`)) continue;
        out.push({ folder: f.name, video: v, account: a.name, path: `queue/${f.name}/${stemOf(v)}.tiktok.json` });
        break; // один файл настроек на ролик
      }
    }
  }
  return out;
}

module.exports = { PRIVACY_LABEL, MUSIC_URL, BRANDED_URL, consentText, commercialLabel, privacyOptions, validate, toSettings, pendingConfirm };
