const axios = require('axios');
const logger = require('./logger');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-04-15';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: VERSION,
    'Content-Type': 'application/json'
  };
}

async function getCalendars(ghlToken, locationId, contactIdForLog) {
  try {
    const res = await axios.get(`${GHL_BASE}/calendars/`, {
      headers: authHeaders(ghlToken),
      params: { locationId },
      timeout: 15000
    });
    const calendars = Array.isArray(res.data?.calendars) ? res.data.calendars : [];
    logger.log('calendar', 'info', contactIdForLog || null, 'Fetched calendars', { count: calendars.length });
    return calendars;
  } catch (err) {
    logger.log('calendar', 'error', contactIdForLog || null, 'getCalendars failed', {
      status: err.response?.status,
      error: err.response?.data || err.message
    });
    throw err;
  }
}

function findCalendarByProduct(calendars, productType) {
  if (!Array.isArray(calendars) || !calendars.length) return null;
  const active = calendars.filter((c) => c.isActive !== false);
  const prod = (productType || '').toLowerCase();

  let targetName;
  if (prod.includes('mortgage') || prod === 'mp') {
    targetName = 'mortgage protection video';
  } else if (prod.includes('final expense') || prod === 'fex' || prod === 'fx') {
    targetName = 'final expense phone';
  } else {
    targetName = 'final expense phone';
  }

  const match = active.find((c) => (c.name || '').toLowerCase() === targetName);
  if (match) return match;
  const partial = active.find((c) => (c.name || '').toLowerCase().includes(targetName));
  if (partial) return partial;
  return active[0] || null;
}

async function getFreeSlots(ghlToken, calendarId, startDate, endDate, timezone, contactIdForLog) {
  try {
    const res = await axios.get(`${GHL_BASE}/calendars/${calendarId}/free-slots`, {
      headers: authHeaders(ghlToken),
      params: { startDate, endDate, timezone },
      timeout: 20000
    });

    const data = res.data || {};
    const slots = [];

    for (const [dayKey, dayVal] of Object.entries(data)) {
      if (!dayVal || typeof dayVal !== 'object') continue;
      const daySlots = Array.isArray(dayVal.slots) ? dayVal.slots : [];
      for (const s of daySlots) {
        if (typeof s === 'string') {
          slots.push({ startTime: s, endTime: null, dayKey });
        } else if (s && typeof s === 'object') {
          slots.push({
            startTime: s.startTime || s.start || s,
            endTime: s.endTime || s.end || null,
            dayKey
          });
        }
      }
    }

    logger.log('calendar', 'info', contactIdForLog || null, 'Fetched free slots', {
      calendar_id: calendarId,
      slot_count: slots.length,
      timezone,
      start_date: startDate,
      end_date: endDate
    });

    return slots;
  } catch (err) {
    logger.log('calendar', 'error', contactIdForLog || null, 'getFreeSlots failed', {
      calendar_id: calendarId,
      status: err.response?.status,
      error: err.response?.data || err.message
    });
    throw err;
  }
}

async function cancelAppointment(ghlToken, appointmentId, contactIdForLog) {
  try {
    const res = await axios.delete(`${GHL_BASE}/calendars/events/appointments/${appointmentId}`, {
      headers: authHeaders(ghlToken),
      timeout: 15000
    });
    logger.log('calendar', 'info', contactIdForLog || null, 'Appointment cancelled', {
      appointment_id: appointmentId,
      status: res.status
    });
    return { ok: true, status: res.status };
  } catch (err) {
    logger.log('calendar', 'error', contactIdForLog || null, 'cancelAppointment failed', {
      appointment_id: appointmentId,
      status: err.response?.status,
      error: err.response?.data || err.message
    });
    return { ok: false, error: err.response?.data || err.message };
  }
}

async function bookAppointment(ghlToken, { calendarId, locationId, contactId, startTime, endTime, title, assignedUserId }, contactIdForLog) {
  const body = {
    calendarId,
    locationId,
    contactId,
    startTime,
    endTime,
    title: title || 'Appointment',
    appointmentStatus: 'confirmed'
  };
  if (assignedUserId) body.assignedUserId = assignedUserId;

  try {
    const res = await axios.post(`${GHL_BASE}/calendars/events/appointments`, body, {
      headers: authHeaders(ghlToken),
      timeout: 20000
    });
    logger.log('calendar', 'info', contactIdForLog || null, 'Appointment booked', {
      calendar_id: calendarId,
      appointment_id: res.data?.id,
      start_time: startTime,
      end_time: endTime,
      status: res.status
    });
    return { ok: true, appointment: res.data };
  } catch (err) {
    logger.log('calendar', 'error', contactIdForLog || null, 'bookAppointment failed', {
      calendar_id: calendarId,
      status: err.response?.status,
      error: err.response?.data || err.message,
      request: body
    });
    return { ok: false, error: err.response?.data || err.message };
  }
}

