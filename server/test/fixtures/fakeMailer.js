// Stands in for the SMTP transport inside a test server (helpers.startServer with EMAIL_TRANSPORT
// pointing here), so the server believes it has a working mailer and the real routes run end to
// end, while nothing is ever sent anywhere.
//
// Every message is appended to DATA_DIR/mail-sent.jsonl, which is how a test — a different process —
// reads the link a person would have been emailed. An address containing "bounce" is refused, as
// a mail server does for a mailbox that does not exist.
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.DATA_DIR || '.', 'mail-sent.jsonl');

async function sendMail(message) {
  if (String(message.to).includes('bounce')) throw new Error('550 mailbox unavailable');
  fs.appendFileSync(LOG, `${JSON.stringify({ to: message.to, subject: message.subject, html: message.html })}\n`);
  return { accepted: [message.to] };
}

module.exports = { sendMail };
