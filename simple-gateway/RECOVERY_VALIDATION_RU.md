# Recovery-кандидат: проверка и оставшиеся блокеры

11.11.2026. Кодовый commit `d9cddbefa502319172f3030d1087189569fe2a4e`,
[Draft PR #3](https://github.com/Grigori84/-KuzovPRO-PDF-Test./pull/3),
база серверного PR #1 `54a7e6340847695c845b2560f25d07bbf99ef513`.
Это исходники/локальная проверка, **не развёрнутая и не принятая эксплуатация**.

## Фактически выполнено

Node.js **22.23.5**, `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`:
**73 tests, 73 pass, 0 fail/cancelled/skipped**. Настоящие AWS SDK 3.1166.0,
pdf-lib 1.17.1, реальные P-256 подписи, но хранилище/HTTP faults подставные.
Исходный набор до изменений: 25 tests, 24 pass, 1 fail; selftest fixture выставлял
bucket env после require и проверял не ту ветвь. Исправлен порядок fixture,
production guard не ослаблен.

| Область | Покрытие |
| --- | --- |
| begin | Потери ответа mapping/control/билета; restart; конкурентные 8 запросов; один key→один ID; конфликт размера/MD5/SHA; namespace двух мастеров |
| auth | Реальная подпись raw JSON, nonce replay409, свежий nonce для восстановления, time/изменённое тело/чужой device |
| publishing | Остановка до part/Complete; потеря ответа Complete/CAS; отсутствующий/готовый объект; потерянный multipart upload; immutable hash; фактический SHA |
| revoke | Complete параллельно отзыву, поздний ответ/повтор, прерывание delete/finalCAS, повторный revoke, tombstone не оживает |
| legacy | fail-closed без доказанного drain; совпавший/отсутствующий/чужой объект после drain; опубликованный v1 читается без мутации |
| SDK | Реальные command inputs и сериализация If-None-Match для Complete; Abort+ListParts; ETag; missing bucket/access denied не равны отсутствию PDF |
| private diagnostic | Синтетические IDs, очистка/retained tombstone; игнорирование conditional и неподтверждённый Abort дают FAIL; публичный selftest-вызов запрещён |
| прежние функции | Парсер/границы PDF, заголовки signed PUT, ephemeral credential provider, выключенный gateway |

Локальный ZIP построен дважды из чистого кодового commit с одинаковым SHA:

- `kuzovpro-simple-pdf-gateway-0.2.0-d9cddbefa502.zip`, **8 805 698 байт**.
- SHA-256: `92a38ae456a05193c4e5f202d5d2e4653bfe26bdc008149af34dc79c9c6ab805`.
- Production runtime-файлы/dependencies и RELEASE-MANIFEST; без tests/секретов.
  Скрипт `scripts/build-release.py` ничего не загружает в облако.

[Отдельный Android PR #40](https://github.com/Grigori84/KuzovPRO/pull/40), commit `15c873f`, 1.1.2/code 23 на базе #38 `5f8ed7e`:
**114 JVM pass**, 4 Python gate pass; lintDebug/lintSandbox, assembleDebug и
assembleDebugAndroidTest успешны. Полный AndroidTest скомпилирован, **не запущен**
из-за отсутствияKVM; подписанный Codemagic/установка23 здесь не выполнялись.
Установленная1.1.1/code 22 и сохранность данных подтверждены владельцем ранее.

## Блокеры постоянной работы

1. **Реальный контракт Yandex S3 и прежние права.** Локальная модель предполагает
   линейный CAS, conditional Complete и терминальный Abort/ListParts. Перед
   включением нужны приватные checks и подтверждённая семантика провайдера по
   [инструкции Work](WORK_RECOVERY_ROLLOUT_RU.md), без расширения IAM автоматически.
2. **Старый v1 publishing.** Raw PUT нельзя задним числом оградить multipart.
   Пока не доказан drain всех старых запросов, изменения v1 намеренно409.
   Не снимать блокировку по возрасту/HEAD 404 и не менять клиентские записи вручную.
3. **Lost begin клиента 22.** Новый ключ нужно сохранить до первогоHTTP: только
   минимальный клиент23 даёт автоматический retry. Уже неизвестный begin без
   ключа остаётся отдельной операторской сверкой. Код23 требует `begin_v2`;
   со старым сервером получает ошибку без fallback/новогоlegacyID.
4. **Приёмка нового поведения.** Нужны реальный Android/Compose прогон на KVM,
   signed candidate 23 с прежним ключом и короткий device/fault/SMS тест после
   отдельного разрешения. Уже пройденный общий Samsung цикл не повторялся.
5. **Рабочая эксплуатация.** Отдельное разрешение на pinned рабочий тег/включение,
   второй рабочий ключ, процедура потериKeystore, проверка retention/nonce cleanup,
   квот/расходов и мониторинга. Предыдущие конфигурационные риски не объявлены
   исправленными этим PR. Возможные неизвестные пустые MPU после потерянного Create
   требуют отдельного операционного учёта; публичный PDF из них не создаётся.

Реальные клиентские PDF/записи, API Gateway, IAM, бакеты/ключи не изменялись.
Ни один локальный PASS не является разрешением включить постоянный маршрут.
