# PDF-шлюз КузовPRO: восстановление операций

[Серверный Draft PR #3](https://github.com/Grigori84/-KuzovPRO-PDF-Test./pull/3).
Кандидат 0.2.0, ветка `fix/pdf-gateway-recovery` от серверного PR #1
(`feat/simple-single-bucket-pdf-gateway`, `54a7e63`). **Этот код не развёрнут.**
Шлюз должен оставаться `gateway-disabled` до отдельного разрешения владельца.
Основной успешный Samsung-тест прежней версии уже выполнен; он не доказывает
восстановление новых аварийных состояний или совместимость multipart с Yandex.

Одна приватная Cloud Function, два существующих бакета, тот же PDF.js и URL.
IAM, ключи, конфигурация бакетов, маршруты и записи клиентов здесь не менялись.
Текущая авторизация использует прежний ephemeral credential provider; постоянные
S3/IAM-ключи не нужны в исходниках и APK.

## Что исправлено

- `begin_v2` сначала условно сохраняет неизменяемую связь
  `begin-requests/<device>/<request_id>.json` → ID, размер, MD5 и SHA-256,
  затем создаёт `control/<id>.json`. Потерянный ответ и конкурентные попытки
  с тем же ключом получают тот же ID и свежий PUT-билет. Иной контент с тем же
  ключом — 409. Отозванная операция — 410 с её ID/ключом, без нового билета.
- `publishing` больше не является вечной блокировкой для новых записей v2.
  Публичная запись использует одноразовый multipart UploadId, сохранённый через
  CAS **до** отправки данных/Complete. Повтор сверяет фактические байты/SHA-256
  и токен владельца, завершает тот же upload или восстанавливает тот же ID.
- Отзыв сначала фиксирует `revoking`, закрывает известный UploadId через Abort,
  требует `ListParts → NoSuchUpload`, проверяет принадлежность объекта, удаляет
  его и подтверждает отсутствие, затем сохраняет `revoked`. Поздний Complete
  не должен воскресить PDF. Нужная семантика Yandex — обязательная живая проверка.
- CAS/ETag, подпись P-256, timestamp ±90 сек, одноразовый nonce и проверка PDF
  сохранены. Повтор HTTP с прежним nonce даёт 409; восстановление операции
  использует **новый nonce**, прежний request_id/ID и неизменный контент.
- `control/` и `begin-requests/` не удаляются, включая tombstone. Возраст записи
  не служит разрешением снять блокировку. Чужой/несовпадающий объект не удаляется.

## API и совместимость

Все операции: подписанный `POST /pdf`, прежние четыре заголовка
`x-kpro-device`, `x-kpro-time`, `x-kpro-nonce`, `x-kpro-signature`.
Подпись: SHA256withECDSA над UTF-8 `<time>\n<nonce>\n<SHA256(raw JSON)>`.
PDF 20 байт–10 МиБ, PUT-билет 300 сек, неизменные signed headers.

| Операция | Поля JSON кроме operation | Ответ |
| --- | --- | --- |
| `begin` | `bytes`, `md5_base64` | прежний `id`, `upload_url`, `headers`, `expires_seconds` |
| `begin_v2` | те же + `request_id` (32 lowercase hex), `sha256` (64 lowercase hex) | тот же ответ + подтверждённый `request_id` |
| `publish` | `id`, `bytes`, `sha256` | 200: `id`, `url`, `already_published` |
| `revoke` | `id` | 200: `id`, `revoked:true` |

Установленная **Android 1.1.1/code 22** совместима с legacy begin/publish/revoke
и получает серверное восстановление publishing для v2 control. Но она не
сохраняет ключ begin и блокирует повтор неизвестного begin: исправить это только
сервером нельзя. [Отдельное минимальное обновление, PR #40](https://github.com/Grigori84/KuzovPRO/pull/40), **1.1.2/code 23** сохраняет ключ
до HTTP и использует `begin_v2`; не откатывается на `begin`, если сервер старый.
Операция названа отдельно, поскольку старый сервер игнорировал бы новое поле
в legacy begin и мог выдать второй ID. Прежний `BEGIN_UNKNOWN` без ключа остаётся
операторским случаем; нельзя задним числом присвоить ему новый ключ/ID.

Старые control v1 с raw PUT автоматически не разблокируются. По умолчанию
`LEGACY_WRITERS_DRAINED=false`: изменение/отзыв v1 возвращает 409
`LEGACY_WRITERS_NOT_DRAINED`. Уже опубликованный v1 можно подтвердить чтением.
После **доказанного** завершения прежних исполнителей/сетевых записей и отдельно
разрешённой установки флага новый код сверяет реальный объект и CAS-переводит
v1 в v2; совпавший PDF завершает публикацию, отсутствие позволяет продолжить
тот же ID (при наличии staging) либо отозвать; несовпадение блокирует запись.

Ключевые ответы для повтора: `STATE_CHANGED_RETRY`, `PUBLICATION_RETRY_SAME_ID`,
`REVOCATION_IN_PROGRESS` — продолжать только прежнюю операцию. Ошибки сети,
403/5xx, отсутствие ETag или неподтверждённый Abort не являются успехом.
SMS допускается только после publish 200 и клиентской проверки точного PDF.

## Проверки и сборка

```bash
cd simple-gateway
npm ci --ignore-scripts --no-audit --no-fund
npm test
python3 scripts/build-release.py
```

Node.js 22.23.5: **73 теста, 73 pass, 0 failures/skips** с настоящими SDK/pdf-lib
и имитацией хранилища/сетевых сбоев. Подробности и границы доказательств:
[RECOVERY_VALIDATION_RU.md](RECOVERY_VALIDATION_RU.md).
CI `PDF gateway recovery tests` выполняет этот набор без облачных секретов;
сам GitHub job здесь не засчитывается как выполненный.
Пакет фиксируется `package-lock.json`; локальный ZIP содержит runtime-файлы,
production node_modules и manifest, не тесты, ключи или deploy-команды.

**Порядок Work, частная проверка Object Storage и откат:**
[WORK_RECOVERY_ROLLOUT_RU.md](WORK_RECOVERY_ROLLOUT_RU.md).
Старые инструкции сохранены только как [история v1](README_V1_HISTORY.md).
