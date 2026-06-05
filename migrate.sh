set -euo pipefail

DB="${1:-/root/wg-easy/data/wg-easy.db}"

if [ ! -f "$DB" ]; then
  echo "❌  БД не найдена: $DB"
  echo "    Использование: $0 [путь/к/wg-easy.db]"
  exit 1
fi

echo "▶  Останавливаем контейнер wg-easy..."
docker compose -f /root/wg-easy/docker-compose.yml stop wg-easy 2>/dev/null || true

echo "▶  Создаём резервную копию БД..."
cp -v "$DB" "${DB}.bak_$(date +%Y%m%d_%H%M%S)"

echo "▶  Применяем миграцию..."
sqlite3 "$DB" <<'SQL'
UPDATE interfaces_table
SET j_c   = 5,
    j_min = 40,
    j_max = 90
WHERE name = 'wg0';

SELECT 'interfaces_table:', name, j_c, j_min, j_max FROM interfaces_table WHERE name='wg0';
SELECT 'clients_table MTU:', id, name, mtu FROM clients_table LIMIT 20;
SQL

echo ""
echo "▶  Запускаем контейнер wg-easy..."
docker compose -f /root/wg-easy/docker-compose.yml start wg-easy

echo ""
echo "✅  Готово! Проверьте новые параметры в admin-панели wg-easy."