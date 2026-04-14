const axios = require('axios');

async function firePostCallRouter(conv, outcome) {
  const url = process.env.GHL_POST_CALL_ROUTER_URL;
  if (!url) {
    console.warn('[pcr] GHL_POST_CALL_ROUTER_URL not set, skipping');
    return { ok: false, skipped: true };
  }

  const appointmentOutcomeMap = {
    appointment_booked: 'set',
    fex_immediate: 'callback',
    mp_immediate: 'human_handoff',
    human_handoff: 'human_handoff',
    dnc: 'DNC'
  };

  const callPath = conv.product_type === 'mp'
    ? 'Mortgage Protection'
    : conv.product_type === 'fex'
      ? 'Final Expense'
      : '';

  const payload = {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: 'claude_sms_bot',
      agent_name: 'PH Insurance SMS Bot',
      status: 'done',
      metadata: {
        phone_call: {
          direction: 'inbound',
          external_number: conv.phone || '',
          type: 'claude_sms'
        },
        call_duration_secs: 0,
        termination_reason: 'SMS conversation completed'
      },
      analysis: {
        data_collection_results: {
          prospect_first_name: { value: conv.first_name || '' },
          prospect_last_name: { value: conv.last_name || '' },
          prospect_phone: { value: conv.phone || '' },
          prospect_state: { value: conv.state || '' },
          coverage_subject: { value: conv.collected_coverage_for || '' },
          call_path_taken: { value: callPath },
          appointment_outcome: { value: appointmentOutcomeMap[outcome] || outcome || '' },
          appointment_datetime: { value: conv.collected_appointment_time || '' },
          appointment_set: { value: outcome === 'appointment_booked' },
          call_sentiment: { value: conv.call_sentiment || '' },
          health_flag: { value: !!conv.health_flag },
          health_notes: { value: conv.collected_health || '' },
          age_range: { value: conv.collected_age || '' },
          existing_coverage: { value: false },
          decision_maker_confirmed: { value: !!conv.decision_maker_confirmed },
          spouse_name: { value: conv.collected_spouse_name || '' },
          motivation_level_1: { value: conv.motivation_level_1 || '' },
          objection_type: { value: conv.objection_type || '' },
          dnc_requested: { value: outcome === 'dnc' },
          disqualified: { value: false },
          mortgage_balance: { value: conv.existing_mortgage_balance || '' }
        },
        call_successful: (outcome === 'appointment_booked' || outcome === 'fex_immediate' || outcome === 'mp_immediate') ? 'success' : 'failure',
        transcript_summary: conv.call_summary || '',
        call_summary_title: 'Claude SMS Qualification'
      },
      conversation_initiation_client_data: {
        dynamic_variables: {
          first_name: conv.first_name || '',
          bot_name: conv.bot_name || '',
          lead_type: conv.product_type || '',
          state: conv.state || '',
          call_direction: 'sms_inbound'
        }
      }
    }
  };

  try {
    const res = await axios.post(url, payload, { timeout: 15000 });
    return { ok: true, status: res.status };
  } catch (err) {
    console.error('[pcr] failed', err.response?.status, err.response?.data || err.message);
    return { ok: false, error: err.response?.data || err.message };
  }
}

module.exports = { firePostCallRouter };
