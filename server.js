const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

const app = express();

// 🔥 CORS (FIXED PROPERLY)
const corsOptions = {
  origin: [
    "https://carlosllanes774-droid.github.io",
    "https://nutriai-qevt.onrender.com"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // handle preflight

// 🔥 MIDDLEWARE
app.use(express.json());
app.use(express.static('.'));

// 🔥 ROOT ROUTE (optional)
app.get('/', (req, res) => {
  res.sendFile(process.cwd() + '/index.html');
});

// 🔥 OPENAI SETUP
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🔥 AI ENDPOINT
app.post("/api/ai", async (req, res) => {
  console.log("Incoming request:", req.body); // debug log

  try {
    const messages =
      req.body.messages && req.body.messages.length > 0
        ? req.body.messages
        : [
            {
              role: "user",
              content: req.body.userMsg || "Give me a healthy recipe",
            },
          ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
    });

    res.json({
      content: [
        {
          type: "text",
          text: completion.choices[0].message.content,
        },
      ],
    });

  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 🔥 START SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
