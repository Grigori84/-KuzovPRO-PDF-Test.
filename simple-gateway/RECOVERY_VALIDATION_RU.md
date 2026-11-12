# Recovery-кандидат: проверка и оставшиеся блокеры

## Актуальное дополнение 12.11.2026: диагностика без журналов

Исправлено [замечание владельца](https://github.com/Grigori84/-KuzovPRO-PDF-Test./pull/3#issuecomment-6814097611)
в том же PR #3. Код `f74164724bcfa8bdb3e21df5ec7fbad48af66a1c`.
До вызова Work сохраняет run-id; prepare условно записывает полный план пяти
синтетических ID/request_id/токенов в прежний закрытый бакет selftest-runs/.
Ни control, ни mapping, ни PDF/MPU не создаются до durable плана. Создание control
и потеря ответа больше не образуют окна неучтённого ID. Status — read-only;
cleanup повторяется по прежнему run-id без stdout/памяти исходного вызова.

Node.js 22.23.5: **89 tests, 89 pass, 0 fail/cancelled/skipped** (16 дополнительных
проверок сверх прежних 73). Проверены hard-timeout без выполнения finally до
возврата ID, до/после Create, до/после staging PUT, после Complete, потеря ответа
prepare/final cleanup CAS, одновременные run, foreign mapping/control/uploads,
exact-key/paginated multipart discovery и запрет незарегистрированных selftest
команд. Прерванный вызов оставлен заблокированным, независимый вызов читает
реестр/очищает; затем исходный поздний запрос освобождается и не создаёт PDF.

Неопределённый исход Create/PUT — **SELFTEST_PENDING_IO_RECHECK**, не CLEANED.
Все ключи остаются в реестре; повторная очистка может найти поздний пустой MPU
или фактический staging. Если исход не разрешается — остановка/поддержка, без
таймерного снятия блокировки. CLEANED не доказывает PASS прерванных проверок.
Неизменны production workflow/Abort/CAS/v1-409; false запрещает миграцию v1,
но позволяет новый v2 selftest. IAM/ключи/бакеты/боевой API не менялись.

ZIP собран дважды с одинаковым SHA-256:
`kuzovpro-simple-pdf-gateway-0.2.0-f74164724bcf.zip`, **8 807 735 байт**,
`bd146dad87b27ca498491fe9e8fe21a076c33df50a5aecce498990e554fa1cd2`.
Включён recovery-journal.js. Прежний ZIP d9cddbe не подходит для нового регламента.

**Можно передавать Work для подготовки приватной диагностики:** после отдельного
разрешения и обязательного prepare→чтение реестра→успешный status/list до run.
Отсутствие Cloud Logging само по себе больше не блокирует учёт. Если прежних
прав на реестр/list недостаточно, диагностика останавливается до создания PDF;
права автоматически не расширять. Развёртывание, запуск и смена маршрута здесь
не выполнялись; gateway-disabled не переключался.

## Историческая проверка 11.11.2026 до durable диагностического реестра


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
