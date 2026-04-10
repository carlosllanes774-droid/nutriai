import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/api/ai", async (req, res) => {
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
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});