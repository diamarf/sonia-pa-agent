#!/usr/bin/env node

/**
 * SONIA - PERSONAL ASSISTANT AGENT - TELEGRAM VERSION
 * With automatic token refresh
 */

require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const schedule = require('node-schedule');

const CONFIG = {
  emails: {
    primary: process.env.PRIMARY_EMAIL || 'diamarf@gmail.com',
    secondary: process.env.SECONDARY_EMAIL || 'diamarferrer@hotmail.es',
    pa: process.env.PA_EMAIL || 'digitalgrwothsg@gmail.com'
  },
  calendar: {
    primary: process.env.PRIMARY_EMAIL || 'diamarf@gmail.com',
    inviteRecipients: [
      process.env.PA_EMAIL || 'digitalgrwothsg@gmail.com',
      process.env.PRIMARY_EMAIL || 'diamarf@gmail.com',
      process.env.SECONDARY_EMAIL || 'diamarferrer@hotmail.es'
    ]
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    apiUrl: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
  }
};

const STATE = {
  pendingEmails: [],
  pendingMeetings: [],
  isInitialized: false,
  oauthReady: false
};

// OAuth setup with refresh capability
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3000/auth/callback'
);

// Set initial credentials with refresh token
oauth2Client.setCredentials({
  access_token: "ya29.a0AQvPyIPzUuW_9ympgBg_HIko4yPzCDxSlEZfPwS1mVYiJgaTSogGcV3EizH3sCqzqUD7CYumgacUDR5QrvtyxcaEiKoul2qQUIZs3OC_5VegZssWsg3sxwSsfiQ6J_n-z6Nl6o_xeUt42E8xuJC1PI6uZtEBfle2Q9OKNSNuB5IiHIKGhg7XKqZznKUPiWVV5VJA9Z0aCgYKAYkSARQSFQHGX2Mibcz2b10nELXuTAAmm48VQA0206",
  refresh_token: "1//03S2WzBKQsrIlCgYIARAAGAMSNwF-L9Ir7ChQqsOFx9OetnnxY15RgMKEak2PtGA0kEgcIt6KBzlGwNxjaRVeYNEb_4WE3NWcbqU",
  expiry_date: 1777459147595
});

STATE.oauthReady = true;
console.log('✅ Google OAuth configured');

// Express server
const app = express();
app.use(express.json());

app.post('/telegram/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) {
      res.json({ ok: true });
      return;
    }
    
    console.log(`📨 ${message.from.first_name}: ${message.text}`);
    await handleUserMessage(message.text, message.chat.id);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.json({ ok: false });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', initialized: STATE.isInitialized, oauth: STATE.oauthReady });
});

