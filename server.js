const express = require("express");
const axios = require("axios");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3000/callback";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

  if (userMessage && GEMINI_API_KEY) {
    session.chatHistory.push({ role: "user", parts: [{ text: userMessage }] });

    try {
      // De exacte, officiële opbouw van tools voor de Gemini REST API
      const toolsConfig = [
        {
          functionDeclarations: [
            {
              name: "getRecentActivities",
              description: "Haalt een lijst op van de meest recente sportactiviteiten van de atleet inclusief afstanden, tijden en hartslagdata.",
              parameters: {
                type: "OBJECT",
                properties: {
                  limit: { 
                    type: "INTEGER", 
                    description: "Het aantal activiteiten dat opgehaald moet worden (bijv. 5)." 
                  }
                },
                required: []
              }
            }
          ]
        }
      ];

      // Eerste aanroep naar Gemini
      let geminiCall = await axios.post(
        `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: [
            {
              role: "user",
              parts: [{ text: "Je bent een deskundige AI-sportcoach, gespecialiseerd in inspanningsfysiologie, trainingszones (duur vs intensief) en herstel. Je helpt een ambitieuze duursportatleet/triatleet. Je hebt via tools toegang tot de echte Strava-data van de atleet. Geef serieuze, diepgaande en wetenschappelijk onderbouwde antwoorden. Gebruik NOOIT grapjes of excuses." }]
            },
            ...session.chatHistory
          ],
          tools: toolsConfig
        }
      );

      let candidate = geminiCall.data.candidates[0];
      
      let functionCall = null;
      if (candidate.content && candidate.content.parts) {
        functionCall = candidate.content.parts.find(p => p.functionCall);
      }

      // Als Gemini de tool aanroept
      if (functionCall && functionCall.name === "getRecentActivities") {
        const limit = functionCall.args.limit || 5;
        
        const stravaRes = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
          headers: { Authorization: `Bearer ${session.accessToken}` },
          params: { per_page: limit }
        });

        const formattedData = formatActivitiesForAI(stravaRes.data);

        // Tweede aanroep naar Gemini met het resultaat van de functie
        let geminiFinalCall = await axios.post(
          `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            contents: [
              {
                role: "user",
                parts: [{ text: "Je bent een deskundige AI-sportcoach, gespecialiseerd in inspanningsfysiologie, trainingszones (duur vs intensief) en herstel. Je helpt een ambitieuze duursportatleet/triatleet. Je hebt via tools toegang tot de echte Strava-data van de atleet. Geef serieuze, diepgaande en wetenschappelijk onderbouwde antwoorden. Gebruik NOOIT grapjes of excuses." }]
              },
              ...session.chatHistory,
              candidate.content, 
              {
                role: "user",
                parts: [{
                  functionResponse: {
                    name: "getRecentActivities",
                    response: { 
                      name: "getRecentActivities",
                      content: { data: formattedData } 
                    }
                  }
                }]
              }
            ],
            tools: toolsConfig
          }
        );

        aiResponseText = geminiFinalCall.data.candidates[0].content.parts[0].text;
      } else {
        aiResponseText = candidate.content.parts[0].text;
      }

      session.chatHistory
