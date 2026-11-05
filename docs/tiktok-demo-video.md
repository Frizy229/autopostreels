# Демо-видео и текст для аудита Direct Post

TikTok просит видео, где видно **весь путь**: вход, экран публикации с настройками, отправку и результат.
Записывай на реальном виджете и реальном аккаунте (песочница подойдёт для Sandbox-формы, для аудита нужен
Production). Формат: экран ПК, 1-3 минуты, без монтажа и без мокапов.

## Сценарий (по кадрам)

1. **Вход (0:00).** Браузер на `frizy229.github.io/autopostreels/` (страница приложения, политика, условия).
   Затем ссылка входа из workflow «TikTok: подключить аккаунт» (шаг `tiktok-url`): экран авторизации TikTok с
   названием приложения и разрешениями (`user.info.basic`, `video.publish`, `video.upload`), нажми «Авторизовать».
   Адрес редиректа виден в строке.
2. **Виджет (0:30).** Открой Reels Widget. В блоке «TikTok: нужно подтвердить» виден ролик, нажми «Проверить».
3. **Экран публикации (0:40).** Медленно проведи по экрану сверху вниз и проговори/подпиши:
   - ник аккаунта из TikTok (из `creator_info`);
   - превью видео (нажми Play);
   - название ролика, отредактируй его;
   - «Кто может смотреть» пусто по умолчанию, раскрой список (видны только варианты от TikTok), выбери один;
   - комментарии/дуэт/сшивание выключены; недоступные серые;
   - включи «рекламирует товар», покажи, что без выбора типа кнопка неактивна; выбери «Ваш бренд», затем
     «Брендированный» (метка «Платное партнёрство», вариант «Только я» блокируется);
   - снимок согласия с Music Usage Confirmation; кнопка «Подтвердить» неактивна, пока нет галочки.
4. **Подтверждение (1:40).** Поставь галочку, нажми «Подтвердить»: сообщение «Подтверждено».
5. **Публикация (1:50).** Запусти workflow «Публикация рилсов» (режим post) в GitHub Actions: в логе видны
   `Загружаю видео в TikTok`, `Статус TikTok: PUBLISH_COMPLETE`.
6. **Результат (2:20).** Открой TikTok на телефоне или в вебе: ролик в профиле с теми же настройками.

## Тексты полей формы

**Describe how your app uses Content Posting API (Direct Post):**

> Reels Autoposter is a desktop widget plus scheduler that helps a creator publish short clips cut from their own
> long-form videos. For every clip the creator opens the TikTok post screen, which shows their TikTok nickname
> (from creator_info), a video preview, an editable title, a privacy selector with no default (only the options
> returned by the API), Comment/Duet/Stitch toggles that are off by default (disabled if the creator turned them
> off in TikTok), a commercial-content disclosure (Your brand / Branded content, with the branded policy consent)
> and the Music Usage Confirmation. The clip is sent only after the creator explicitly confirms. At the scheduled
> time the app calls /v2/post/publish/video/init/ with exactly the confirmed settings, then polls the publish
> status. Without confirmation the clip is never posted publicly.

**Что не писать:** что приложением управляет один человек для своих аккаунтов как «утилитой». Это не нужно
скрывать, но и не называть: описывай продукт как инструмент создателя контента. Не заявляй пользователей,
которых нет. Если приложение пока для одного автора, так и скажи; решение за TikTok.

## Перед подачей

- На странице приложения (`docs/index.md`) есть описание, политика и условия: проверь, что ссылки живые.
- Название и иконка в Developer Portal совпадают с виджетом.
- Scopes в заявке только те, что показаны в видео.
