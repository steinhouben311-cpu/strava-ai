const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3000/callback";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialiseer de officiële Google Gen AI SDK
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const sessionStore = {};

function formatActivitiesForAI(activities) {
  return activities.map(act => ({
    id: act.id,
    name: act.name,
    type: act.type,
    distance_km: (act.distance / 1000).toFixed(2),
    duration_min: Math.round(act.moving_time / 60),
    avg_speed_or_pace: act.type === "Run" 
      ? `${(Math.round(act.moving_time / 60) / (act.distance / 1000)).toFixed(2)} min/km` 
      : `${(act.average_speed * 3.6).toFixed(1)} km/u`,
    avg_heartrate: act.has_heartrate ? `${Math.round(act.average_heartrate)} bpm` : "N/A",
    max_heartrate: act.has_heartrate ? `${Math.round(act.max_heartrate)} bpm` : "N/A",
    elevation_gain_m: act.total_elevation_gain || 0,
    start_date: act.start_date_local
  }));
}

app.get("/", (req, res) => {
  res.send("🚀 Strava AI Sportcoach Backend werkt! Ga naar /auth om te beginnen.");
});

app.get("/auth", (req, res) => {
  const url = `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${REDIRECT_URI}&approval_prompt=force&scope=activity:read_all`;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const tokenResponse = await axios.post("https://www.strava.com/oauth/token", null, {
      params: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code" }
    });
    const accessToken = tokenResponse.data.access_token;

    const sessionId = "session_" + Date.now();
    sessionStore[sessionId] = {
      accessToken: accessToken,
      chatHistory: []
    };

    res.redirect(`/chat?sessionId=${sessionId}`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Inloggen bij Strava mislukt.");
  }
});

