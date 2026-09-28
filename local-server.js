// Local-only dev server. Runs api/webhook.js without needing a Vercel
// account, login, or project link. Not used in production.
import "dotenv/config";
import express from "express";
import handler from "./api/webhook.js";

const app = express();
app.use(express.json());

// Vercel passes req/res objects with .status().send() etc. Express's
// req/res already support that shape, so we can call the handler directly.
app.all("/api/webhook", (req, res) => {
  handler(req, res).catch((err) => {
    console.error("Unhandled error in handler:", err);
    if (!res.headersSent) res.status(500).send("Internal Server Error");
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `Local webhook server running at http://localhost:${PORT}/api/webhook`,
  );
});
