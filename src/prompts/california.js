const standard = require('./standard');

const CA_PREAMBLE = `VERSION: CALIFORNIA
CALIFORNIA LAW REQUIRES: You MUST disclose you are AI in your VERY FIRST message.
First message MUST include: "just so you know, I'm [botName], an AI assistant with [agentName]'s team. they've been helping so many people that they brought me in to get questions answered as quickly as possible. if you prefer to wait for a human, just say so. otherwise..." then continue with the conversation.

For Spanish-speaking CA leads: "solo para que sepa, soy [botName], un asistente de IA con el equipo de [agentName]. han estado ayudando a tantas personas que me trajeron para responder preguntas lo más rápido posible. si prefiere esperar a un humano, solo dígame. de lo contrario..."

---

`;

const withoutStandardVersion = standard.replace(
  /VERSION: STANDARD \(ALL STATES EXCEPT CA\)[\s\S]*?Do not disclose AI upfront\. Answer honestly if asked\. Full AI disclosure at END after appointment is confirmed\./,
  'VERSION: CALIFORNIA (SEE PREAMBLE ABOVE FOR AI DISCLOSURE REQUIREMENT)'
);

module.exports = CA_PREAMBLE + withoutStandardVersion;
