# How to Export Compliance Reports

Generate compliance reports for SOC2 Type II, HIPAA, and GDPR audits. Lantern collects the data — these endpoints package it into auditor-ready formats.

---

## SOC2 Type II audit export

Export an audit log covering a date range. The report includes trace access logs, data retention evidence, alert configurations, and change history.

```bash
curl -X POST https://api.openlanternai.com/v1/compliance/exports \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "soc2",
    "startDate": "2025-01-01",
    "endDate": "2025-12-31",
    "format": "pdf"
  }'
```

Response:

```json
{
  "exportId": "exp_abc123",
  "type": "soc2",
  "status": "processing",
  "createdAt": "2026-03-15T10:00:00Z"
}
```

Reports are generated asynchronously. Check the status:

```bash
curl https://api.openlanternai.com/v1/compliance/exports/exp_abc123 \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

When `status` is `"complete"`, download the report:

```bash
curl -o soc2-report.pdf \
  "https://api.openlanternai.com/v1/compliance/exports/exp_abc123/download" \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

### What the SOC2 report includes

- Agent inventory (names, versions, environments)
- Access control audit trail (who viewed which traces)
- Alert configuration and notification history
- Data retention and deletion records
- PII scanning configuration and findings summary
- Uptime and availability metrics for the ingest and API services

---

## HIPAA compliance reports

For organisations handling protected health information (PHI):

```bash
curl -X POST https://api.openlanternai.com/v1/compliance/exports \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "hipaa",
    "startDate": "2025-01-01",
    "endDate": "2025-12-31",
    "format": "pdf"
  }'
```

### What the HIPAA report includes

- PHI access logs (which users/agents accessed traces containing PHI)
- PII/PHI scanning results and redaction evidence
- Encryption-at-rest and in-transit attestation
- Business Associate Agreement (BAA) status
- Data breach incident log (if any)

> **Note:** HIPAA compliance reports are available on the Enterprise plan only.

---

## GDPR data processing inventory

Export a data processing inventory for GDPR compliance:

```bash
curl -X POST https://api.openlanternai.com/v1/compliance/exports \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "gdpr",
    "startDate": "2025-01-01",
    "endDate": "2025-12-31",
    "format": "csv"
  }'
```

Supported formats: `pdf`, `csv`, `json`.

### What the GDPR report includes

- Data processing activities inventory (Article 30 record)
- Categories of personal data processed by each agent
- Data retention periods and deletion schedules
- Sub-processor list (LLM providers called via traces)
- Data subject access request (DSAR) fulfilment log
- Cross-border transfer documentation

---

## Schedule regular exports

Set up a recurring export so reports are generated automatically:

```bash
curl -X POST https://api.openlanternai.com/v1/compliance/schedules \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "soc2",
    "frequency": "quarterly",
    "format": "pdf",
    "notifyEmail": "compliance@example.com"
  }'
```

Supported frequencies: `monthly`, `quarterly`, `annually`.

When a scheduled report is generated, Lantern sends an email notification with a download link. The link expires after 30 days.

---

## List all exports

```bash
curl "https://api.openlanternai.com/v1/compliance/exports?limit=10" \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

---

## Delete an export

```bash
curl -X DELETE https://api.openlanternai.com/v1/compliance/exports/exp_abc123 \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

> **Warning:** Deleting an export removes the generated file. It does not delete the underlying trace data.
