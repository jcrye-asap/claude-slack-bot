const express = require("express");
const app = express();
app.use(express.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;   // xoxb-...
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // sk-ant-...
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// Keep track of processed event IDs to avoid duplicate responses
const processedEvents = new Set();

// Conversation history per channel (so Claude remembers context)
const conversationHistory = {};

app.post("/slack/events", async (req, res) => {
  const { type, challenge, event } = req.body;

  // Slack URL verification
  if (type === "url_verification") {
    return res.json({ challenge });
  }

  // Acknowledge Slack immediately (required within 3 seconds)
  res.sendStatus(200);

  // Only handle app_mention events
  if (!event || event.type !== "app_mention") return;

  // Avoid processing duplicate events
  if (processedEvents.has(event.event_ts)) return;
  processedEvents.add(event.event_ts);
  setTimeout(() => processedEvents.delete(event.event_ts), 60000);

  const channel = event.channel;
  const userMessage = event.text.replace(/<@[A-Z0-9]+>/g, "").trim(); // Strip the @mention

  try {
    // Build conversation history for this channel
    if (!conversationHistory[channel]) {
      conversationHistory[channel] = [];
    }

    conversationHistory[channel].push({
      role: "user",
      content: userMessage,
    });

    // Keep history to last 20 messages to avoid token limits
    if (conversationHistory[channel].length > 20) {
      conversationHistory[channel] = conversationHistory[channel].slice(-20);
    }

    // Call Claude API
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: `You are a helpful assistant for an HVAC company. You help technicians, dispatchers, 
and office staff with questions about HVAC systems, job scheduling, customer follow-ups, 
billing, and general company operations. Be concise and practical in your responses. 
When answering technical HVAC questions, be specific and helpful. 
Format responses clearly for Slack — use short paragraphs, and bullet points where helpful.
Today's date is ${new Date().toLocaleDateString()}.`,
        messages: conversationHistory[channel],
      }),
    });

    const data = await anthropicRes.json();
    const reply = data.content?.[0]?.text || "Sorry, I couldn't generate a response.";

    // Add Claude's response to history
    conversationHistory[channel].push({
      role: "assistant",
      content: reply,
    });

    // Post reply back to Slack
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel,
        text: reply,
        // Reply in thread if the mention was in a thread
        ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      }),
    });
  } catch (err) {
    console.error("Error:", err);

    // Notify Slack of error
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel,
        text: "Sorry, I ran into an error. Please try again.",
      }),
    });
  }
});

// Health check endpoint
app.get("/", (req, res) => res.send("Claude Slack Bot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
