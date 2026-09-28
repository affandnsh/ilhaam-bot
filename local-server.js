// Runs api/webhook.js as a normal always-on server (local, Render, Railway...).
// Not used by Vercel.
import dotenv from "dotenv";
import express from "express";

// Load .env.local first (local dev), then .env. On Render/Railway the
// platform provides real env vars, so missing files are simply ignored.
dotenv.config({ path: ".env.local" });
dotenv.config();

// webhook.js reads process.env when it is first imported, so import it
// AFTER dotenv has loaded (static imports would run before dotenv.config).
const { default: handler } = await import("./api/webhook.js");

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("Ilhaam bot is running"));

app.all("/api/webhook", (req, res) => {
  handler(req, res).catch((err) => {
    console.error("Unhandled error in handler:", err);
    if (!res.headersSent) res.status(500).send("Internal Server Error");
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} -> /api/webhook`);
});
