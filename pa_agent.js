#!/usr/bin/env node
require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  access_token: "ya29.a0AQvPyIPzUuW_9ympgBg_HIko4yPzCDxSlEZfPwS1mVYiJgaTSogGcV3EizH3sCqzqUD7CYumgacUDR5QrvtyxcaEiKoul2qQUIZs3OC_5VegZssWsg3sxwSsfiQ6J_n-z6Nl6o_xeUt42E8xuJC1PI6uZtEBfle2Q9OKNSNuB5IiHIKGhg7XKqZznKUPiWVV5VJA9Z0aCgYKAYkSARQSFQHGX2Mibcz2b10nELXuTAAmm48VQA0206",
  refresh_token: "1//03S2WzBKQsrIlCgYIARAAGAMSNwF-L9Ir7ChQqsOFx9OetnnxY15RgMKEak2PtGA0kEgcIt6KBzlGwNxjaRVeYNEb_4WE3NWcbqU",
  expiry_date: 1777459147595
});

const app = express();
app.use(express.json());

const gmail = google.gmail({ version: 'v1' });
const calendar = google.calendar({ version: 'v3' });

app.post('/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.json({ ok: true });
    
    const text = msg.text.toLowerCase();
    if (text.includes('show inbox')) {
      const emails = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 5, auth: oauth2Client });
      const count = emails.data.messages ? emails.data.messages.length : 0;
      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: msg.chat.id,
        text: `📧 You have ${count} unread emails\n\n📬 Accounts: digitalgrwothsg@gmail.com, diamarf@gmail.com, diamarferrer@hotmail.es`,
        parse_mode: 'Markdown'
      });
    } else if (text.includes('today')) {
      const now = new Date();
      const events = await calendar.events.list({ calendarId: 'diamarf@gmail.com', timeMin: now.toISOString(), maxResults: 10, auth: oauth2Client });
      const count = events.data.items ? events.data.items.length : 0;
      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: msg.chat.id,
        text: `📅 You have ${count} meetings\n\n📬 Accounts: digitalgrwothsg@gmail.com, diamarf@gmail.com, diamarferrer@hotmail.es`,
        parse_mode: 'Markdown'
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: msg.chat.id,
        text: `Hi! Try "show inbox" or "today"\n\n📬 Accounts: digitalgrwothsg@gmail.com, diamarf@gmail.com, diamarferrer@hotmail.es`,
        parse_mode: 'Markdown'
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.json({ ok: false });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Sonia running'));
