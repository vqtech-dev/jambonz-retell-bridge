# Customer Onboarding Template

Multi-tenant voice stack configuration for VQ Tech. Keep all tables in sync when adding a customer.

Related PRs:
- `nexhealth-middleware` — `CUSTOMER_CONFIG` / `location_id` routing
- `jambonz-retell-bridge` — `TENANT_CONFIG` / per-customer transfer routing

---

## Table 1 — NexHealth Middleware (`nexhealth-middleware`)

**Render env var:** `CUSTOMER_CONFIG` (JSON)

| Field | Demo — Open Dental | Woods Medical |
|---|---|---|
| **Config key** | `demo-open-dental` | `woods-medical` |
| **NexHealth subdomain** | `visionquest-technology-demo-practice` | `woods-medical-internal-medicine` |
| **Location ID(s)** | `353034` | `355231` |
| **NexHealth API key** | | |
| **Nurse / staff email** | | |
| **Notify from email** | | |
| **Patient portal URL** | | |
| **Document type ID** | | `535758` |
| **Retell tool: `location_id`** | `353034` or `{{location_id}}` | `355231` or `{{location_id}}` |
| **Retell tool: `phone_number`** | `{{user_number}}` | `{{user_number}}` |
| **Middleware URL** | `https://nexhealth-middleware.onrender.com` | Same (shared) |

**Endpoints (all require `location_id` in body):**

| Endpoint | Purpose |
|---|---|
| `POST /get_patient_info` | Lookup patient + upcoming appointment |
| `POST /cancel_appointment` | Cancel by `appointment_id` |
| `POST /submit_refill_request` | Upload refill PDF + notify staff |
| `POST /submit_issue_report` | Route issue to staff inbox |
| `POST /send_lab_link` | Email patient portal link |

---

## Table 2 — Jambonz-Retell Bridge (`jambonz-retell-bridge`)

**Render env var:** `TENANT_CONFIG` (JSON keyed by inbound DID in E.164)

| Field | Demo — Open Dental | Woods Medical |
|---|---|---|
| **Inbound DID (E.164)** | `+1__________` | `+1__________` |
| **`customer_id`** | `demo-open-dental` | `woods-medical` |
| **`location_id`** | `353034` | `355231` |
| **`retell_agent_id`** | | |
| **`skyswitch_outbound_carrier`** | `SkySwitch-JambonzRetell` | `SkySwitch-JambonzRetell-Woods` |
| **`skyswitch_sip_realm`** | `visionquest.22393.service` | `woods.__________.service` |
| **`skyswitch_register_username`** | `JambonzRetell` | `JambonzRetellWoods` |
| **`skyswitch_extension_domain`** | `visionquest.22393.service` | `woods.__________.service` |
| **`retell_trunk_name`** | `Retell-73hR8GtTmfVmdn7kUbc1Fz` | Shared or per-agent (TBD) |
| **`retell_sip_client_username`** | | |
| **Inbound webhook URL** | `https://[bridge-host]/inbound-webhook` | Same (shared) |
| **WebSocket app URL** | `wss://[bridge-host]/retell` | Same (shared) |
| **Retell dynamic vars set** | `location_id`, `customer_id`, `called_did` | Same |

**Shared bridge env vars (one value for all customers):**

| Env var | Value |
|---|---|
| `RETELL_API_KEY` | |
| `RETELL_TRUNK_NAME` | Fallback if not set per tenant |
| `RETELL_SIP_CLIENT_USERNAME` | Fallback if not set per tenant |

**Must match middleware:** `location_id` and `customer_id` must align with Table 1.

---

## Table 3 — Jambonz Portal (per customer)

