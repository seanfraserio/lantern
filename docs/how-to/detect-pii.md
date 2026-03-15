# How to Detect PII

Scan agent traces for personally identifiable information (PII) to maintain privacy compliance and prevent accidental data leakage.

---

## Scan a single trace

Check a specific trace for PII:

```bash
curl -X POST https://api.openlanternai.com/v1/pii/scan \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "traceId": "trace-abc-123"
  }'
```

Response:

```json
{
  "traceId": "trace-abc-123",
  "findings": [
    {
      "type": "email",
      "value": "j.smith@example.com",
      "spanId": "span-001",
      "field": "input.messages[0].content",
      "confidence": 0.98
    },
    {
      "type": "phone_number",
      "value": "+44 20 7946 0958",
      "spanId": "span-002",
      "field": "output.content",
      "confidence": 0.95
    }
  ],
  "summary": {
    "totalFindings": 2,
    "types": ["email", "phone_number"]
  }
}
```

---

## Bulk scan text content

Scan arbitrary text without associating it with a trace:

```bash
curl -X POST https://api.openlanternai.com/v1/pii/scan-text \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "texts": [
      "Please update the account for John Smith, email john.smith@example.com, SSN 123-45-6789.",
      "The server IP is 10.0.0.1 and the API key is sk-abc123."
    ]
  }'
```

Response:

```json
{
  "results": [
    {
      "index": 0,
      "findings": [
        {"type": "person_name", "value": "John Smith", "confidence": 0.92},
        {"type": "email", "value": "john.smith@example.com", "confidence": 0.99},
        {"type": "ssn", "value": "123-45-6789", "confidence": 0.97}
      ]
    },
    {
      "index": 1,
      "findings": [
        {"type": "api_key", "value": "sk-abc123", "confidence": 0.88}
      ]
    }
  ]
}
```

---

## Supported PII types

| Type | Examples |
|------|----------|
| `email` | Email addresses |
| `phone_number` | Phone numbers (international formats) |
| `person_name` | Full names |
| `ssn` | US Social Security Numbers |
| `credit_card` | Credit/debit card numbers |
| `address` | Physical/postal addresses |
| `date_of_birth` | Dates of birth |
| `ip_address` | IPv4 and IPv6 addresses |
| `api_key` | API keys and tokens |
| `passport_number` | Passport numbers |

---

## Auto-redact PII before logging

Request that PII be automatically redacted when traces are stored:

```bash
curl -X PUT https://api.openlanternai.com/v1/pii/settings \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "autoRedact": true,
    "redactTypes": ["ssn", "credit_card", "api_key"],
    "redactionStyle": "mask"
  }'
```

Redaction styles:

| Style | Example |
|-------|---------|
| `mask` | `123-45-6789` becomes `***-**-****` |
| `replace` | `123-45-6789` becomes `[SSN_REDACTED]` |
| `hash` | `123-45-6789` becomes `sha256:a1b2c3...` |

> **Warning:** Auto-redaction modifies trace data at ingest time. The original values cannot be recovered. Make sure this is the behaviour you want before enabling it.

---

## Set up PII scanning in your pipeline

### Scan all incoming traces automatically

Enable automatic PII scanning on every trace at ingest time:

```bash
curl -X PUT https://api.openlanternai.com/v1/pii/settings \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "autoScan": true,
    "scanTypes": ["email", "ssn", "credit_card", "phone_number", "person_name", "api_key"],
    "alertOnDetection": true
  }'
```

When `alertOnDetection` is `true`, a PII alert is sent to your configured [alert channels](./set-up-alerts.md) whenever PII is found.

### Scan before sending traces (client-side)

If you want to redact PII before it leaves your infrastructure, scan text locally and strip sensitive data before sending to Lantern:

```python
# Example: pre-scan in Python before tracing
import re

PII_PATTERNS = {
    "email": r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
    "ssn": r"\b\d{3}-\d{2}-\d{4}\b",
}

def redact(text: str) -> str:
    for pii_type, pattern in PII_PATTERNS.items():
        text = re.sub(pattern, f"[{pii_type.upper()}_REDACTED]", text)
    return text
```

---

## View PII findings in the dashboard

The dashboard shows PII findings at **Compliance > PII**:

- Per-trace PII annotations (highlighted in the span detail view)
- Aggregate PII statistics over time
- Filter traces by PII type
- Export PII audit logs for compliance reviews
