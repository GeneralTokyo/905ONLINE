# AI Voice Agent, Vapi-only version (no Twilio needed)

Use this version when you don't have a paid Twilio account. A **free Vapi phone number** answers the call, n8n decides how the AI behaves, and Vapi transfers the caller to a real person.

| | Twilio version (`n8n_workflow_template.json`) | Vapi-only version (`n8n_workflow_vapi_only.json`) |
| --- | --- | --- |
| Phone number | Your own Twilio number (paid) | Free Vapi number (US area codes) |
| "Press 1 / Press 2" | Twilio keypad menu | Keypad **or** voice ("support" / "sales"), handled by the AI |
| Transfer to a human | n8n redirects the Twilio call | Vapi's built-in transfer, with a spoken summary for the human |
| Environment variables | Required | **None.** Everything is in the **Settings** node, so it also works on n8n Cloud |

## How it works

```
Caller ──► free Vapi number ──► POST /webhook/vapi-server (n8n)
                                   │
   [Vapi Server URL] ─► [Settings] ─► [Authorized?] ─► [Route Vapi Event]
                                                         ├─ assistant-request  ─► [Build Vapi Assistant] ─► [Return Assistant to Vapi]
                                                         ├─ transfer-update    ─► [Acknowledge] ─► [Transfer Details]
                                                         ├─ end-of-call-report ─► [Acknowledge] ─► [Call Report]
                                                         └─ anything else      ─► [Acknowledge Other Event]
```

1. **The phone rings.** Vapi asks n8n which assistant should answer (`assistant-request`). n8n replies with an AI receptionist built from the **Settings** node: greeting, prompt, voice (ElevenLabs), brain (GPT-4o-mini), ears (Deepgram), and keypad input turned on.
2. **The caller chooses.** The greeting says "press 1 or say support, press 2 or say sales". Either works.
3. **The caller asks for a person**, or an escalation rule is met. The AI uses Vapi's `transferCall` tool to dial your support or sales number. By default (`warm-transfer-say-summary`), Vapi dials the human first, tells them what the call is about, and then connects the caller. n8n logs the transfer.
4. **The call ends.** Vapi sends the summary, transcript, recording link and cost to n8n (**Call Report**). Connect a Google Sheet, CRM or email node after it to keep a record.

## Setup (about 10 minutes)

### 1. Import and fill in Settings (n8n)
1. In n8n, click **⋯ → Import from File** and choose `n8n_workflow_vapi_only.json`.
2. Double-click **Settings** and fill in:

   | Field | What to put |
   | --- | --- |
   | `companyName` | Your or your client's business name |
   | `agentName` / `voiceId` | The name the AI uses and an ElevenLabs voice (`sarah`, `paula`, `mark`, `steve`…) |
   | `supportNumber` | The phone that should ring for support, in international format, e.g. `+12896593559` |
   | `salesNumber` | The phone for sales. It can be the same number. Use a phone you **won't** be calling from during tests. |
   | `transferMode` | Leave as `warm-transfer-say-summary`. Use `blind-transfer` if transfers fail (see Troubleshooting). |
   | `serverSecret` | Optional but recommended: any long random text, e.g. `k8Yt2pQx9…` |
   | `greeting`, `supportPlaybook`, `salesPlaybook` | Edit freely. `{company}` and `{agent}` are filled in automatically. |

   If both numbers are left empty, the AI takes a message instead of transferring.
3. Click **Save**, then turn the workflow **Active** (or **Publish**).
4. Double-click **Vapi Server URL** → **Production URL** → copy it. If you set a `serverSecret`, add `?key=` and the secret to the end:
   ```
   https://YOUR-N8N/webhook/vapi-server?key=k8Yt2pQx9…
   ```
   The address must be public `https://`. A `localhost` URL won't work, so use n8n Cloud or `ngrok http 5678`.

### 2. Get a free number and point it at n8n (Vapi)
1. In [dashboard.vapi.ai](https://dashboard.vapi.ai), go to **Phone Numbers → Create Phone Number → Free Vapi Number**, pick an area code, and create it.
2. Open the new number:
   - **Assistant:** leave it **empty**. n8n supplies the assistant on every call.
   - **Server URL:** paste the URL from step 1.4.
   - **Fallback Destination** (if offered): your own phone number, so callers still reach someone if n8n is ever down.
3. Save.

### 3. Test
Call the Vapi number. You should hear the greeting. Press **1**, ask a question, then say *"can you put me through to a real person?"* Your support phone rings, the AI tells whoever answers what the call is about, and then the caller is connected. In n8n's **Executions** tab you'll see a run for the start of the call, the transfer, and the end-of-call report.

## Things to know about free Vapi numbers
- **Free numbers have limits.** They're US numbers, Vapi restricts international calling from them, and they have daily call caps. Your transfer number is Canadian (+1 289…), so **test the transfer early**. If it fails, look at the call's *Ended Reason* in Vapi → **Call Logs**. Using a US transfer number, or importing a paid number later, removes the restriction.
- **Warm transfers depend on Vapi's telephony.** If the transfer never connects, set `transferMode` to `blind-transfer`. The caller is put straight through without the spoken briefing.
- **Usage costs credit.** Each call uses Vapi credit for the AI, the voice and the speech recognition. New accounts include free credit.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Call connects to silence or hangs up immediately | Vapi didn't get an assistant. Check the workflow is **Active**, the Server URL is the **Production** URL, and `?key=` matches `serverSecret`. In n8n **Executions**, a run that ends at *Reject Unauthorized* means the key is wrong. |
| No run appears in n8n | Vapi isn't reaching n8n. The URL is not public, has a typo, or the number has an assistant assigned (remove it). |
| Pressing 1 or 2 does nothing | Wait about 2 seconds after pressing; the AI processes keypad input after a short pause. Saying "support" or "sales" always works. |
| AI says it's transferring but nothing happens | Check `supportNumber`/`salesNumber` start with `+` and a country code. Try `transferMode` = `blind-transfer`. Check the free-number limits above. |

## Demo script (portfolio video)
1. **Canvas (45 s):** show the four branches. *"Vapi is the voice, n8n is the brain that decides who answers, how they behave, and where calls go. Swap the Settings node and it's a new client."*
2. **Keypad (30 s):** call on speakerphone and press 1. Show **Executions**: the `assistant-request` run lights up *Build Vapi Assistant → Return Assistant to Vapi*.
3. **Barge-in (60 s):** ask a question, then interrupt the AI mid-sentence. It stops and adapts.
4. **Hand-off (45 s):** *"Patch me through to a real person please."* The second phone rings on camera, the human hears the summary, and you're connected. Show the *Transfer Details* run and, after hanging up, the *Call Report* with the AI-written summary.

## Testing
`tests/e2e_vapi_only.js` posts the same events Vapi sends to a real n8n instance. It checks the assistant JSON (field names validated against `@vapi-ai/server-sdk`), the transfer destinations, E.164 cleanup, the secret check (query string and header), the no-numbers fallback, and the event acknowledgements. Both configurations pass, with every n8n execution successful, and n8n's environment-variable access left blocked.
