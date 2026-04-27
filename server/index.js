require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const OpenAI = require('openai');

const port = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

let twilioClient = null;
let openai = null;

// Initialize Twilio with error handling
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } catch (err) {
    console.error('Twilio initialization error:', err.message);
  }
}

// Initialize OpenAI with error handling
if (process.env.OPENAI_API_KEY) {
  try {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (err) {
    console.error('OpenAI initialization error:', err.message);
  }
}

if (!supabase) {
  console.warn('Warning: Supabase is not configured. Set SUPABASE_URL and SUPABASE_KEY in environment or .env file.');
}

if (!twilioClient) {
  console.warn('Warning: Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in environment or .env file.');
}

if (!openai) {
  console.warn('Warning: OpenAI is not configured. Set OPENAI_API_KEY in environment or .env file.');
}

async function saveDealToSupabase(deal) {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await supabase
    .from('deals')
    .insert([{ ...deal, created_at: new Date().toISOString() }])
    .select();

  if (error) {
    throw error;
  }

  return data?.[0] || null;
}

async function validateSupabaseConnection() {
  if (!supabase) return false;

  try {
    // Test connection by checking if we can access the deals table
    const { error } = await supabase
      .from('deals')
      .select('id')
      .limit(1);

    return !error;
  } catch (err) {
    console.error('Supabase connection validation failed:', err.message);
    return false;
  }
}

async function generateReply(message) {
  if (!openai) {
    throw new Error('OpenAI not configured');
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are a real estate investor texting a homeowner in pre-foreclosure.

Your job:
- Be natural, human, and short (max 2 sentences)
- Build trust quickly
- Move conversation toward selling

Decision logic:
- If seller shows interest → ask price
- If unsure → ask motivation
- If negative → politely disengage

IMPORTANT:
You must classify the lead AND respond.

Return your answer ONLY in this JSON format:

{
  "reply": "your message to the seller",
  "intent": "HOT | WARM | COLD"
}

Definitions:
- HOT = ready to sell or discussing price/timeline
- WARM = maybe interested, unsure
- COLD = not interested or rejecting
`
      },
      {
        role: "user",
        content: message
      }
    ]
  });

  return JSON.parse(response.choices[0].message.content);
}

async function saveSMSConversation(from, to, message, intent, response) {
  if (!supabase) {
    console.warn('Supabase not configured, skipping SMS save');
    return;
  }

  try {
    const { error } = await supabase
      .from('sms_conversations')
      .insert([{
        from_number: from,
        to_number: to,
        incoming_message: message,
        intent_classification: intent.intent,
        confidence: intent.confidence,
        ai_response: response,
        created_at: new Date().toISOString()
      }]);

    if (error) {
      console.error('Error saving SMS conversation:', error);
    }
  } catch (err) {
    console.error('Failed to save SMS conversation:', err);
  }
}

const publicFiles = {
  '/': 'foreclosure_os_v2.html',
  '/setup': 'foreclosure_os_setup_guide.html'
};

const server = http.createServer((req, res) => {
  const requestedPath = req.url.split('?')[0];

  if (req.method === 'POST' && requestedPath === '/api/sms/webhook') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        // Parse Twilio webhook data
        const params = new URLSearchParams(body);
        const from = params.get('From');
        const to = params.get('To');
        const message = params.get('Body');

        if (!from || !message) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          return res.end('Missing required parameters');
        }

        console.log(`Received SMS from ${from}: ${message}`);

        // Generate AI reply and classify intent in one call
        const ai = await generateReply(message);
        const aiResponse = ai.reply;
        const intent = { intent: ai.intent, confidence: 100, reasoning: 'AI generated reply and classification' };
        console.log(`Classified as ${intent.intent} - AI response: ${aiResponse}`);

        // Update leads table with reply status
        if (supabase) {
          await supabase
            .from('leads')
            .update({
              status: ai.intent,
              replied: true
            })
            .eq('phone', from);
        }

        // 🔥 HOT LEAD ALERT
        if (ai.intent === "HOT") {
          console.log("🔥 HOT LEAD:", from);
          // Notify YOU immediately
        }

        if (ai.intent === "WARM") {
          // Keep in follow-up system
          console.log("WARM LEAD - Schedule follow-up:", from);
        }

        if (ai.intent === "COLD") {
          // Stop follow-ups
          console.log("COLD LEAD - Stop follow-ups:", from);
        }

        // Save conversation to database
        await saveSMSConversation(from, to, message, intent, aiResponse);

        // Send response back to Twilio
        const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${aiResponse}</Message></Response>`;
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(twiml);

      } catch (error) {
        console.error('SMS webhook error:', error);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, there was an error processing your message.</Message></Response>`;
        res.writeHead(500, { 'Content-Type': 'text/xml' });
        res.end(twiml);
      }
    });

    return;
  }

  if (req.method === 'POST' && requestedPath === '/api/deals/ingest') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        const requiredFields = ['address', 'arv', 'repairs', 'debt', 'rent', 'days_to_sale'];
        const missing = requiredFields.filter(field => !(field in data));

        if (missing.length) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'Missing fields', missing }));
        }

        const savedDeal = await saveDealToSupabase(data);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          message: 'Deal ingested successfully',
          deal: savedDeal || data
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: error.message || 'Unable to ingest deal' }));
      }
    });

    return;
  }

  const fileName = publicFiles[requestedPath] || publicFiles['/'];
  const filePath = path.join(__dirname, '..', fileName);

  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
});

server.listen(port, async () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log('Available routes: /, /setup, POST /api/deals/ingest, POST /api/sms/webhook');

  const isSupabaseValid = await validateSupabaseConnection();
  console.log(`Supabase configured: ${supabase ? 'yes' : 'no'}`);
  console.log(`Supabase connection valid: ${isSupabaseValid ? 'yes' : 'no'}`);
  console.log(`Twilio configured: ${twilioClient ? 'yes' : 'no'}`);
  console.log(`OpenAI configured: ${openai ? 'yes' : 'no'}`);

  if (supabase && !isSupabaseValid) {
    console.warn('Warning: Supabase credentials are set but connection failed. Check your URL, key, and ensure the "deals" and "sms_conversations" tables exist.');
  }
});
