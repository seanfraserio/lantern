#!/usr/bin/env bash
set -euo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Lantern Benchmark Runner
#
# Orchestrates the Lantern ingest server + k6 load tests.
# Uses SQLite (local, no external DB needed).
#
# Prerequisites:
#   brew install k6
#   pnpm build           (from repo root)
#
# Usage:
#   ./benchmarks/run.sh                  # run all benchmarks
#   ./benchmarks/run.sh ingest           # ingest throughput only
#   ./benchmarks/run.sh batch            # batch size scaling only
#   ./benchmarks/run.sh mixed            # mixed workload only
#   ./benchmarks/run.sh quick            # 10s quick smoke test
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
LANTERN_PORT=4100
DB_FILE="$SCRIPT_DIR/lantern-bench.db"

mkdir -p "$RESULTS_DIR"

# ── Helpers ──────────────────────────────────────────────────────────────────

cleanup() {
  echo ""
  echo "Shutting down..."
  [[ -n "${LANTERN_PID:-}" ]] && kill "$LANTERN_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

check_deps() {
  for cmd in k6 node; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "Error: $cmd not found. Install it first."
      exit 1
    fi
  done

  if [[ ! -f "$PROJECT_ROOT/packages/ingest/dist/cli.js" ]]; then
    echo "Error: Lantern not built. Run 'pnpm build' from repo root."
    exit 1
  fi
}

reset_db() {
  echo "Resetting benchmark database..."
  rm -f "$DB_FILE" "${DB_FILE}-wal" "${DB_FILE}-shm"
}

start_lantern() {
  echo "Starting Lantern ingest server (port: $LANTERN_PORT)..."
  # Lantern auto-discovers lantern.yaml from CWD; env vars override config
  cd "$SCRIPT_DIR"
  PORT="$LANTERN_PORT" LANTERN_API_KEY="bench-ingest-key" \
    node "$PROJECT_ROOT/packages/ingest/dist/cli.js" \
    > "$RESULTS_DIR/lantern.log" 2>&1 &
  LANTERN_PID=$!
  sleep 2

  if ! kill -0 "$LANTERN_PID" 2>/dev/null; then
    echo "Error: Lantern failed to start"
    exit 1
  fi

  # Wait for health check
  for i in $(seq 1 15); do
    if curl -sf "http://127.0.0.1:$LANTERN_PORT/health" >/dev/null 2>&1; then
      echo "Lantern ready."
      return 0
    fi
    sleep 0.5
  done
  echo "Error: Lantern health check failed"
  exit 1
}

stop_lantern() {
  [[ -n "${LANTERN_PID:-}" ]] && kill "$LANTERN_PID" 2>/dev/null || true
  wait "$LANTERN_PID" 2>/dev/null || true
  unset LANTERN_PID
  sleep 1
}

db_size() {
  if [[ -f "$DB_FILE" ]]; then
    local bytes
    bytes=$(stat -f%z "$DB_FILE" 2>/dev/null || stat -c%s "$DB_FILE" 2>/dev/null || echo 0)
    echo "$((bytes / 1024 / 1024))MB"
  else
    echo "0MB"
  fi
}

# ── Benchmark: Ingest Throughput ─────────────────────────────────────────────

run_ingest() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  BENCHMARK: Ingest Throughput (ramp to 1500 traces/s)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  reset_db
  start_lantern

  k6 run "$SCRIPT_DIR/k6/ingest-throughput.js" 2>&1

  echo "  DB size after test: $(db_size)"
  stop_lantern
}

# ── Benchmark: Batch Size Scaling ────────────────────────────────────────────

run_batch() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  BENCHMARK: Batch Size Scaling (fixed 30 req/s, varying batch size)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Batch │    p50    │    p95    │  traces  │ traces/s"
  echo "  ──────┼───────────┼───────────┼──────────┼─────────"

  for batch_size in 1 10 50 100; do
    reset_db
    start_lantern

    BATCH_SIZE="$batch_size" \
      k6 run --quiet "$SCRIPT_DIR/k6/batch-size-scaling.js" 2>&1

    stop_lantern
  done

  echo ""
  echo "  Results saved to: $RESULTS_DIR/"
}

# ── Benchmark: Mixed Workload ────────────────────────────────────────────────

run_mixed() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  BENCHMARK: Mixed Workload (concurrent ingest + query)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  reset_db
  start_lantern

  k6 run "$SCRIPT_DIR/k6/mixed-workload.js" 2>&1

  echo "  DB size after test: $(db_size)"
  stop_lantern
}

# ── Quick Smoke Test ─────────────────────────────────────────────────────────

run_quick() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  QUICK SMOKE TEST (10s, 5 req/s × 10 traces)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  reset_db
  start_lantern

  k6 run --no-thresholds --duration 10s --vus 3 \
    "$SCRIPT_DIR/k6/ingest-throughput.js" 2>&1

  echo "  DB size after test: $(db_size)"

  # Quick query test
  echo ""
  echo "  Testing query endpoints..."
  local status
  status=$(curl -sf -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer bench-ingest-key" \
    "http://127.0.0.1:$LANTERN_PORT/v1/traces?limit=5")
  echo "  GET /v1/traces:  $status"

  status=$(curl -sf -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer bench-ingest-key" \
    "http://127.0.0.1:$LANTERN_PORT/v1/sources")
  echo "  GET /v1/sources: $status"

  stop_lantern
}

# ── Main ─────────────────────────────────────────────────────────────────────

check_deps

case "${1:-all}" in
  ingest)  run_ingest ;;
  batch)   run_batch ;;
  mixed)   run_mixed ;;
  quick)   run_quick ;;
  all)
    run_ingest
    run_batch
    run_mixed
    ;;
  *)
    echo "Usage: $0 {all|ingest|batch|mixed|quick}"
    exit 1
    ;;
esac

echo ""
echo "Done. Results in $RESULTS_DIR/"
