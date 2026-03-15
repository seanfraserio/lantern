# How to Manage Teams

Set up teams with role-based access so different groups in your organisation only see the agents they are responsible for.

---

## Create a team

```bash
curl -X POST https://api.openlanternai.com/v1/teams \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Platform Engineering",
    "description": "Owns infrastructure and internal tool agents"
  }'
```

Response:

```json
{
  "id": "team_abc123",
  "name": "Platform Engineering",
  "description": "Owns infrastructure and internal tool agents",
  "createdAt": "2026-03-15T10:00:00Z"
}
```

---

## Invite members

Invite users by email. They receive an invitation and are added to the team once they accept.

```bash
curl -X POST https://api.openlanternai.com/v1/teams/team_abc123/members \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "role": "admin"
  }'
```

---

## Roles

| Role | Permissions |
|------|-------------|
| **owner** | Full access. Can delete the team, manage billing, and promote/demote members. One owner per team. |
| **admin** | Can invite/remove members, configure alerts, manage agent scopes, and view all traces for scoped agents. |
| **member** | Can view traces and dashboards for scoped agents. Cannot change team settings. |

Change a member's role:

```bash
curl -X PATCH https://api.openlanternai.com/v1/teams/team_abc123/members/user_xyz \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "member"
  }'
```

---

## Set agent scopes

Agent scopes control which agents a team can see. By default, a new team has no scopes and sees nothing.

Add scopes by agent name pattern:

```bash
curl -X PUT https://api.openlanternai.com/v1/teams/team_abc123/scopes \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentScopes": [
      "support-agent",
      "billing-agent",
      "internal-*"
    ]
  }'
```

Patterns support trailing wildcards. `"internal-*"` matches `internal-tools`, `internal-deploy`, etc.

---

## List team members

```bash
curl https://api.openlanternai.com/v1/teams/team_abc123/members \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

Response:

```json
{
  "members": [
    {
      "userId": "user_001",
      "email": "alice@example.com",
      "role": "admin",
      "joinedAt": "2026-03-15T10:05:00Z"
    },
    {
      "userId": "user_002",
      "email": "bob@example.com",
      "role": "member",
      "joinedAt": "2026-03-15T10:10:00Z"
    }
  ]
}
```

---

## Remove a member

```bash
curl -X DELETE https://api.openlanternai.com/v1/teams/team_abc123/members/user_002 \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

---

## Delete a team

Only the team owner can delete a team:

```bash
curl -X DELETE https://api.openlanternai.com/v1/teams/team_abc123 \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

> **Warning:** Deleting a team revokes access for all members. Traces and data are not deleted — they remain accessible to organisation-level admins.
