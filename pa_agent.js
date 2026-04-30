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

const STATE = {
  emailDrafts: {},
  meetingDrafts: {},
  lastEmailContext: {}
};

async function ensureValidToken() {
  try {
    const creds = oauth2Client.credentials;
    if (!creds.expiry_date || creds.expiry_date <= Date.now()) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
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
      maxResults: 30,
      auth: oauth2Client
    });
    if (!res.data.messages) return [];
    const emails = [];
    for (const msg of res.data.messages.slice(0, 20)) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
        auth: oauth2Client
      });
      const headers = full.data.payload.headers || [];
      emails.push({
        id: msg.id,
        subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
        from: headers.find(h => h.name === 'From')?.value || 'Unknown',
        snippet: full.data.snippet || ''
      });
    }
    return emails;
  } catch (e) {
    console.error('Gmail error:', e.message);
    return [];
  }
}

async function markAsRead(messageIds) {
  try {
    await ensureValidToken();
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: messageIds,
        removeLabelIds: ['UNREAD']
      },
      auth: oauth2Client
    });
    return true;
  } catch (e) {
    console.error('Mark read error:', e.message);
    return false;
  }
}

async function sendEmail(to, subject, body, inReplyTo = null) {
  try {
    await ensureValidToken();
    const email = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
    ].join('\n');
    const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedEmail, threadId: inReplyTo },
      auth: oauth2Client
    });
    return true;
  } catch (e) {
    console.error('Send email error:', e.message);
    return false;
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
    return res.data.items.slice(0, 50).map(e => ({
      id: e.id,
      summary: e.summary || '(no title)',
      time: e.start.dateTime ? e.start.dateTime.substring(11, 16) : 'All day',
      start: e.start.dateTime || e.start.date
    }));
  } catch (e) {
    console.error('Calendar error:', e.message);
    return [];
  }
}

async function getUpcomingMeetings(days = 7) {
  try {
    await ensureValidToken();
    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    const res = await calendar.events.list({
      calendarId: EMAILS.primary,
      timeMin: now.toISOString(),
      timeMax: end,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
      auth: oauth2Client
    });
    if (!res.data.items) return [];
    return res.data.items.slice(0, 50).map(e => ({
      id: e.id,
      summary: e.summary || '(no title)',
      start: e.start.dateTime || e.start.date,
      time: e.start.dateTime ? e.start.dateTime.substring(11, 16) : 'All day'
    }));
  } catch (e) {
    console.error('Calendar error:', e.message);
    return [];
  }
}

