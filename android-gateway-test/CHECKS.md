# Проверки 0.2 PDF — 11 ноября 2026, UTC

Debug APK **фактически собран и проверен в Codex**, из исходников этой ветки.
Файл `artifacts/kuzovpro-gateway-test-debug.apk`, 916979 байт.
Версия `0.2-pdf-test` / versionCode 2, пакет `ru.kuzovpro.gatewaytest`, minSdk 26,
targetSdk 35, единственное разрешение INTERNET.

SHA-256: `f2f9a7ff334746e391f66f4229c137ec066bcb69074b7766fc61c26b6ed2e068`.

| Проверка | Результат |
| --- | --- |
| Gradle Wrapper 8.9: testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest | BUILD SUCCESSFUL |
| JVM-тесты приложения | **36/36**, без пропусков |
| Серверные офлайн-тесты PR №1 | **25/25** |
| Android lint 8.7.3 | **0 ошибок, 0 предупреждений** |
| apksigner verify | Verifies, APK Signature Scheme v2, один signer |
| Сертификат обновления | Совпадает с ранее выданным здесь APK 0.1 |
| aapt dump badging | Пакет/версия/API/разрешение проверены |
| codemagic.yaml | YAML разобран, нет triggering/publishing; workflow прежний |
| Инструментальные DeviceKeyTest и SyntheticPdfTest | Скомпилированы, **не запускались** |
| Живой полный PDF-цикл | **Не выполнялся** |
| Codemagic | **Не запускался**, доступа к аккаунту нет |

JVM-набор:
- GatewayTransportTest: 7/7.
- OfflineServerCycleTest: 2/2.
- PdfCycleTest: 16/16.
- PdfNetworkTest: 5/5.
- ProtocolTest: 6/6.

Проверены сохранение точных PDF-байтов/ID/SHA-256 до сетевого действия, запрет второго
begin после неизвестного результата, восстановление каждого pending-этапа, потеря
ответов PUT/publish/revoke, истечение PUT URL, 409/412 без перезаписи, ошибка записи ID
до PUT, точный replay, запрет redirects и лишних PUT-заголовков, размер/MD5/ETag,
сверка скачанного документа по размеру/SHA-256/MIME, отсутствие ложного подтверждения
недоступности при HTTP 200/3xx/5xx и сетевых ошибках.

Два интеграционных JVM-теста используют настоящую auth() из index.js, makeWorkflow()
из workflow.js и pdf-lib PR №1 через локальный Node stdin/stdout, с поддельным
хранилищем в памяти. Пройден полный begin → PUT → publish → проверка PDF → revoke →
404. Отдельно сервер действительно завершает publish, ответ теряется; после
перезапуска клиента повтор publish возвращает ту же публикацию, без нового begin/PUT.
Это офлайн-проверка, не обращение к Yandex Cloud. Подписи одноразовых тестовых ключей
не печатаются в отчёты или логи.

Среда: Linux amd64, OpenJDK 21.0.12.1, Node 24.19.0, npm 11.9.0,
Gradle 8.9, AGP 8.7.3, Kotlin 2.0.21, SDK 35 / Build Tools 35.0.0.
Команда финальной проверки:

```sh
./gradlew --no-daemon --max-workers=2 -Pkotlin.compiler.execution.strategy=in-process \
  testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
```

В этой среде Kotlin daemon запускался нестабильно; финальная сборка выполнена
с компиляцией внутри Gradle. Codemagic сохраняет Java 17/Node 22.

Android-эмулятор был установлен и запускался для инструментальных тестов.
AVD не стартовал: эмулятор потребовал 7372.80 MB для раздела данных, доступно
3034.79 MB. Подключённого Samsung нет. Поэтому создание/рендеринг именно
Android PdfDocument с кириллицей, реальный Keystore, One UI и запуск браузера
требуют испытания на телефоне. Для этого добавлен локальный просмотр сохранённого
PDF без шлюза. Интеграционные JVM-тесты используют отдельный одностраничный PDF fixture.

По сообщению владельца, версия 0.1 уже прошла на Samsung авторизацию:
401 без подписи, begin 200, replay 409, revoke 200, выключенный шлюз 503.
Это не проверка нового PDF-цикла и не повторялось в этой задаче.

**Шлюз не переключался и не включался.** Во время разработки не было живых begin,
PUT, publish, revoke или GET к документам. IAM, API Gateway, бакеты, серверная
архитектура, index.js/workflow.js и основной репозиторий КузовPRO не менялись.
Новые облачные ресурсы не создавались. Полный живой цикл — только после установки
APK и отдельного разрешения владельца на переключение gateway-disabled.
