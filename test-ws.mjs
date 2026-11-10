import fetch from "node-fetch";
import WebSocket from "ws";

const API = "http://localhost:4000";

async function run() {
  console.log("Signing up...");
  const signup = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `ws-test-${Date.now()}@example.com`, passcode: "test" })
  }).then(r => r.json());
  
  const token = signup.token;

  console.log("Creating session...");
  const sessionResp = await fetch(`${API}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ role: "Engineer" })
  }).then(r => r.json());
  
  const sessionId = sessionResp.session_id;

  console.log("Advancing to QUESTION_LOOP...");
  await fetch(`${API}/sessions/${sessionId}/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ to: "CONFIG" })
  });
  await fetch(`${API}/sessions/${sessionId}/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ to: "TELEMETRY_CHECK" })
  });
  await fetch(`${API}/sessions/${sessionId}/begin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }
  });

  console.log("Connecting WS...");
  const ws = new WebSocket(`ws://localhost:4000/sessions/${sessionId}/live?token=${token}`);
  
  ws.on("open", () => {
    console.log("WS Opened! Sending next_question...");
    ws.send(JSON.stringify({ type: "next_question" }));
  });

  ws.on("message", (data) => {
    console.log("WS Received:", JSON.parse(data.toString()));
    ws.close();
  });

  ws.on("error", (err) => {
    console.error("WS Error:", err);
  });
  
  ws.on("close", () => {
    console.log("WS Closed.");
  });
}

run().catch(console.error);
