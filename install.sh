#!/bin/bash
# Установка MAX Messenger плагина для Claude Code
# Запускать из папки с плагином

set -e

PLUGIN_DIR="$HOME/.claude/plugins/local/max-messenger"
STATE_DIR="$HOME/.claude/channels/max"
ENV_FILE="$STATE_DIR/.env"
ACCESS_FILE="$STATE_DIR/access.json"

echo "=== MAX Messenger Plugin для Claude Code ==="
echo ""

# 1. Копируем плагин
echo "1. Устанавливаю плагин..."
mkdir -p "$PLUGIN_DIR"
cp -f server.ts package.json .mcp.json "$PLUGIN_DIR/" 2>/dev/null || true
[ -f README.md ] && cp -f README.md "$PLUGIN_DIR/"
echo "   -> $PLUGIN_DIR"

# 2. Создаём директорию состояния
echo "2. Создаю директории..."
mkdir -p "$STATE_DIR/inbox"
chmod 700 "$STATE_DIR"

# 3. Токен бота
if [ -f "$ENV_FILE" ]; then
  echo "3. Токен уже настроен: $ENV_FILE"
else
  echo "3. Введите токен бота MAX (из https://business.max.ru):"
  read -r TOKEN
  if [ -z "$TOKEN" ]; then
    echo "   Токен не указан. Создайте файл вручную:"
    echo "   echo 'MAX_BOT_TOKEN=ваш_токен' > $ENV_FILE"
  else
    echo "MAX_BOT_TOKEN=$TOKEN" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "   -> Сохранено в $ENV_FILE"
  fi
fi

# 4. access.json
if [ -f "$ACCESS_FILE" ]; then
  echo "4. access.json уже существует"
else
  cat > "$ACCESS_FILE" << 'EOF'
{
  "dmPolicy": "open",
  "allowFrom": [],
  "groups": {}
}
EOF
  chmod 600 "$ACCESS_FILE"
  echo "4. Создан access.json (dmPolicy: open)"
fi

# 5. Устанавливаем зависимости
echo "5. Устанавливаю зависимости..."
cd "$PLUGIN_DIR"
bun install --no-summary 2>/dev/null || echo "   bun install не удался — установите bun: curl -fsSL https://bun.sh/install | bash"

# 6. Проверяем сборку
echo "6. Проверяю сборку..."
if bun build --target=bun server.ts --outdir /tmp/max-check 2>/dev/null; then
  rm -rf /tmp/max-check
  echo "   -> OK"
else
  echo "   -> Ошибка сборки. Проверьте зависимости."
fi

echo ""
echo "=== Готово! ==="
echo ""
echo "Запуск:"
echo "  claude --channels max-messenger"
echo ""
echo "Или добавьте в ~/.claude/mcp.json:"
echo '  "max-messenger": {'
echo '    "command": "bun",'
echo '    "args": ["run", "--cwd", "'$PLUGIN_DIR'", "--shell=bun", "--silent", "start"]'
echo '  }'
echo ""
