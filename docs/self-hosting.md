# Self-Hosting Lantern

## Quick start with Docker Compose

```bash
git clone https://github.com/your-org/lantern.git
cd lantern
docker compose -f docker/docker-compose.yml up -d
```

This starts:
- **Ingest server** on port 4100
- **Dashboard** on port 3000
- **PostgreSQL** on port 5432

## Development mode (SQLite)

```bash
docker compose -f docker/docker-compose.dev.yml up -d
```

## Manual setup

### Ingest server

```bash
cd packages/ingest
pnpm install
pnpm build
pnpm start
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4100` | Ingest server port |
| `STORE_TYPE` | `sqlite` | Storage backend (sqlite/postgres) |
| `DB_PATH` | `lantern.db` | SQLite database path |
| `DATABASE_URL` | — | PostgreSQL connection string |

## Production recommendations

- Use PostgreSQL for production workloads
- Put a reverse proxy (nginx/Caddy) in front of the ingest server
- Enable TLS for the ingest endpoint
- Set up log rotation for the ingest server
