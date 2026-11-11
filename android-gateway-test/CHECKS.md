# Фактические проверки — 11 ноября 2026, UTC

Debug APK **реально собран в рабочей среде**, через включённый Gradle Wrapper.
Это не сборка Codemagic и не проверка на Samsung.

Артефакт: `artifacts/kuzovpro-gateway-test-debug.apk`.
SHA-256:
`58f91c90009281427680e21a2d14ecaf2eb7e0af958a3bf8fa000335110b03e1`.

| Проверка | Результат |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` в `simple-gateway` | Успешно, lockfile согласован |
| `STAGING_BUCKET=offline-private PUBLIC_BUCKET=offline-public npm test` | 25/25 тестов, без сетевых вызовов |
| `./gradlew --no-daemon --max-workers=2 testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest` | BUILD SUCCESSFUL |
| JVM ProtocolTest | 6/6 |
| JVM GatewayTransportTest | 7/7 |
| Android lint 8.7.3 | 0 ошибок, 0 предупреждений |
| Gradle Wrapper / официальный Gradle 8.9 | Скачан и запущен; SHA-256 закреплён и проверен |
| `apksigner verify --verbose` | Verifies; APK Signature Scheme v2, 1 signer |
| `aapt dump badging` | `ru.kuzovpro.gatewaytest`, version `0.1-test`, minSdk 26, targetSdk 35, только INTERNET |
| `adb devices -l` | Подключённых устройств нет |
| `codemagic.yaml` | YAML разобран; путь проекта и отсутствие triggering/publishing проверены |

Среда фактической сборки: Linux amd64, OpenJDK 21.0.12.1, Node.js 24.19.0,
npm 11.9.0, Gradle 8.9, AGP 8.7.3, Kotlin 2.0.21, Android SDK 35,
Build Tools 35.0.0. Codemagic настроен на поддерживаемые Java 17 и Node 22;
сборка **в самом Codemagic не запускалась** — доступа к аккаунту нет.

Проверяется точный canonical, размер и MD5 синтетического набора, DER-подпись P-256,
защитные копии тела, повтор без вызова signer, совпадение фактически отправленных
байтов/заголовков, запрет redirects, ограничение ответа, сокрытие временного URL,
HTTP 401/409, ошибки DNS и чтения ответа без ложного успеха.

Тест совместимости передаёт одноразовую искусственную JVM-подпись через stdin
в Node.js и вызывает саму `auth()` из `simple-gateway/index.js` commit
`54a7e6340847695c845b2560f25d07bbf99ef513`:
подлинная подпись принимается, изменение байтов тела/nonce и timestamp старше
90 секунд отклоняются. Материал подписи не выводится в журналы.

Инструментальный `DeviceKeyTest` **скомпилирован, но не запускался**:
эмулятора и подключённого Samsung нет. Android Keystore, сохранение ID при
перезапуске реального приложения, UI на One UI и внешний HTTPS-вызов авторизованного
шлюза требуют испытания на телефоне по `README.md`.

Живой endpoint не вызывался, серверный ключ устройства не регистрировался.
IAM-токены и S3-ключи не использовались. PUT и publish не выполнялись.
Новые облачные ресурсы не создавались; настройки и состояние API Gateway не менялись.
Основной репозиторий КузовPRO не изменялся. Исходники сервера из PR №1 также
не изменялись; добавлен только `simple-gateway/package-lock.json` для `npm ci`.

APK — отладочный. Ветка содержит готовый файл для установки с телефона, чтобы
не требовать от владельца локальной среды. Закрытый ключ отладочного сертификата
сборки не хранится в Git и не является ключом устройства. ECDSA-ключ устройства
создаётся только при запуске установленного приложения.
