# TikTok: тексты для проверки приложения

У TikTok две разные проверки:

1. **App review**: чтобы приложение стало боевым (Production). Нужна, только если в песочнице загрузка в черновики не заработает.
2. **Direct Post audit**: чтобы ролики публиковались сами и открыто. Нужна только для режима `direct`.

**Честно о шансах.** В правилах TikTok (Content Sharing Guidelines) недопустимым назван
«A utility tool to help upload contents to the account(s) you or your team manages», а приложение должно быть
«intended for a wide audience». Наш автопостер сейчас именно личный инструмент, поэтому аудит Direct Post
в нынешнем виде почти наверняка отклонят. Писать в заявке, что это продукт для многих пользователей, пока это не так, нельзя:
TikTok смотрит демо-видео и может заблокировать приложение. Тексты ниже описывают приложение как есть.

---

## 1. App review (Login Kit + Content Posting API: Upload)

**App description** (поле Description, до 120 символов):

> Schedule your own short videos and send them to your TikTok inbox to review and post.

**Explain how each product and scope works in your app** (поле для ревьюера):

> Reels Autoposter is a scheduling tool for creators who publish their own original short videos (vertical clips cut
> from their own long-form videos) on several platforms. The creator puts the video files and captions into their
> own queue (a GitHub repository they control, managed through a small desktop app). At the time slot the creator
> chose, the app uploads the next video to the creator's TikTok account.
>
> - **Login Kit**, scope **user.info.basic**: the creator connects their TikTok account once. We read the open ID,
>   display name and username only to show which account is connected and to confirm the connection works.
> - **Content Posting API (Upload)**, scope **video.upload**: the app uploads the scheduled video with
>   `/v2/post/publish/inbox/video/init/` (FILE_UPLOAD). The video lands in the creator's TikTok inbox; the creator
>   gets a notification, edits the caption, cover, sound and privacy in the TikTok app and posts it themselves.
>   The app never publishes on its own, never posts content of other creators, and adds no watermarks.
>
> The app respects the limit of 5 pending shares per 24 hours: it pauses TikTok uploads and tells the creator to
> finish the pending drafts first. Tokens are stored only as encrypted secrets in the creator's own repository.

**Demo video** (одно видео 1-3 минуты, запись экрана, без монтажа):

1. Показать виджет: очередь папок и план дня.
2. Показать config.json с аккаунтом TikTok и запуск workflow «TikTok: подключить аккаунт» → страница входа TikTok → «Разрешить» (виден запрос scopes).
3. Запуск «Публикация рилсов» (`post --only short-1`), лог: «Ролик в черновиках TikTok».
4. Телефон: уведомление TikTok → черновик → правка подписи → «Опубликовать».
5. Виджет: у аккаунта TikTok статус «в черновиках».

Домен сайта, Terms и Privacy: сайт https://frizy229.github.io/autopostreels/ (GitHub Pages).

---

## 2. Direct Post audit (позже, если решим)

Чтобы был реальный шанс, приложение сначала нужно доработать, иначе описывать нечего:

1. В виджете экран «Публикация в TikTok» для каждого ролика: ник аккаунта (из `creator_info`), подпись (можно править),
   выбор приватности **без значения по умолчанию** (только варианты от API), переключатели «Комментарии», «Дуэт»,
   «Стежок» (по умолчанию выключены, недоступные серые), переключатель «Рекламный контент» с вариантами
   «Ваш бренд» / «Брендированный контент», превью видео и текст:
   «By posting, you agree to TikTok's Music Usage Confirmation».
2. Ролик уходит в TikTok только после кнопки «Запланировать» на этом экране, в выбранное время.
3. Вход через TikTok для любого автора, не только для наших аккаунтов, и публичная страница приложения.
4. Статус публикации виден в виджете (обработка может занять несколько минут).

Черновик текста для этой заявки (подходит только после доработки):

> Reels Autoposter is a cross-platform scheduler for creators who repurpose their own long-form videos into short
> vertical clips. For every clip the creator opens the TikTok post screen in our desktop app, which shows their
> TikTok nickname and live creator settings, lets them edit the title, choose the privacy level (no default),
> toggle comments, Duet and Stitch, disclose commercial content, preview the video and confirm the Music Usage
> Confirmation. Only after the creator presses "Schedule" is the clip stored for publishing; at the chosen time the
> app calls `/v2/post/publish/video/init/` with exactly the settings the creator selected and shows the publish
> status in the app. We request `video.publish` for this Direct Post flow and `user.info.basic` to display the
> connected account.
