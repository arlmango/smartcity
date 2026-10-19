#!/bin/sh
# Apply database migrations, then start the API (CMD). Fails fast if migrations fail.
set -eu
if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
  alembic -c /app/services/api/alembic.ini upgrade head
fi
exec "$@"