app.get('/status', (req, res) => {
  res.json({ emails: STATE.pendingEmails.length, meetings: STATE.pendingMeetings.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}\n`));

// Gmail & Calendar
const gmail = google.gmail({ version: 'v1' });
const calendar = google.calendar({ version: 'v3' });

async function checkEmails() {
  try {
    // Auto-refresh token if needed
    const credentials = oauth2Client.credentials;
    if (credentials.expiry_date && credentials.expiry_date <= Date.now()) {
      console.log('🔄 Refreshing OAuth token...');
      await oauth2Client.refreshAccessToken();
    }

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 10,
      auth: oauth2Client
    });
    
    const emails = [];
    if (response.data.messages) {
      console.log(`📧 Found ${response.data.messages.length} unread emails`);
      for (const msg of response.data.messages) {
        try {
          const fullMsg = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full',
            auth: oauth2Client
          });
          emails.push(parseEmail(fullMsg.data));
        } catch (e) {
          console.error('Error reading message:', e.message);
        }
      }
    } else {
      console.log('📧 No unread emails');
    }
    STATE.pendingEmails = emails;
    return emails;
  } catch (error) {
    console.error('📧 Email error:', error.message);
    return [];
  }
}

function parseEmail(msg) {
  try {
    const headers = msg.payload.headers || [];
    const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
    return {
      from: getHeader('From'),
      subject: getHeader('Subject'),
      body: getBodyText(msg.payload)
    };
  } catch (e) {
    return { from: 'Unknown', subject: '(error)', body: '(error)' };
  }
}

function getBodyText(payload) {
  try {
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8').substring(0, 200);
        }
      }
    }
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8').substring(0, 200);
    }
  } catch (e) {}
  return '(no body)';
}

async function getCalendarEvents(daysAhead = 7) {
  try {
    // Auto-refresh token if needed
    const credentials = oauth2Client.credentials;
    if (credentials.expiry_date && credentials.expiry_date <= Date.now()) {
      console.log('🔄 Refreshing OAuth token...');
      await oauth2Client.refreshAccessToken();
    }

    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
    
    const response = await calendar.events.list({
      calendarId: CONFIG.calendar.primary,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      auth: oauth2Client
    });
    
    STATE.pendingMeetings = response.data.items || [];
    console.log(`📅 Found ${STATE.pendingMeetings.length} calendar events`);
    return STATE.pendingMeetings;
  } catch (error) {
    console.error('📅 Calendar error:', error.message);
    return [];
  }
}

function formatWithEmails(message) {
  return `${message}

📬 *Active Accounts:*
• ${CONFIG.emails.pa}
• ${CONFIG.emails.primary}
• ${CONFIG.emails.secondary}`;
}

async function sendTelegramMessage(chatId, text) {
  try {
    await axios.post(`${CONFIG.telegram.apiUrl}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('❌ Telegram error:', error.message);
  }
}

async function handleUserMessage(text, chatId) {
  const lowerText = text.toLowerCase().trim();
  
  if (lowerText.includes('show inbox')) {
    const emails = await checkEmails();
    if (emails.length === 0) {
      await sendTelegramMessage(chatId, formatWithEmails('✅ No unread emails!'));
    } else {
      let list = '';
      emails.slice(0, 5).forEach((e, i) => {
        list += `${i + 1}. ${e.subject}\n   From: ${e.from}\n`;
      });
      if (emails.length > 5) list += `\n... and ${emails.length - 5} more`;
      await sendTelegramMessage(chatId, formatWithEmails(`📧 *Unread Emails (${emails.length}):*\n\n${list}`));
    }
    
  } else if (lowerText.includes('today')) {
    const meetings = await getCalendarEvents(1);
    const today = meetings.filter(m => {
      const d = new Date(m.start.dateTime);
      const now = new Date();
      return d.toDateString() === now.toDateString();
    });
    
    if (today.length === 0) {
      await sendTelegramMessage(chatId, formatWithEmails('📅 No meetings today!'));
    } else {
      let list = '';
      today.forEach(m => {
        const time = m.start.dateTime ? m.start.dateTime.substring(11, 16) : 'TBD';
        list += `• ${time} - ${m.summary}\n`;
      });
      await sendTelegramMessage(chatId, formatWithEmails(`📅 *Today (${today.length}):*\n\n${list}`));
    }
    
  } else if (lowerText.includes('help')) {
    await sendTelegramMessage(chatId, formatWithEmails(
      '👋 Hi! I\'m Sonia.\n\n' +
      '📧 "show inbox"\n' +
      '📅 "today"\n' +
      '❓ "help"'
    ));
    
  } else {
    await sendTelegramMessage(chatId, formatWithEmails(
      '👋 I\'m Sonia!\n\n' +
      'Try: "show inbox", "today", or "help"'
    ));
  }
}

schedule.scheduleJob('0 * * * *', async () => {
  console.log('⏰ Hourly check');
  await checkEmails();
});

STATE.isInitialized = true;
console.log('✅ Sonia is ready!\n');

process.on('SIGINT', () => {
  console.log('\n👋 Goodbye!');
  process.exit(0);
});
