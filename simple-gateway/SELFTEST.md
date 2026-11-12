# Приватная recovery-диагностика без зависимости от логов

Актуальный порядок: [WORK_RECOVERY_ROLLOUT_RU.md, раздел 3](WORK_RECOVERY_ROLLOUT_RU.md#3-после-отдельного-разрешения--приватная-диагностика-с-durable-run-id).
Не развёртывать/не вызывать без отдельного разрешения владельца.

- Прежняя приватная функция, entrypoint selftest.handler; SELFTEST_ENABLED=true,
  GATEWAY_ENABLED=false, LEGACY_WRITERS_DRAINED=false, маршрут gateway-disabled.
- До вызова сохранить локальный случайный run_id (32 hex). Raw JSON содержит
  operation=recovery, action=prepare/status/run/cleanup, run_id.
- Prepare атомарно сохраняет весь план в selftest-runs/<run_id>.json до begin.
  Затем обязательно прочитать реестр и read-only status до разрешения run.
- Run одноразовый; после timeout только status/cleanup прежнего run-id.
  Control/tombstone/реестр не удаляются; поздний Create отслеживается по точному
  ключу. Неподтверждённый Create/PUT/Abort/CAS/403 — стоп, не CLEANED/PASS.
- HTTP-shaped события и старые незарегистрированные upload/publish/revoke запрещены.
- Это проверка synthetic storage/workflow, не реальная SMS/Android-приёмка.

Предыдущие инструкции доступны в истории Git. Старый ZIP d9cddbe не имеет
recoverable registry и не подходит для текущего Work-прохода.
