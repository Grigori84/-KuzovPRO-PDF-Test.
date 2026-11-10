# Безопасный первый запуск Yandex Cloud Functions

## Задача
Подтвердить, что среда выполнения Node.js 22 запускает обработчик из `smoke.js`. Это **не** функция загрузки, поэтому никаких секретов и доступа к бакету ей не нужно.

1. Открыть [Yandex Cloud Console](https://console.yandex.cloud), выбрать тот же каталог, где находится бакет `kuzovpro-pdf-test-84`.
2. Перейти в **Cloud Functions** → **Создать функцию**. Название `kuzovpro-upload-test`.
3. Создать версию: Node.js 22, точка входа `smoke.handler`. Код `smoke.js` скопировать из этого каталога (или загрузить небольшой ZIP).
4. Оставить функцию **приватной**, не выдавать роль вызова `All users`. Для теста не назначать сервисный аккаунт, переменные окружения и секреты.
5. Сохранить версию; проверить во вкладке **Тестирование**. Ожидается JSON с `"test":"function-ready"` и `"upload":"disabled"`.
6. Не переходить к `index.js` до настройки IAM доступа, Lockbox, S3 signing credentials и финализации загрузки.

Обязательное следующее действие перед настоящим тестом: создать **отдельный приватный staging-бакет** либо запретить публичное чтение для `staging/`. Текущий `kuzovpro-pdf-test-84` публично читает объекты; нельзя считать временные файлы конфиденциальными.

Поэтапная проверка лучше опасной публикации незавершённого endpoint. Сервис начнёт выдавать разрешения на загрузку только после отдельного внедрения авторизации владельца.

Документация:
- https://yandex.cloud/ru/docs/functions/quickstart/create-function/node-function-quickstart
- https://yandex.cloud/ru/docs/functions/operations/function/function-private
- https://yandex.cloud/ru/docs/functions/operations/function/function-invoke
