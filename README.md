# Qwen Free API

Локальный OpenAI-совместимый прокси для Qwen Chat с веб-интерфейсом, SSE-стримингом и инструментами агента. Сервер работает в одном Node.js-процессе и по умолчанию доступен на `http://localhost:3265`.

Проект предназначен для локального использования. Он обращается к внутреннему web API Qwen Chat, поэтому upstream API, требования WAF и доступность моделей могут меняться.

## Возможности

- OpenAI-compatible API: `GET /v1/models` и `POST /v1/chat/completions`.
- Веб-чат с историей, стримингом ответов и markdown-рендерингом.
- Glassmorphism UI с адаптивной мобильной навигацией.
- Режимы Thinking, Search, Терминал и Файлы.
- Инструменты агента: `bash`, чтение/запись файлов и веб-поиск.
- Автоматическая генерация SSXMOD fingerprint cookies для запросов к Qwen.
- Поддержка Playwright для входа в аккаунт через браузер.
- Кэширование списка доступных моделей.

## Требования

- Node.js `>= 18`.
- Аккаунт Qwen Chat.
- Chromium/Playwright только для автоматического захвата токена и cookies.

## Установка

```bash
git clone <URL-репозитория>
cd qwen-free-api
npm install
cp .env.example .env
```

Для автоматического входа установите браузер Playwright:

```bash
npm install playwright
npx playwright install chromium
```

## Первый запуск

1. Выполните вход в Qwen Chat:

   ```bash
   npm run login
   ```

2. Запустите сервер:

   ```bash
   npm start
   ```

3. Откройте веб-чат: `http://localhost:3265/`.

После входа токен и cookies сохраняются локально в `config/account.json`. Этот файл игнорируется Git и не должен публиковаться.

### Ручной вход без Playwright

Если браузер Playwright недоступен, можно вставить JWT вручную:

```bash
npm run login -- --manual
```

Скрипт попросит токен из DevTools браузера: `Local Storage` → `token`.

## Конфигурация

Основные параметры находятся в `.env`:

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `PORT` | `3265` | Порт HTTP-сервера |
| `QWEN_WORKSPACE` | `~/qwen-workspace` | Sandbox для терминала и файловых инструментов |
| `QWEN_WEB_VERSION` | `0.2.83` | Версия web-клиента Qwen для upstream-запросов |
| `DEFAULT_MODEL` | `qwen3.8-max` | Модель по умолчанию |
| `LOG_LEVEL` | `info` | Уровень логирования: `debug`, `info`, `warn`, `error` |

Если Qwen начинает возвращать WAF-ошибки, найдите актуальный `version` в DevTools → Network → запрос к `chat.qwen.ai` и обновите `QWEN_WEB_VERSION`.

## Использование OpenAI API

Любой OpenAI-compatible клиент может использовать:

- Base URL: `http://localhost:3265/v1`
- API key: любое значение, например `local`

Пример запроса:

```bash
curl http://localhost:3265/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "qwen3.7-max",
    "messages": [{"role": "user", "content": "Привет!"}],
    "stream": true
  }'
```

Для OpenCode используйте провайдер `@ai-sdk/openai-compatible`:

```jsonc
{
  "qwen": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Qwen Free",
    "options": {
      "baseURL": "http://localhost:3265/v1",
      "apiKey": "local"
    },
    "models": {
      "qwen3.8-max": {
        "name": "Qwen 3.8 Max",
        "reasoning": true,
        "tool_call": true,
        "limit": {"context": 32000, "output": 4096}
      }
    }
  }
}
```

Запуск:

```bash
opencode run --model qwen/qwen3.8-max "Объясни этот код"
```

## Веб-чат и инструменты

Откройте `http://localhost:3265/`. В нижней панели доступны режимы:

- **Thinking** — отображение reasoning-фазы ответа.
- **Search** — поиск в интернете и инструмент `web_search`.
- **Терминал** — выполнение команд в настроенном workspace.
- **Файлы** — чтение и изменение файлов внутри workspace.

