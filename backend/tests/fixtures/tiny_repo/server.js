const express = require("express");
const app = express();

function requireAuth(req, res, next) {
  if (!req.headers.authorization) {
    return res.status(401).json({ error: "missing token" });
  }
  next();
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/orders", requireAuth, (req, res) => {
  res.status(201).json({ id: 1 });
});

module.exports = app;
