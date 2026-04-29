#!/usr/bin/env node
require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');

const EMAILS = {
  primary: 'diamarf@gmail.com',
  secondary: 'diamarferrer@hotmail.es',
  pa: 'digitalgrwothsg@gmail.com'
};

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  access_token: process.env.GOOGLE_ACCESS_TOKEN,
  expiry_date: parseInt(process.env.GOOGLE_EXPIRY_DATE || '0')
});

const gmail = google.gmail({ version: 'v1' });
const calendar = google.calendar({ version: 'v3' });

async function ensureValidToken() {
  try {
    const creds = oauth2Client.credentials;
    if (!creds.expiry_date || creds.expiry_date <= Date.now()) {
      await oauth2Client.refreshAccessToken();
    }
    return true;
  } catch (e) {
    console.error('Token error:', e.message);
    return false;
  }
}

async function getUnreadEmails() {
  try {
    await ensureValidToken();
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 10,
      auth: oauth2Client
    });
    if (!res.data.messages) return [];
    const emails = [];
    for (const msg of res.data.messages.slice(0, 5)) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
        auth: oauth2Client
      });
      const headers = full.data.payload.headers || [];
      emails.push({
        subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
        from: headers.find(h => h.name === 'From')?.value || 'Unknown'
      });
    }
    return emails;
  } catch (e) {
    console.error('Gmail error:', e.message);
    return [];
  }
}

async function getTodaysMeetings() {
  try {
    await ensureValidToken();
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const res = await calendar.events.list({
      calendarId: EMAILS.primary,
      timeMin: start,
      timeMax: end,
      singleEvents: true,
      orderBy: 'startTime',
      auth: oauth2Client
    });
    if (!res.data.items) return [];
    return res.data.items.slice(0, 5).map(e => ({
      summary: e.summary || '(no title)',
      time: e.start.dateTime ? e.start.dateTime.substring(11, 16) : 'All day'
    }));
  } catch (e) {
    console.error('Calendar error:', e.message);
    return [];
  }
}

async function sendTelegram(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  });
}

function withEmails(msg) {
  return `${msg}\n\n📬 *Active Accounts:*\n• ${EMAILS.pa}\n• ${EMAILS.primary}\n• ${EMAILS.secondary}`;
}

async function handleMessage(text, chatId) {
  const cmd = text.toLowerCase().trim();
  if (cmd.includes('inbox')) {
    const emails = await getUnreadEmails();
    if (emails.length === 0) {
      await sendTelegram(chatId, withEmails('✅ No unread emails!'));
      return;
    }
    let list = '';
    emails.forEach((e, i) => {
      list += `${i + 1}. ${e.subject}\n   From: ${e.from}\n`;
    });
    await sendTelegram(chatId, withEmails(`📧 *Unread Emails (${emails.length}):*\n\n${list}`));
  } else if (cmd.includes('today')) {
    const meetings = await getTodaysMeetings();
    if (meetings.length === 0) {
      await sendTelegram(chatId, withEmails('📅 No meetings today!'));
      return;
    }
    let list = '';
    meetings.forEach(m => {
      list += `• ${m.time} - ${m.summary}\n`;
    });
    await sendTelegram(chatId, withEmails(`📅 *Today (${meetings.length}):*\n\n${list}`));
  } else {
    await sendTelegram(chatId, withEmails('👋 Hi! Try: "show inbox" or "today"'));
  }
}

const app = express();
app.use(express.json());

app.post('/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body.message;
    if (msg && msg.text) {
      console.log(`Message: ${msg.text}`);
      await handleMessage(msg.text, msg.chat.id);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Error:', e.message);
    res.json({ ok: false });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sonia on port ${PORT}`));