const STATE_TIMEZONE = {
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles', OR: 'America/Los_Angeles', NV: 'America/Los_Angeles',
  AZ: 'America/Phoenix',
  UT: 'America/Denver', CO: 'America/Denver', NM: 'America/Denver', WY: 'America/Denver', MT: 'America/Denver', ID: 'America/Denver',
  TX: 'America/Chicago', OK: 'America/Chicago', KS: 'America/Chicago', NE: 'America/Chicago', SD: 'America/Chicago', ND: 'America/Chicago',
  MN: 'America/Chicago', IA: 'America/Chicago', MO: 'America/Chicago', AR: 'America/Chicago', LA: 'America/Chicago', MS: 'America/Chicago',
  AL: 'America/Chicago', TN: 'America/Chicago', KY: 'America/Chicago', IL: 'America/Chicago', WI: 'America/Chicago',
  FL: 'America/New_York', GA: 'America/New_York', SC: 'America/New_York', NC: 'America/New_York', VA: 'America/New_York',
  WV: 'America/New_York', OH: 'America/New_York', MI: 'America/New_York', IN: 'America/New_York', PA: 'America/New_York',
  NY: 'America/New_York', NJ: 'America/New_York', CT: 'America/New_York', MA: 'America/New_York', RI: 'America/New_York',
  VT: 'America/New_York', NH: 'America/New_York', ME: 'America/New_York', DE: 'America/New_York', MD: 'America/New_York', DC: 'America/New_York',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu'
};

function timezoneForState(state) {
  if (!state) return 'America/New_York';
  const key = String(state).trim().toUpperCase();
  if (key.length > 2) {
    const k = key.slice(0, 2);
    return STATE_TIMEZONE[k] || 'America/New_York';
  }
  return STATE_TIMEZONE[key] || 'America/New_York';
}

function formatSlotLabel(slot, timezone) {
  const d = new Date(slot.startTime);
  if (isNaN(d.getTime())) return slot.startTime;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    return fmt.format(d);
  } catch {
    return d.toISOString();
  }
}

function formatSlotsForPrompt(slots, timezone, maxSlots = 30) {
  if (!slots || !slots.length) return '(no available slots in the next few days)';
  const byDay = new Map();
  for (const s of slots.slice(0, maxSlots)) {
    const d = new Date(s.startTime);
    if (isNaN(d.getTime())) continue;
    let dayLabel;
    try {
      dayLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, weekday: 'long', month: 'short', day: 'numeric'
      }).format(d);
    } catch {
      dayLabel = s.dayKey || d.toDateString();
    }
    let timeLabel;
    try {
      timeLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true
      }).format(d);
    } catch {
      timeLabel = d.toISOString();
    }
    if (!byDay.has(dayLabel)) byDay.set(dayLabel, []);
    byDay.get(dayLabel).push(timeLabel);
  }
  const lines = [];
  for (const [day, times] of byDay) {
    lines.push(`- ${day}: ${times.join(', ')}`);
  }
  return lines.join('\n');
}

function findSlotMatchingTime(slots, appointmentText, timezone) {
  if (!slots || !slots.length || !appointmentText) return null;
  const norm = String(appointmentText).toLowerCase();

  const timeMatch = norm.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!timeMatch) return null;
  let hour = parseInt(timeMatch[1], 10);
  const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
  const ampm = timeMatch[3];
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const wantsDayRef = {
    tomorrow: 1, today: 0,
    monday: -1, mon: -1, tuesday: -2, tue: -2, wednesday: -3, wed: -3,
    thursday: -4, thu: -4, friday: -5, fri: -5, saturday: -6, sat: -6, sunday: -7, sun: -7
  };

  let dayHint = null;
  for (const key of Object.keys(wantsDayRef)) {
    if (norm.includes(key)) { dayHint = wantsDayRef[key]; break; }
  }

  let best = null;
  let bestScore = Infinity;
  for (const slot of slots) {
    const d = new Date(slot.startTime);
    if (isNaN(d.getTime())) continue;

    let slotHour, slotMinute, slotDow;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: false, weekday: 'short'
      }).formatToParts(d);
      slotHour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
      slotMinute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
      slotDow = parts.find((p) => p.type === 'weekday')?.value?.toLowerCase();
    } catch {
      slotHour = d.getHours();
      slotMinute = d.getMinutes();
    }

    const timeDiff = Math.abs((slotHour * 60 + slotMinute) - (hour * 60 + minute));
    let dayPenalty = 0;
    if (dayHint === 1) {
      const today = new Date();
      const slotDate = d.toDateString();
      const tomorrowDate = new Date(today.getTime() + 86400000).toDateString();
      if (slotDate !== tomorrowDate) dayPenalty = 10000;
    } else if (dayHint === 0) {
      if (d.toDateString() !== new Date().toDateString()) dayPenalty = 10000;
    } else if (dayHint !== null && dayHint < 0 && slotDow) {
      const dayMap = { mon: -1, tue: -2, wed: -3, thu: -4, fri: -5, sat: -6, sun: -7 };
      if (dayMap[slotDow] !== dayHint) dayPenalty = 10000;
    }

    const score = timeDiff + dayPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = slot;
    }
  }

  if (bestScore > 90 && bestScore < 10000) return best;
  if (bestScore >= 10000) return null;
  return best;
}

function inferEndTime(slot, defaultMinutes = 30) {
  if (slot.endTime) return slot.endTime;
  const d = new Date(slot.startTime);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + defaultMinutes * 60000).toISOString();
}

module.exports = {
  getCalendars,
  findCalendarByProduct,
  getFreeSlots,
  bookAppointment,
  cancelAppointment,
  timezoneForState,
  formatSlotsForPrompt,
  formatSlotLabel,
  findSlotMatchingTime,
  inferEndTime
};
