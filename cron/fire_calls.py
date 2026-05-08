#!/usr/bin/env python3
"""
fire_calls.py — Pull undialed GHL contacts (ep-scraper source) and fire
ElevenLabs outbound calls. Runs as a Railway cron job at 10 PM CT (03:00 UTC).

Critical requirements before a call is fired:
  - Valid E.164 phone
  - Valid email (non-generic)
  - Company name
  - Industry mapped to INDUSTRIES config
  - Not already called (not in elevenlabs_calls DB)

Usage:
    python fire_calls.py                     # live run, max 100 calls
    python fire_calls.py --dry-run           # print queue, no calls fired
    python fire_calls.py --max 20            # cap this run at 20 calls
    python fire_calls.py --test +13526721885 # fire one test call
"""

import argparse, os, re, sys, time
import requests
import psycopg2

# ─────────────────────────────────────────────────────────────────────────────
# Credentials — env vars on Railway, hardcoded fallback for local use
# ─────────────────────────────────────────────────────────────────────────────
DB_URL      = os.environ.get("DB_URL",      "postgresql://postgres:zzAtlegSyZfYhqwpqSAEuDmKBuqAcvDM@monorail.proxy.rlwy.net:37139/railway")
GHL_PIT     = os.environ.get("GHL_PIT",     "pit-4bfd7709-87ff-49ba-acf3-96853845ac26")
GHL_LOC_ID  = os.environ.get("GHL_LOC_ID",  "K9xKBbQkhSOUZs6KzTAy")
GHL_BASE    = "https://services.leadconnectorhq.com"
EL_API_KEY  = os.environ.get("EL_API_KEY",  "sk_dde0f89d3f4988470d5113c3b449dcdea32afd741e422e3b")
EP_AGENT_ID = os.environ.get("EP_AGENT_ID", "agent_2001kpf1b4vme47vjawagajw23e4")

GHL_FIELD_INDUSTRY = "qHxoiSsPCpF9Htp7Qdcu"

MAX_CALLS_PER_RUN = int(os.environ.get("MAX_CALLS_PER_RUN", "100"))
CALL_DELAY_SECS   = int(os.environ.get("CALL_DELAY_SECS",   "15"))

# ─────────────────────────────────────────────────────────────────────────────
# Industry config — must match scraper.py
# ─────────────────────────────────────────────────────────────────────────────
INDUSTRIES = {
    "plumbing": {
        "problem": "burst pipe flooding his basement",
        "ask":     "emergency after-hours rate",
    },
    "hvac": {
        "problem": "furnace died and it's freezing inside",
        "ask":     "emergency furnace repair after hours",
    },
    "electrical": {
        "problem": "breaker box tripping and half the house has no power",
        "ask":     "after-hours emergency electrical service call",
    },
    "garage door": {
        "problem": "spring snapped and he can't get his car out for work in the morning",
        "ask":     "after-hours garage door spring replacement",
    },
    "locksmith": {
        "problem": "locked out of his truck off the highway",
        "ask":     "after-hours lockout service rate",
    },
}

# ─────────────────────────────────────────────────────────────────────────────
# Validation helpers
# ─────────────────────────────────────────────────────────────────────────────
_BAD_EMAIL_DOMAINS  = {"duckduckgo.com", "example.com", "test.com", "sentry.io",
                       "wixpress.com", "squarespace.com", "wordpress.com"}
_BAD_EMAIL_PREFIXES = {"noreply@", "no-reply@", "donotreply@", "error-lite@", "block-service@"}

