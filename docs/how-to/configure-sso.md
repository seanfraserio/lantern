# How to Configure SAML SSO

Set up SAML-based single sign-on so your organisation's members authenticate through your identity provider (IdP).

> **Note:** SSO is available on the Enterprise plan only.

---

## Supported identity providers

Lantern supports any SAML 2.0 compliant IdP. Tested configurations:

- Okta
- Microsoft Azure AD (Entra ID)
- Google Workspace
- OneLogin
- JumpCloud

---

## Step 1: Get your Lantern SSO metadata

Retrieve the service provider (SP) metadata from Lantern. You will need this when configuring your IdP.

```bash
curl https://api.openlanternai.com/v1/sso/metadata \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

Response:

```json
{
  "entityId": "https://api.openlanternai.com/saml/metadata",
  "acsUrl": "https://api.openlanternai.com/saml/acs",
  "sloUrl": "https://api.openlanternai.com/saml/slo",
  "certificate": "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----"
}
```

You will use `entityId` and `acsUrl` in your IdP configuration.

---

## Step 2: Configure your IdP

### Okta

1. In Okta Admin, go to **Applications > Create App Integration**.
2. Select **SAML 2.0** and click **Next**.
3. Set the following:
   - **Single sign-on URL:** `https://api.openlanternai.com/saml/acs`
   - **Audience URI (SP Entity ID):** `https://api.openlanternai.com/saml/metadata`
   - **Name ID format:** `EmailAddress`
   - **Application username:** `Email`
4. Under **Attribute Statements**, add:
   - `email` -> `user.email`
   - `firstName` -> `user.firstName`
   - `lastName` -> `user.lastName`
5. Click **Finish** and copy the **IdP metadata URL** from the **Sign On** tab.

### Azure AD (Entra ID)

1. In the Azure portal, go to **Enterprise Applications > New Application > Create your own application**.
2. Select **Integrate any other application you don't find in the gallery (Non-gallery)**.
3. Go to **Single sign-on > SAML** and set:
   - **Identifier (Entity ID):** `https://api.openlanternai.com/saml/metadata`
   - **Reply URL (ACS URL):** `https://api.openlanternai.com/saml/acs`
4. Under **Attributes & Claims**, configure:
   - `email` -> `user.mail`
   - `firstName` -> `user.givenname`
   - `lastName` -> `user.surname`
5. Download the **Federation Metadata XML** or copy the **App Federation Metadata URL**.

---

## Step 3: Register the IdP in Lantern

Pass the IdP metadata URL (or XML content) to Lantern:

```bash
curl -X POST https://api.openlanternai.com/v1/sso/configure \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "idpMetadataUrl": "https://login.microsoftonline.com/TENANT_ID/federationmetadata/2007-06/federationmetadata.xml",
    "emailDomains": ["example.com"],
    "autoProvision": true,
    "defaultRole": "member"
  }'
```

Parameters:

| Parameter | Description |
|-----------|-------------|
| `idpMetadataUrl` | URL to your IdP's SAML metadata. Alternatively, pass `idpMetadataXml` with the raw XML content. |
| `emailDomains` | List of email domains to enforce SSO for. Users with these domains must sign in via SSO. |
| `autoProvision` | When `true`, users who sign in via SSO for the first time are automatically created in Lantern. |
| `defaultRole` | Role assigned to auto-provisioned users (`member`, `admin`). Default: `member`. |

Response:

```json
{
  "ssoId": "sso_abc123",
  "status": "active",
  "idpEntityId": "https://sts.windows.net/TENANT_ID/",
  "emailDomains": ["example.com"],
  "autoProvision": true
}
```

---

## Step 4: Test the SSO login flow

Open the Lantern dashboard login page and enter an email matching one of the configured domains. You will be redirected to your IdP.

Alternatively, test from the command line:

```bash
curl -X POST https://api.openlanternai.com/v1/sso/test \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

This returns the SSO login URL. Open it in a browser to walk through the full authentication flow.

---

## Auto-provisioning

When `autoProvision` is enabled:

- New users who sign in via SSO are automatically created with the `defaultRole`.
- They are added to the organisation but not to any team. Team membership must be assigned separately (see [Manage Teams](./manage-teams.md)).
- Users who already exist in Lantern are linked to their SSO identity on first SSO login.

To disable auto-provisioning:

```bash
curl -X PATCH https://api.openlanternai.com/v1/sso/configure \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "autoProvision": false
  }'
```

When disabled, only users who already have a Lantern account can sign in via SSO.

---

## Enforce SSO for all users

To require SSO for all users on the configured email domains (blocking password login):

```bash
curl -X PATCH https://api.openlanternai.com/v1/sso/configure \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "enforced": true
  }'
```

> **Warning:** Before enforcing SSO, verify that at least one admin can sign in via SSO. If SSO is misconfigured and enforced, you will need to contact Lantern support to regain access.

---

## View SSO configuration

```bash
curl https://api.openlanternai.com/v1/sso/configure \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

---

## Remove SSO

```bash
curl -X DELETE https://api.openlanternai.com/v1/sso/configure \
  -H "Authorization: Bearer $LANTERN_API_KEY"
```

This reverts all users to password-based authentication. Existing sessions remain active until they expire.
