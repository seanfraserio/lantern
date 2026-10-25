# Self-Hosting Lantern

## Quick start with Docker Compose

```bash
git clone https://github.com/your-org/lantern.git
cd lantern
export LANTERN_API_KEY="$(openssl rand -hex 32)"
docker compose -f docker/docker-compose.yml up -d
```

Keep this key private and configure SDK clients to send it. Preserve the same
value when restarting the deployment. Compose binds the ingest server to a
non-localhost interface, so startup fails closed without a key. If you mount a
`lantern.yaml` with `auth.api_keys`, an empty or absent `LANTERN_API_KEY` falls
back to the first nonempty YAML key; a nonempty environment value overrides it.

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
| `HOST` | `127.0.0.1` | Bind address. Non-localhost single-tenant binds require a key from explicit server configuration, the environment, or YAML |
| `LANTERN_API_KEY` | — | Nonempty environment value overrides YAML `auth.api_keys`; an empty or absent value falls back to the first nonempty YAML key |
| `LANTERN_ALLOW_INSECURE` | `false` | Set to `true` only to allow an unauthenticated non-localhost bind in isolated development |

## Production recommendations

- Use PostgreSQL for production workloads
- Put a reverse proxy (nginx/Caddy) in front of the ingest server
- Enable TLS for the ingest endpoint
- Set up log rotation for the ingest server