async function createMeeting(title, attendees, startDateTime, durationMinutes = 60) {
  try {
    await ensureValidToken();
    const start = new Date(startDateTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    const event = {
      summary: title,
      start: { dateTime: start.toISOString(), timeZone: 'Europe/London' },
      end: { dateTime: end.toISOString(), timeZone: 'Europe/London' },
      attendees: [
        ...attendees.map(email => ({ email })),
        { email: EMAILS.pa },
        { email: EMAILS.primary },
        { email: EMAILS.secondary }
      ]
    };
    const res = await calendar.events.insert({
      calendarId: EMAILS.primary,
      resource: event,
      sendUpdates: 'all',
      auth: oauth2Client
    });
    return res.data;
  } catch (e) {
    console.error('Create meeting error:', e.message);
    return null;
  }
}

async function sendTelegram(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

function generateSmartReply(emailSubject, emailSnippet) {
  const lower = (emailSubject + ' ' + emailSnippet).toLowerCase();
  if (lower.includes('meeting') || lower.includes('call') || lower.includes('schedule')) {
    return "Thanks for reaching out. I'm available for a meeting. What times work for you?";
  }
  if (lower.includes('thank') || lower.includes('appreciate')) {
    return "You're welcome! Let me know if you need anything else.";
  }
  if (lower.includes('question') || lower.includes('ask')) {
    return "Thanks for your question. Let me get back to you with more details shortly.";
  }
  return "Thanks for your email. I'll review this and get back to you soon.";
}

async function handleMessage(text, chatId) {
  const cmd = text.toLowerCase().trim();
  
  console.log(`[CMD] "${cmd}"`);
  
  if (cmd.includes('inbox') || cmd.includes('emails')) {
    const emails = await getUnreadEmails();
    if (emails.length === 0) {
      await sendTelegram(chatId, '✅ No unread emails!');
      return;
    }
    STATE.lastEmailContext[chatId] = emails;
    let list = '';
    emails.forEach((e, i) => {
      list += `*${i + 1}.* ${e.subject}\n   _From: ${e.from}_\n   ${e.snippet.substring(0, 80)}...\n\n`;
    });
    await sendTelegram(chatId, `📧 *Unread Emails (${emails.length}):*\n\n${list}Reply with number to draft response (e.g., "reply 1")`);
  }
  
  else if (cmd.startsWith('mark as read ')) {
    const nums = cmd.replace('mark as read ', '').split(',').map(n => parseInt(n.trim()));
    const emails = STATE.lastEmailContext[chatId] || [];
    const ids = nums.filter(n => n >= 1 && n <= emails.length).map(n => emails[n - 1].id);
    if (ids.length === 0) {
      await sendTelegram(chatId, '❌ Invalid numbers');
      return;
    }
    const ok = await markAsRead(ids);
    await sendTelegram(chatId, ok ? `✅ Marked ${ids.length} as read` : '❌ Failed');
  }
  
  else if (cmd.match(/^reply\s+(\d+)/)) {
    const num = parseInt(cmd.match(/^reply\s+(\d+)/)[1]);
    const emails = STATE.lastEmailContext[chatId] || [];
    if (num < 1 || num > emails.length) {
      await sendTelegram(chatId, '❌ Invalid email number. Try "show inbox" first.');
      return;
    }
    const email = emails[num - 1];
    const reply = generateSmartReply(email.subject, email.snippet);
    const draftId = `draft_${Date.now()}`;
    STATE.emailDrafts[draftId] = {
      to: email.from.match(/<(.+?)>/) ? email.from.match(/<(.+?)>/)[1] : email.from,
      subject: `Re: ${email.subject}`,
      body: reply,
      threadId: email.id
    };
    await sendTelegram(chatId, `📝 *Draft Reply:*\n\nTo: ${STATE.emailDrafts[draftId].to}\nSubject: ${STATE.emailDrafts[draftId].subject}\n\n${reply}\n\n✅ Send "confirm ${draftId}" to send\n✏️ Or type your own reply`);
  }
  
  else if (cmd.includes('draft') || cmd.includes('email to')) {
    await sendTelegram(chatId, '📧 *Draft Email*\n\nFormat:\n"Send email to john@example.com about Project Update: Hi John, wanted to update you on..."');
  }
  
  else if (text.match(/send email to (.+?) about (.+?): (.+)/i)) {
    const match = text.match(/send email to (.+?) about (.+?): (.+)/i);
    const to = match[1].trim();
    const subject = match[2].trim();
    const body = match[3].trim();
    const draftId = `draft_${Date.now()}`;
    STATE.emailDrafts[draftId] = { to, subject, body, threadId: null };
    await sendTelegram(chatId, `📝 *Draft Email:*\n\nTo: ${to}\nSubject: ${subject}\n\n${body}\n\n✅ Send "confirm ${draftId}" to send`);
  }
  
  else if (cmd.match(/confirm\s+(draft_\d+)/)) {
    const draftId = cmd.match(/confirm\s+(draft_\d+)/)[1];
    const draft = STATE.emailDrafts[draftId];
    if (!draft) {
      await sendTelegram(chatId, '❌ Draft not found or expired.');
      return;
    }
    const sent = await sendEmail(draft.to, draft.subject, draft.body, draft.threadId);
    if (sent) {
      await sendTelegram(chatId, `✅ Email sent to ${draft.to}!`);
      delete STATE.emailDrafts[draftId];
    } else {
      await sendTelegram(chatId, '❌ Failed to send email. Please try again.');
    }
  }
  
  else if (cmd.includes('today')) {
    const meetings = await getTodaysMeetings();
    if (meetings.length === 0) {
      await sendTelegram(chatId, '📅 No meetings today!');
      return;
    }
    let list = '';
    meetings.forEach(m => {
      list += `• *${m.time}* - ${m.summary}\n`;
    });
    await sendTelegram(chatId, `📅 *Today (${meetings.length}):*\n\n${list}`);
  }
  
  else if (cmd.includes('upcoming') || cmd.includes('this week')) {
    const meetings = await getUpcomingMeetings(7);
    if (meetings.length === 0) {
      await sendTelegram(chatId, '📅 No upcoming meetings this week!');
      return;
    }
    // Group by day
    const byDay = {};
    meetings.forEach(m => {
      const day = m.start.substring(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(m);
    });
    let list = '';
    Object.keys(byDay).sort().forEach(day => {
      const date = new Date(day);
      const dayName = date.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
      list += `\n*${dayName}:*\n`;
      byDay[day].forEach(m => list += `  • ${m.time} - ${m.summary}\n`);
    });
    await sendTelegram(chatId, `📅 *This Week (${meetings.length}):*${list}`);
  }
  
  else if (cmd.includes('schedule') || cmd.includes('book meeting')) {
    await sendTelegram(chatId, '📅 *Schedule Meeting*\n\nFormat:\n"Schedule meeting with john@example.com tomorrow 6pm: Project sync"\n\nOr:\n"Book meeting with alice@corp.com on Friday 3pm for 30 minutes: Budget review"');
  }
  
  else if (text.match(/schedule meeting with (.+?) (tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d+)(am|pm): (.+)/i)) {
    const match = text.match(/schedule meeting with (.+?) (tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d+)(am|pm): (.+)/i);
    if (!match) {
      await sendTelegram(chatId, '❌ Format: "Schedule meeting with john@example.com tomorrow 6pm: Project sync"');
      return;
    }
    const attendee = match[1].trim();
    const day = match[2].trim();
    const hour = parseInt(match[3]);
    const meridiem = match[4].toLowerCase();
    const title = match[5].trim();
    const now = new Date();
    let targetDate = new Date();
    if (day === 'tomorrow') {
      targetDate.setDate(now.getDate() + 1);
    }
    let hourValue = hour;
    if (meridiem === 'pm' && hour !== 12) hourValue += 12;
    if (meridiem === 'am' && hour === 12) hourValue = 0;
    targetDate.setHours(hourValue, 0, 0, 0);
    const draftId = `meeting_${Date.now()}`;
    STATE.meetingDrafts[draftId] = {
      title,
      attendees: [attendee],
      start: targetDate.toISOString(),
      duration: 60
    };
    await sendTelegram(chatId, `📅 *Meeting Draft:*\n\n*${title}*\nWith: ${attendee}\nWhen: ${targetDate.toLocaleString('en-GB')}\nDuration: 60 minutes\n\n✅ Confirm with "confirm ${draftId}"`);
  }
  
  else if (cmd.match(/confirm\s+(meeting_\d+)/)) {
    const draftId = cmd.match(/confirm\s+(meeting_\d+)/)[1];
    const draft = STATE.meetingDrafts[draftId];
    if (!draft) {
      await sendTelegram(chatId, '❌ Meeting draft not found.');
      return;
    }
    const event = await createMeeting(draft.title, draft.attendees, draft.start, draft.duration);
    if (event) {
      await sendTelegram(chatId, `✅ Meeting scheduled!\n\n*${draft.title}*\n${new Date(draft.start).toLocaleString('en-GB')}\n\nInvites sent to:\n• ${draft.attendees.join('\n• ')}\n• ${EMAILS.pa}\n• ${EMAILS.primary}\n• ${EMAILS.secondary}`);
      delete STATE.meetingDrafts[draftId];
    } else {
      await sendTelegram(chatId, '❌ Failed to create meeting.');
    }
  }
  
  else if (cmd.includes('help')) {
    await sendTelegram(chatId, `👋 *I'm Sonia, your assistant.*\n\n📧 *Email:*\n• "show inbox" - List unread emails\n• "reply 1" - Draft reply to email #1\n• "mark as read 1,2,3" - Mark emails as read\n• "send email to john@example.com about Meeting: Hi John..."\n\n📅 *Calendar:*\n• "today" - Today's meetings\n• "upcoming" / "this week" - Next 7 days\n• "schedule meeting with john@example.com tomorrow 6pm: Project sync"\n\n✅ Confirmations required before sending/scheduling`);
  }
  
  else {
    await sendTelegram(chatId, '👋 Hi! Try:\n• "show inbox"\n• "today"\n• "help"');
  }
}

const app = express();
app.use(express.json());

app.post('/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body.message;
    if (msg && msg.text) {
      console.log(`[${new Date().toISOString()}] ${msg.from.first_name}: ${msg.text}`);
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
app.listen(PORT, () => console.log(`✅ Sonia running on port ${PORT}`));
