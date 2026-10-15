# AI Voice Agent Template: Twilio IVR + Vapi + Live Human Transfer (n8n)

A reusable, client-agnostic n8n workflow for agencies. It answers inbound phone calls, takes a keypad choice (DTMF), starts a humanlike Vapi.ai voice agent for the chosen department, and warm-transfers the caller to a real person when they ask for one or when an escalation rule fires.

| File | What it is |
| --- | --- |
| [`n8n_workflow_template.json`](n8n_workflow_template.json) | The workflow. Import it into n8n (**Workflows → Import from File**). |
| [`tests/`](tests/) | A connectivity checker and an end-to-end test harness with mock Twilio and Vapi APIs (see [Testing](#testing)). |

---

## 1. Architecture overview

```
 Caller ──► Twilio number
              │  POST /webhook/twilio-inbound-call
              ▼
   [Twilio Inbound Call] ──► [TwiML Gather Input]  "Press 1 for Support, 2 for Sales"
                                     │  Twilio posts Digits to /webhook/twilio-dtmf
                                     ▼
   [Twilio DTMF Receiver] ──► [Route Department] ─┬─ 1 ─► [Configure Agent Parameters (Support)] ─┐
                                                  ├─ 2 ─► [Configure Agent Parameters (Sales)] ───┤
                                                  └─ other ─► [TwiML Invalid Option] (replays menu)
                                                                                                  ▼
                                               [Trigger Vapi Inbound Call]  POST api.vapi.ai/call
                                                  │ success                     │ error
                                                  ▼                             │
                                        [Vapi Returned TwiML?] ── no ──►  [Fallback: Dial Human Directly]
                                                  │ yes
                                                  ▼
                                        [Return Vapi Stream TwiML]  <Connect><Stream> → the live call is now in Vapi

   Vapi (GPT-4o-mini + Deepgram + ElevenLabs) talks with the caller. Barge-in is on.
   The caller says "get me a real person", so the AI calls the transfer_to_human tool:

   [Vapi Tool Escalation Endpoint] ─► [Parse Transfer Request] ─► [Transfer Request Valid?]
         ├─ yes ─► [Acknowledge Vapi Tool Call] ─► [Wait For Hold Message] ─► [Execute Twilio Call Transfer]
         │                                                                     (Twilio REST: redirect live call to <Dial>)
         └─ no  ─► [Reject Transfer Request]

   The human answers. Twilio fetches /webhook/transfer-whisper:
   [Transfer Whisper Endpoint] ─► [TwiML Agent Whisper]  "Incoming support transfer. Reason: ..."
```

The four phases:

1. **Inbound call and DTMF capture (Twilio).** n8n answers the call immediately with TwiML that reads the menu and gathers one keypress.
2. **Vapi session start (Vapi.ai).** The keypress selects a department profile: system prompt, greeting, voice, and human fallback number. n8n creates a *transient* Vapi assistant for this call only and bridges the existing Twilio call into it with `phoneCallProviderBypassEnabled`. This is Vapi's documented "bring your own Twilio" pattern; see Vapi's [Call Handling with Vapi and Twilio](https://docs.vapi.ai/calls/call-handling-with-vapi-and-twilio) guide and its [example repo](https://github.com/VapiAI/example-phone-call-provider-bypass).
3. **Conversation runtime (Vapi.ai ↔ LLM).** Vapi handles low-latency voice-to-voice audio: Deepgram `nova-3` speech-to-text, OpenAI `gpt-4o-mini`, and ElevenLabs `eleven_flash_v2_5` text-to-speech, with a `stopSpeakingPlan` tuned for fast barge-in.
4. **Human transfer (Vapi tool → n8n → Twilio).** The AI calls the `transfer_to_human` function tool. n8n acknowledges Vapi, waits for the hold message to finish, then uses the Twilio REST API to replace the live call's TwiML with a `<Dial>` to the human. A whisper briefs the human with the reason before the caller is connected.

### Why the transfer goes through the Twilio REST API

When Vapi is bridged in bypass mode, Twilio owns the call, not Vapi, so Vapi's built-in `transferCall` can't move it. A Respond to Webhook node only answers Vapi's HTTP request; Twilio never sees that reply. So **Execute Twilio Call Transfer** is an HTTP Request node that calls `POST /2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json` with `Twiml=<Response><Dial>…</Dial></Response>`. Twilio drops the Vapi media stream and dials the human on the same call. **Acknowledge Vapi Tool Call** is the Respond to Webhook node that returns the JSON tool result to Vapi.

---

## 2. The n8n workflow

**[`n8n_workflow_template.json`](n8n_workflow_template.json)** is the complete importable workflow: 20 functional nodes plus 3 sticky notes, all wired, with no placeholders in the JSON. Everything client-specific comes from environment variables and two credentials (section 3), so the same file can be reused for every client.

### Node map

| # | Node | Type | Role |
| --- | --- | --- | --- |
| 1 | Twilio Inbound Call | Webhook (POST `twilio-inbound-call`) | Twilio's "A call comes in" hook. |
| 2 | TwiML Gather Input | Respond to Webhook (XML) | `<Gather numDigits="1" action="twilio-dtmf">` with the Polly.Joanna-Neural menu. The relative `action` resolves to the DTMF webhook automatically, so no URL needs pasting. |
| 3 | Twilio DTMF Receiver | Webhook (POST `twilio-dtmf`) | Receives `Digits`, `CallSid`, `From`, `To`, `AccountSid`. |
| 4 | Route Department | Switch | `{{ $json.body.Digits }}`: 1 → Support, 2 → Sales, anything else → Invalid Input. |
| 5 | Configure Agent Parameters (Support / Sales) | Edit Fields (Set) | Per-department prompt, greeting, voice, hold message, human number, plus call identifiers. |
| 6 | Trigger Vapi Inbound Call | HTTP Request | `POST https://api.vapi.ai/call` with a transient assistant, the inline `transfer_to_human` tool, and bypass enabled. If it errors, it routes to the fallback. |
| 7 | Vapi Tool Escalation Endpoint | Webhook (POST `vapi-escalation`) | Vapi's `tool-calls` server URL. |
| 8 | Acknowledge Vapi Tool Call → Wait For Hold Message → **Execute Twilio Call Transfer** | Respond to Webhook → Wait → HTTP Request | Returns `{"results":[{"toolCallId", "result"}]}` to Vapi, waits 2 s, then redirects the live Twilio call to `<Dial><Number url="…whisper">`. |

Supporting nodes that keep every path working:

| Node | Why it exists |
| --- | --- |
| TwiML Invalid Option | A wrong key or no key replays the menu (`<Redirect>`) instead of hanging up. |
| Vapi Returned TwiML? / Return Vapi Stream TwiML | Sends Vapi's `phoneCallProviderDetails.twiml` back to Twilio, and guards against an empty response. |
| Fallback: Dial Human Directly | If Vapi is down or rejects the request, the caller goes straight to the department's human instead of hearing an error. |
| Parse Transfer Request / Transfer Request Valid? / Reject Transfer Request | Normalizes the Vapi payload (arguments as a string or an object), checks the optional shared secret, validates the Call SID and E.164 number, and returns a proper tool error otherwise. |
| Transfer Whisper Endpoint / TwiML Agent Whisper | Makes the transfer *warm*: the human hears "Incoming support transfer from the AI assistant. Reason: …" before the caller is connected. |

The AI can also transfer across departments. If a Support caller wants a quote, the AI calls the tool with `department: "sales"` and the call goes to the Sales human.

---

## 3. Setup and configuration blueprint

### 3.0 Prerequisites

* **n8n, self-hosted (Docker/npm) or any instance where you can set environment variables**, reachable over **public HTTPS**, because Twilio and Vapi must reach your webhooks. For local demos, use a tunnel such as `ngrok http 5678` and set `WEBHOOK_URL` to the tunnel URL. The workflow uses standard node versions available in n8n 1.x and 2.x.
* A Twilio account. Upgrade it before recording a demo, because trial accounts play a "press any key" notice and can only dial verified numbers.
* A Vapi.ai account.

### 3.1 Environment variables and credentials

Set these on the **n8n process**, for example in `docker-compose.yml` under `environment:`, then restart n8n.

| Key | Required | Example | Purpose |
| --- | --- | --- | --- |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | **Yes** | `false` | Lets workflow expressions read `$env`. Newer n8n versions block this by default, and the workflow fails without it. |
| `WEBHOOK_URL` | Strongly recommended | `https://n8n.youragency.com/` | Public base URL. Used to build the Vapi tool URL and the whisper URL. If unset, they are derived from the request's `Host` header. |
| `VAPI_PHONE_NUMBER_ID` | **Yes** | `3f1c…` | ID of your Twilio number after importing it into Vapi (3.3). |
| `HUMAN_SUPPORT_NUMBER` | **Yes** | `+14165550111` | Human fallback for route 1, in E.164 format. |
| `HUMAN_SALES_NUMBER` | **Yes** | `+14165550122` | Human fallback for route 2, in E.164 format. |
| `VAPI_TOOL_SECRET` | Recommended | a long random string | Shared secret. n8n sends it to Vapi as the tool's `x-vapi-secret` header and rejects escalation calls that don't carry it, with a 401. |
| `COMPANY_NAME` | Optional | `Acme Plumbing` | Inserted into the greetings and system prompts. Defaults to `Acme Co`. |
| `TWILIO_ACCOUNT_SID` | Optional | `AC…` | Fallback only. Normally the Account SID travels with the call. Needed only if you use a dashboard-defined tool (3.3, option B). |

Create two **n8n credentials** (**Credentials → Add credential**). After importing the workflow, open each HTTP node and select its credential:

| Credential | Type | Fields | Used by |
| --- | --- | --- | --- |
| **Vapi API Key** (`VAPI_API_KEY`) | Header Auth | Name: `Authorization`; Value: `Bearer <your Vapi private API key>` | Trigger Vapi Inbound Call |
| **Twilio account** | Twilio API | Auth type: Auth Token; Account SID; Auth Token | Execute Twilio Call Transfer |

> **n8n Cloud:** env vars can't be set there. Create the same keys under **Settings → Variables** and replace every `$env.` with `$vars.` in the workflow JSON before importing. Variables require a plan that includes them.

### 3.2 Twilio portal configuration

1. **Buy a number:** Console → Phone Numbers → Manage → Buy a number, with Voice capability.
2. **Import the number into Vapi first (3.3, step 3).** Vapi may rewrite the number's voice webhook when you import it, so do the next step after importing.
3. **Point the webhook to n8n:** Phone Numbers → Manage → Active numbers → *your number* → Voice Configuration → **A call comes in** → **Webhook** → `https://<your-n8n>/webhook/twilio-inbound-call`, **HTTP POST** → Save.
4. If your human numbers are in another country, enable it under Voice → Settings → **Geo permissions**.

### 3.3 Vapi.ai dashboard configuration

1. **Create a free developer account** at [dashboard.vapi.ai](https://dashboard.vapi.ai).
2. **API key:** Organization Settings → API Keys → copy the **private** key into the *Vapi API Key* credential as `Bearer <key>`.
3. **Import the Twilio number:** Phone Numbers → Create Phone Number → **Import Twilio** → enter the number, Account SID, and Auth Token. Copy the new phone number's **ID** into `VAPI_PHONE_NUMBER_ID`. You don't need to assign an assistant, because n8n sends one with every call. Now complete Twilio step 3.2.3.
4. **The `transfer_to_human` tool.**
   * **Option A (default, nothing to click):** the workflow defines the tool inline on every call, so each call gets its own escalation URL carrying that call's `callSid`. This is the most reliable setup.
   * **Option B (reusable dashboard tool):** Tools → Create Tool → **Function**. Name it `transfer_to_human`, turn **Async** on, set the Server URL to `https://<your-n8n>/webhook/vapi-escalation`, and add the header `x-vapi-secret: <VAPI_TOOL_SECRET>`. Add a request-start message with "Absolutely. Please hold for a moment while I connect you with a member of our team." and set it to blocking. Paste this strict parameter schema:

     ```json
     {
       "type": "object",
       "properties": {
         "reason": {
           "type": "string",
           "description": "One sentence summarising why the caller needs a human, read aloud to the agent before the call connects."
         },
         "department": {
           "type": "string",
           "enum": ["support", "sales"],
           "description": "Which human team should take the call."
         }
       },
       "required": ["reason", "department"]
     }
     ```

     Then, in **Trigger Vapi Inbound Call**, replace the `tools: [ … ]` array with `toolIds: [ '<your tool id>' ]` and set `TWILIO_ACCOUNT_SID`. The Call SID then comes from the assistant's `metadata.twilioCallSid`, which the workflow already sends.

### 3.4 Go live

1. Import `n8n_workflow_template.json`, select the two credentials, then **Save** and **Activate/Publish** the workflow.
2. Use **production** URLs only (`/webhook/…`). The flow spans four webhooks across a live call, and n8n's "Listen for test event" mode only catches one.
3. Smoke test from a terminal. It should print the Gather TwiML:

   ```bash
   curl -X POST https://<your-n8n>/webhook/twilio-inbound-call -d "CallSid=CAtest&From=%2B15555550100"
   ```

4. Call the number.

### 3.5 Customizing per client

Open the two **Configure Agent Parameters** nodes. Each field is a plain string: `systemPrompt`, `firstMessage`, `voiceId` (ElevenLabs preset or voice-library ID), `transferMessage`, and `assistantName`. To add a department (for example, 3 for Billing), add a Switch rule and a Set node, connect it to *Trigger Vapi Inbound Call*, add the digit to the Gather prompt, and add the value to the tool's `department` enum.

### 3.6 Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Caller hears "An application error has occurred" | The workflow isn't active, the URL is wrong, or `N8N_BLOCK_ENV_ACCESS_IN_NODE` isn't `false`. Check **Executions** in n8n. |
| Caller goes straight to a human after pressing a key | The Vapi request failed, so the fallback ran. Open the execution and inspect *Trigger Vapi Inbound Call*: bad API key, wrong `VAPI_PHONE_NUMBER_ID`, or an anonymous or invalid caller ID. |
| AI says "please hold" but nothing happens | *Execute Twilio Call Transfer* failed: Twilio credential, geo permissions, or an invalid human number. |
| Escalation returns 401 | `VAPI_TOOL_SECRET` doesn't match the header Vapi sends. |
| Human isn't briefed / whisper fails | `WEBHOOK_URL` is missing or wrong, so Twilio can't reach `/webhook/transfer-whisper`. |

**Hardening for production:** keep `VAPI_TOOL_SECRET` set, validate `X-Twilio-Signature` on the Twilio webhooks if your threat model needs it, and tune `maxDurationSeconds` (default 900).

---

## 4. Portfolio demo roadmap (screen recording)

Setup: split screen with n8n on the left (canvas, then the **Executions** tab), and the phone plus the human's phone visible on camera. Record system audio and the speakerphone.

1. **The setup display (≈45 s).** Zoom to fit the canvas. Walk the three colour-coded sections from top to bottom. *"This is the automation layer. Twilio is just the phone line, Vapi is just the voice brain, and n8n owns the routing, the business rules, and the hand-off. Swap a client's prompt, voice, or transfer number in these two nodes and it's a new deployment."* Briefly open a Configure node to show the prompt, and open the fallback path: *"If the AI provider is ever down, callers still reach a human."*
2. **The keypad trigger (≈30 s).** Dial the number on speakerphone. When the menu plays, press **1**. Cut to **Executions**: two runs appear, *TwiML Gather Input* and then the DTMF run lighting up *Route Department → Configure Agent Parameters (Support) → Trigger Vapi Inbound Call → Return Vapi Stream TwiML*. Open it and point to `Digits: "1"` in the webhook output.
3. **The AI conversation and interruption (≈60 s).** Ask a real question, such as *"Hi, I was double charged on my last invoice."* While the agent is mid-sentence, talk over it: *"Sorry, actually it's for my business account."* It stops within a fraction of a second and adapts. That's the `stopSpeakingPlan` barge-in. Mention the stack on screen: Deepgram → GPT-4o-mini → ElevenLabs Flash.
4. **The escalation hand-off (≈45 s).** Say *"Hey, actually patch me through to a real person please."* The agent says the hold line. Cut to Executions, where a new run flows *Vapi Tool Escalation Endpoint → Parse Transfer Request → Acknowledge → Wait → Execute Twilio Call Transfer*. The human's phone rings on camera. Answer it. You hear the whisper, *"Incoming support transfer from the A I assistant. Reason: caller was double charged on an invoice…"*, and then you're connected to the caller. End on the canvas with all executions green.

---

## Testing

`tests/` contains what was used to verify this template before shipping:

* `check_graph.js` is static validation. Every node is reachable from a webhook, every Switch, IF, and error output is wired, every webhook path ends in a Respond to Webhook node, expressions are balanced, and every `$('Node')` reference exists.

  ```bash
  node tests/check_graph.js n8n_workflow_template.json
  ```

* `mock_apis.js`, `prepare_test_workflow.js`, and `e2e.js` form an end-to-end harness. It points a copy of the workflow at local mock Vapi and Twilio APIs, imports it into a real n8n instance, and drives every path the way Twilio and Vapi would: the menu, both departments, invalid and empty input, a Vapi error and an empty Vapi response, transfers with string or object arguments, cross-department transfers, a bad secret, a missing Call SID, and the whisper. It checks the response bodies, the XML well-formedness, the Vapi payload fields (against the field names in `@vapi-ai/server-sdk`), the Twilio auth, and the hold-message delay. See the header of `e2e.js` for the run steps.