app.all("/chat", async (req, res) => {
  const sessionId = req.query.sessionId || req.body.sessionId;
  const userMessage = req.body.message;
  const session = sessionStore[sessionId];

  if (!session) {
    return res.send("Sessie verlopen of niet gevonden. Ga aub terug naar /auth");
  }

  let aiResponseText = "Stel je vraag aan de AI Coach over je trainingen, intensiteit, zones of herstel!";

  if (userMessage) {
    // Voeg het bericht van de gebruiker toe aan de lokale geschiedenis voor de UI
    session.chatHistory.push({ role: "user", text: userMessage });

    try {
      // Definieer de Strava-tool volgens de SDK-standaard
      const stravaTool = {
        functionDeclarations: [{
          name: "getRecentActivities",
          description: "Haalt een lijst op van de meest recente sportactiviteiten van de atleet inclusief afstanden, tijden en hartslagdata.",
          parameters: {
            type: "OBJECT",
            properties: {
              limit: { 
                type: "INTEGER", 
                description: "Het aantal activiteiten dat opgehaald moet worden (bijv. 5)." 
              }
            }
          }
        }]
      };

      // Roep Gemini aan via de officiële SDK
      const response = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: [
          "Je bent een deskundige AI-sportcoach, gespecialiseerd in inspanningsfysiologie, trainingszones (duur vs intensief) en herstel. Je helpt een ambitieuze duursportatleet/triatleet. Je hebt via tools toegang tot de echte Strava-data van de atleet. Geef serieuze, diepgaande en wetenschappelijk onderbouwde antwoorden. Gebruik NOOIT grapjes of excuses.",
          userMessage
        ],
        config: {
          tools: [stravaTool]
        }
      });

      // Controleer of Gemini de tool wil aanroepen
      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        
        if (call.name === "getRecentActivities") {
          const limit = call.args.limit || 5;
          
          // Haal de echte data op bij Strava
          const stravaRes = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            params: { per_page: limit }
          });

          const formattedData = formatActivitiesForAI(stravaRes.data);

          // Stuur de verzamelde data via de SDK terug naar Gemini voor de definitieve analyse
          const finalResponse = await ai.models.generateContent({
            model: "gemini-1.5-flash",
            contents: [
              "Je bent een deskundige AI-sportcoach, gespecialiseerd in inspanningsfysiologie, trainingszones (duur vs intensief) en herstel. Je helpt een ambitieuze duursportatleet/triatleet. Je hebt via tools toegang tot de echte Strava-data van de atleet. Geef serieuze, diepgaande en wetenschappelijk onderbouwde antwoorden. Gebruik NOOIT grapjes of excuses.",
              userMessage,
              response.candidates[0].content, // De oorspronkelijke function call context
              {
                role: "user",
                parts: [{
                  functionResponse: {
                    name: "getRecentActivities",
                    response: { data: formattedData }
                  }
                }]
              }
            ]
          });

          aiResponseText = finalResponse.text;
        }
      } else {
        // Als Gemini direct antwoord geeft zonder data nodig te hebben
        aiResponseText = response.text;
      }

      // Sla het antwoord van de coach op in de geschiedenis voor de UI
      session.chatHistory.push({ role: "model", text: aiResponseText });

    } catch (err) {
      console.error("Gemini SDK Error:", err);
      aiResponseText = "De AI-coach kon de data momenteel niet verwerken via de beveiligde SDK-verbinding.";
    }
  }

  let chatBubbles = session.chatHistory.map(msg => {
    let roleName = msg.role === "user" ? "Jij" : "AI Coach";
    let bgColor = msg.role === "user" ? "#e1ffc7" : "#f1f0f0";
    let align = msg.role === "user" ? "flex-end" : "flex-start";
    return `<div style="background: ${bgColor}; align-self: ${align}; padding: 12px 16px; border-radius: 12px; max-width: 80%; margin-bottom: 10px; line-height: 1.4; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
              <strong>${roleName}:</strong><br>${msg.text.replace(/\n/g, "<br>")}
            </div>`;
  }).join("");

  res.send(`
    <style>
      body { font-family: 'Segoe UI', Arial, sans-serif; background: #eaeaea; margin: 0; padding: 20px; display: flex; justify-content: center; }
      .chat-container { width: 100%; max-width: 750px; background: white; height: 88vh; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); display: flex; flex-direction: column; overflow: hidden; }
      .header { background: #fc4c02; color: white; padding: 20px; font-size: 1.3em; font-weight: bold; text-align: center; letter-spacing: 0.5px; }
      .messages-box { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; background: #fafafa; }
      .form-box { padding: 20px; background: white; border-top: 1px solid #ddd; display: flex; gap: 10px; }
      .input-text { flex: 1; padding: 14px; border: 1px solid #ccc; border-radius: 8px; font-size: 1em; }
      .input-text:focus { outline: none; border-color: #fc4c02; }
      .btn { background: #fc4c02; color: white; border: none; padding: 0 25px; font-size: 1em; border-radius: 8px; cursor: pointer; font-weight: bold; transition: background 0.2s; }
      .btn:hover { background: #e24301; }
    </style>

    <div class="chat-container">
      <div class="header">🤖 Gemini High-Performance Sport Coach</div>
      <div class="messages-box">
        ${chatBubbles || `<div style="color: #888; text-align: center; margin-top: 50px; font-size: 1.05em; line-height: 1.5;">Stel een vraag om de coach toegang te geven tot je Strava-data.<br><br><span style="font-size: 0.9em; background: #eee; padding: 8px 12px; border-radius: 20px; color: #555;">Probeer: "Analyseer de intensiteit van mijn laatste 3 trainingen"</span></div>`}
      </div>
      <form action="/chat" method="POST" class="form-box">
        <input type="hidden" name="sessionId" value="${sessionId}">
        <input type="text" name="message" class="input-text" placeholder="Vraag over zones, intensiteit, duur of herstel..." required autocomplete="off">
        <button type="submit" class="btn">Verstuur</button>
      </form>
    </div>
    <script>
      const box = document.querySelector('.messages-box');
      box.scrollTop = box.scrollHeight;
    </script>
  `);
});

app.listen(PORT, () => {
  console.log("AI-Assistent server draait via de officiële SDK op poort " + PORT);
});