| Object | Demo — Open Dental | Woods Medical | Shared? |
|---|---|---|---|
| **Application** | `retell` | `retell` | **Yes — reuse** |
| **Carrier: inbound (PSTN → Jambonz)** | `SkySwitch` | `SkySwitch-Woods` | No |
| **Inbound carrier auth username** | `Vqtech` | `VqtechWoods` (or per customer) | No |
| **Carrier: outbound/transfer (Retell → PSTN)** | `SkySwitch-JambonzRetell` | `SkySwitch-JambonzRetell-Woods` | No |
| **Outbound carrier auth username** | `JambonzRetell` | `JambonzRetellWoods` | No |
| **Outbound SIP From domain** | `visionquest.22393.service` | `woods.__________.service` | No |
| **Carrier: Retell/LiveKit (Jambonz → Retell)** | `Retell-73hR8GtTmfVmdn7kUbc1Fz` | Same (likely) | **Likely yes** |
| **Retell/LiveKit SIP gateway** | `5t4n6j0wnrl.sip.livekit.cloud` | Same | **Yes** |
| **Phone Number (DID)** | `+1__________` | `+1__________` | No |
| **Phone number → Carrier** | Inbound carrier (demo) | Inbound carrier (woods) | No |
| **Phone number → Application** | `retell` | `retell` | **Yes** |
| **SIP client credential (Retell transfers in)** | | | Per customer if required |
| **App for SIP device calls** | `retell` | `retell` | **Yes** |

---

## Table 4 — SkySwitch Portal (reference, per customer)

| Field | Demo — Open Dental | Woods Medical |
|---|---|---|
| **Trunk device name** | `vqtech.sip.jambonz.cloud` | Customer-specific trunk |
| **Trunk IP** | `54.236.168.131:5060` | May share IP, different registration |
| **SIP domain** | `visionquest.22393.service` | `woods.__________.service` |
| **Inbound DID** | `+1__________` | `+1__________` |
| **Routes to** | Jambonz inbound carrier | Jambonz inbound carrier |

---

## Table 5 — Retell (reference, per customer)

| Field | Demo — Open Dental | Woods Medical |
|---|---|---|
| **Agent name** | | |
| **Agent ID** | | |
| **Inbound DID** | `+1__________` | `+1__________` |
| **SIP termination URI** | `vqtech.sip.jambonz.cloud` (or Jambonz realm) | Same Jambonz realm |
| **SIP trunk username/password** | Jambonz SIP client creds | Per customer if separate |
| **Inbound webhook** | `https://[bridge-host]/inbound-webhook` | Same |
| **Custom tools → middleware** | All include `location_id` + `phone_number` | Same |

---

## Sync checklist (must match across tables)

| ID / value | Middleware `CUSTOMER_CONFIG` | Bridge `TENANT_CONFIG` | Jambonz | Retell |
|---|---|---|---|---|
| Location ID | `location_ids` | `location_id` | — | Tool body |
| Customer key | config key | `customer_id` | — | — |
| Inbound DID | — | JSON key (E.164) | Phone Number | Phone Number |
| Outbound carrier name | — | `skyswitch_outbound_carrier` | Carrier object name | — |
| SIP domain | — | `skyswitch_sip_realm` | Outbound carrier reg | — |

---

## Call flow reference

### INBOUND
```
Customer dials DID (PSTN)
  -> SkySwitch network
  -> SkySwitch trunk device [SkySwitch portal]
  -> Jambonz inbound carrier [Jambonz portal]
  -> retell application [Jambonz portal]
  -> Bridge sets location_id from TENANT_CONFIG
  -> Retell-Trunk -> Retell / LiveKit
  -> Retell tools -> nexhealth-middleware (CUSTOMER_CONFIG)
```

### OUTBOUND (transfer)
```
Retell / LiveKit places call
  -> Jambonz outbound carrier (per customer, e.g. SkySwitch-JambonzRetell-Woods)
     Auth username + SIP from domain must match customer's SkySwitch registration
  -> SkySwitch trunk device [SkySwitch portal]
  -> SkySwitch network
  -> Destination number (PSTN)
```

Each customer requires **two Jambonz carriers** (inbound + outbound) even when sharing the same physical SkySwitch trunk IP.