def _is_valid_email(email: str) -> bool:
    e = (email or "").strip().lower()
    if not e or "@" not in e:
        return False
    if any(e.startswith(p) for p in _BAD_EMAIL_PREFIXES):
        return False
    domain = e.split("@")[-1]
    if any(domain == d or domain.endswith("." + d) for d in _BAD_EMAIL_DOMAINS):
        return False
    if any(e.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp")):
        return False
    return True

def _normalize_phone(raw: str) -> str | None:
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits[0] == "1":
        return f"+{digits}"
    return None

def _resolve_industry(raw: str) -> str | None:
    """Map raw GHL industry value to INDUSTRIES key."""
    if not raw:
        return None
    raw = raw.strip().lower()
    if raw in INDUSTRIES:
        return raw
    for key in INDUSTRIES:
        if key in raw or raw in key:
            return key
    return None

# ─────────────────────────────────────────────────────────────────────────────
# Data fetchers
# ─────────────────────────────────────────────────────────────────────────────
def _phones_in_db() -> set:
    conn = psycopg2.connect(DB_URL)
    cur  = conn.cursor()
    cur.execute("SELECT DISTINCT external_number FROM elevenlabs_calls WHERE is_ep = TRUE")
    phones = {r[0] for r in cur.fetchall() if r[0]}
    cur.close(); conn.close()
    return phones

def _get_ep_phone_id() -> str | None:
    r = requests.get(
        "https://api.elevenlabs.io/v1/convai/phone-numbers",
        headers={"xi-api-key": EL_API_KEY},
        timeout=15,
    )
    r.raise_for_status()
    nums = r.json() if isinstance(r.json(), list) else r.json().get("phone_numbers", [])
    for n in nums:
        if EP_AGENT_ID in str((n.get("assigned_agent") or {}).get("agent_id", "")):
            return n.get("phone_number_id") or n.get("id")
    return (nums[0].get("phone_number_id") or nums[0].get("id")) if nums else None

def _get_contacts_to_call(already_called: set) -> list:
    """
    Pull all GHL ep-scraper contacts. Return only those passing ALL checks:
      - valid E.164 phone, not already called
      - valid email
      - company name present
      - industry resolvable
    """
    headers = {"Authorization": f"Bearer {GHL_PIT}", "Version": "2021-07-28"}
    ready   = []
    skipped = {"no_source": 0, "called": 0, "bad_phone": 0,
               "bad_email": 0, "no_name": 0, "no_industry": 0}
    page, per_page = 1, 100

    while True:
        r = requests.get(
            f"{GHL_BASE}/contacts/",
            headers=headers,
            params={"locationId": GHL_LOC_ID, "limit": per_page, "page": page},
            timeout=20,
        )
        if not r.ok:
            print(f"[GHL] List failed {r.status_code} — stopping")
            break

        batch = r.json().get("contacts", [])
        for c in batch:
            if (c.get("source") or "").lower() != "ep-scraper":
                skipped["no_source"] += 1
                continue

            phone = _normalize_phone(c.get("phone") or "")
            if not phone:
                skipped["bad_phone"] += 1
                continue
            if phone in already_called:
                skipped["called"] += 1
                continue

            email = (c.get("email") or "").strip()
            if not _is_valid_email(email):
                skipped["bad_email"] += 1
                continue

            name = (c.get("companyName") or c.get("name") or "").strip()
            if not name:
                skipped["no_name"] += 1
                continue

            raw_industry = None
            for cf in (c.get("customFields") or []):
                if cf.get("id") == GHL_FIELD_INDUSTRY:
                    raw_industry = cf.get("value")
                    break
            industry = _resolve_industry(raw_industry)
            if not industry:
                skipped["no_industry"] += 1
                continue

            ready.append({
                "ghl_id":   c.get("id"),
                "name":     name,
                "phone":    phone,
                "email":    email,
                "industry": industry,
                "city":     (c.get("city") or "Minneapolis").strip(),
            })

        if len(batch) < per_page:
            break
        page += 1
        time.sleep(0.3)

    print(f"[GHL] Skipped — {skipped}")
    return ready

# ─────────────────────────────────────────────────────────────────────────────
# Call firing
# ─────────────────────────────────────────────────────────────────────────────
def _fire_call(contact: dict, phone_number_id: str) -> str | None:
    cfg = INDUSTRIES[contact["industry"]]
    r = requests.post(
        "https://api.elevenlabs.io/v1/convai/twilio/outbound-call",
        headers={"xi-api-key": EL_API_KEY, "Content-Type": "application/json"},
        json={
            "agent_id":              EP_AGENT_ID,
            "agent_phone_number_id": phone_number_id,
            "to_number":             contact["phone"],
            "conversation_initiation_client_data": {
                "dynamic_variables": {
                    "industry":                    contact["industry"],
                    "industry_specific_problem":   cfg["problem"],
                    "industry_specific_quote_ask": cfg["ask"],
                    "city":                        contact["city"],
                }
            },
        },
        timeout=15,
    )
    if not r.ok:
        print(f"  FAILED {r.status_code}: {r.text[:200]}")
        return None
    return r.json().get("conversation_id", "")

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
def run(dry_run: bool = False, max_calls: int = None, test_number: str = None):
    max_calls = max_calls or MAX_CALLS_PER_RUN

    print(f"\n{'='*60}")
    print(f"  EP FIRE CALLS  |  {'DRY RUN' if dry_run else 'LIVE'}")
    print(f"  max={max_calls}  delay={CALL_DELAY_SECS}s")
    print(f"{'='*60}\n")

    # ── Test call mode ────────────────────────────────────────────────────────
    if test_number:
        phone = _normalize_phone(test_number)
        if not phone:
            print(f"ERROR: invalid phone {test_number}")
            sys.exit(1)
        print(f"[TEST] Fetching EL phone number...")
        phone_id = _get_ep_phone_id()
        if not phone_id:
            print("ERROR: No ElevenLabs phone number found")
            sys.exit(1)
        contact = {
            "name": "Test Call", "phone": phone, "email": "test@profithexagon.com",
            "industry": "plumbing", "city": "Minneapolis",
        }
        print(f"[TEST] Firing call to {phone}...")
        conv_id = _fire_call(contact, phone_id)
        if conv_id:
            print(f"[TEST] SUCCESS — conv_id={conv_id}")
        else:
            print("[TEST] FAILED")
        return

    # ── Production run ────────────────────────────────────────────────────────
    print("[DB] Loading already-called phones...")
    already_called = _phones_in_db()
    print(f"  {len(already_called)} phones already in DB\n")

    print("[GHL] Fetching undialed contacts with valid email + industry...")
    contacts = _get_contacts_to_call(already_called)
    print(f"  {len(contacts)} contacts ready to call\n")

    if not contacts:
        print("Nothing to do — queue is empty.")
        return

    to_call = contacts[:max_calls]
    print(f"[QUEUE] Will call {len(to_call)} of {len(contacts)} eligible contacts\n")

    if dry_run:
        for c in to_call:
            print(f"  WOULD CALL  {c['phone']:<15}  {c['name']:<35}  {c['industry']:<12}  {c['email']}")
        return

    print("[EL] Fetching phone number ID...")
    phone_id = _get_ep_phone_id()
    if not phone_id:
        print("ERROR: No ElevenLabs phone number found")
        sys.exit(1)
    print(f"  phone_id={phone_id}\n")

    fired, failed = 0, 0
    for i, contact in enumerate(to_call, 1):
        print(f"[{i}/{len(to_call)}] {contact['phone']}  {contact['name']}  ({contact['industry']})")
        conv_id = _fire_call(contact, phone_id)
        if conv_id:
            print(f"  -> conv_id={conv_id}")
            fired += 1
        else:
            failed += 1
        if i < len(to_call):
            time.sleep(CALL_DELAY_SECS)

    print(f"\n{'='*60}")
    print(f"  DONE — Fired: {fired}  |  Failed: {failed}")
    print(f"{'='*60}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fire ElevenLabs calls for queued GHL contacts")
    parser.add_argument("--dry-run", action="store_true", help="Print queue, no calls fired")
    parser.add_argument("--max",     type=int, default=None, help="Cap calls this run")
    parser.add_argument("--test",    default=None, metavar="PHONE", help="Fire one test call to PHONE")
    args = parser.parse_args()
    run(dry_run=args.dry_run, max_calls=args.max, test_number=args.test)
