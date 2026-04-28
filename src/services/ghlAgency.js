const axios = require('axios');
const logger = require('./logger');

const GHL_BASE = 'https://services.leadconnectorhq.com';

function agencyHeaders() {
  const key = process.env.GHL_AGENCY_API_KEY;
  if (!key) throw new Error('GHL_AGENCY_API_KEY env var not set');
  return {
    Authorization: `Bearer ${key}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };
}

function locationHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };
}

// Create a new GHL sub-account under the agency
async function createLocation({ businessName, agentPhone, agentEmail, timezone = 'America/Chicago', country = 'US' }) {
  const companyId = process.env.GHL_COMPANY_ID;
  if (!companyId) throw new Error('GHL_COMPANY_ID env var not set');

  const res = await axios.post(`${GHL_BASE}/locations/`, {
    name: businessName,
    phone: agentPhone || '',
    companyId,
    email: agentEmail || '',
    timezone,
    country,
  }, { headers: agencyHeaders(), timeout: 30000 });

  logger.log('ghl_agency', 'info', null, 'Location created', { locationId: res.data?.id, name: businessName });
  return res.data; // { id, name, ... }
}

// Exchange agency token for a short-lived location-scoped access token.
// Use this token for calls that need to act WITHIN a specific sub-account.
async function getLocationToken(locationId) {
  const companyId = process.env.GHL_COMPANY_ID;
  if (!companyId) throw new Error('GHL_COMPANY_ID env var not set');

  const res = await axios.post(`${GHL_BASE}/oauth/locationToken`, {
    companyId,
    locationId,
  }, { headers: agencyHeaders(), timeout: 15000 });

  return res.data?.access_token;
}

// Get all existing custom values for a location
async function listCustomValues(locationId, token) {
  const res = await axios.get(`${GHL_BASE}/locations/${locationId}/customValues`, {
    headers: locationHeaders(token),
    timeout: 15000,
  });
  return res.data?.customValues || [];
}

// Create or update a single custom value by name
async function setCustomValue(locationId, name, value, token) {
  const existing = await listCustomValues(locationId, token);
  const match = existing.find((cv) => cv.name?.toLowerCase() === name.toLowerCase());

  if (match) {
    await axios.put(`${GHL_BASE}/locations/${locationId}/customValues/${match.id}`,
      { value: String(value) },
      { headers: locationHeaders(token), timeout: 15000 }
    );
    return { action: 'updated', id: match.id };
  }

  const res = await axios.post(`${GHL_BASE}/locations/${locationId}/customValues`,
    { name, value: String(value) },
    { headers: locationHeaders(token), timeout: 15000 }
  );
  return { action: 'created', id: res.data?.customValue?.id };
}

// Bulk-set custom values from a { name → value } map. Skips blank values.
// Returns { ok, errors }
async function setCustomValues(locationId, valueMap, token) {
  // Fetch existing list once up front to avoid N+1 GET requests
  let existing = [];
  try {
    existing = await listCustomValues(locationId, token);
  } catch (err) {
    logger.log('ghl_agency', 'warn', null, 'Could not prefetch custom values', { error: err.message });
  }
  const existingMap = Object.fromEntries(existing.map((cv) => [cv.name?.toLowerCase(), cv]));

  const errors = [];
  for (const [name, value] of Object.entries(valueMap)) {
    if (value === null || value === undefined || value === '') continue;
    try {
      const match = existingMap[name.toLowerCase()];
      if (match) {
        await axios.put(`${GHL_BASE}/locations/${locationId}/customValues/${match.id}`,
          { value: String(value) },
          { headers: locationHeaders(token), timeout: 15000 }
        );
      } else {
        await axios.post(`${GHL_BASE}/locations/${locationId}/customValues`,
          { name, value: String(value) },
          { headers: locationHeaders(token), timeout: 15000 }
        );
      }
    } catch (err) {
      logger.log('ghl_agency', 'error', null, `Failed to set custom value: ${name}`, { error: err.message });
      errors.push({ name, error: err.message });
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { createLocation, getLocationToken, setCustomValues, setCustomValue };