История чатов хранится в `config/chats/` и исключена из Git. Workspace можно задать через `QWEN_WORKSPACE` или API `POST /api/workspace`.

## API endpoints

| Метод | Endpoint | Назначение |
|---|---|---|
| `GET` | `/` | Веб-интерфейс |
| `GET` | `/health` | Состояние аккаунта и SSXMOD |
| `GET` | `/healthz` | Диагностика сервиса |
| `GET` | `/v1/models` | OpenAI-список моделей |
| `POST` | `/v1/chat/completions` | OpenAI-compatible чат |
| `GET` | `/api/models` | Модели для веб-интерфейса |
| `GET` | `/api/chats` | Список чатов |
| `POST` | `/api/chats` | Создать чат |
| `GET/PATCH/DELETE` | `/api/chats/:id` | Получить, изменить или удалить чат |
| `POST` | `/api/chats/:id/messages` | Отправить сообщение через SSE |
| `POST` | `/api/chats/:id/clear` | Очистить историю чата |
| `GET/POST` | `/api/workspace` | Получить или изменить workspace |

## Команды

```bash
npm start                 # запустить сервер
npm run login             # войти в Qwen Chat
npm run login -- --manual # ручной ввод JWT
npm run models            # обновить список моделей
npm run install:setup     # настроить systemd и интеграции
npm test                  # запустить тесты cookies и SSE
npm run daemon            # включить systemd user service
npm run daemon:stop       # остановить systemd user service
```

## Тестирование

Перед отправкой изменений выполните:

```bash
node --check public/app.js
node --check server.js
npm test
```

Тесты не требуют запроса к Qwen: `test-cookies.js` проверяет генерацию fingerprint cookies, а `offline-sse-test.js` проверяет преобразование SSE-ответов.

## Структура проекта

```text
server.js                  # Express-сервер и OpenAI-compatible API
public/                    # HTML, CSS и JS веб-чата
src/config.js              # конфигурация порта, моделей и upstream
src/qwen-client.js         # HTTP-клиент Qwen Chat v2
src/chat-adapter.js        # преобразование Qwen <-> OpenAI
src/tools.js               # протокол tool calling
src/tool-executor.js       # bash, файлы и web search в sandbox
src/agent.js               # агентный цикл и SSE-события
src/chat-store.js          # локальное хранилище чатов
src/web.js                 # REST API веб-чата
src/account-store.js       # токен и cookies аккаунта
src/ssxmod-manager.js      # генерация и ротация SSXMOD cookies
scripts/login.js           # вход и захват аккаунта
scripts/list-models.js     # обновление списка моделей
scripts/install.js         # локальная установка и интеграции
scripts/test-cookies.js    # тесты генерации cookies
scripts/offline-sse-test.js # офлайн-тест SSE
```

## Безопасность

- Не публикуйте `config/account.json`, `.env` и содержимое `config/chats/`.
- Не указывайте workspace с важными системными или приватными файлами.
- Сервер не предназначен для публикации напрямую в интернет без аутентификации и reverse proxy.
- Инструмент `bash` выполняется локально от имени текущего пользователя.
- Используйте проект только в соответствии с правилами и условиями сервиса Qwen.

## Устранение проблем

**401 или `session expired`**

Повторите `npm run login`: токен или cookies могли истечь.

**504, HTML вместо JSON или WAF-слайдер**

Обновите `QWEN_WEB_VERSION`, пройдите проверку в браузере и повторите вход.

**Модели не загружаются**

Проверьте аккаунт и выполните `npm run models`. Кэш моделей хранится в `config/models-cache.json`.

**Не запускается автоматический вход**

Установите Chromium через `npx playwright install chromium` или используйте ручной режим.

## Дисклеймер

Неофициальный browser-based инструмент для личного использования. Qwen/Alibaba может менять внутренний API, список моделей и требования WAF без предупреждения.
