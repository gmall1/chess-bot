# chess-bot

Autonomous / guided chess bot that overlays reasoning, arrows, and threat detection on top of a live chess.com game. No Tampermonkey, no extension, no second tab — you paste a single script into the chess.com DevTools console and the bot renders inside the chess.com page itself.

A small FastAPI site (`/server`) gates access behind username + password + invite code so classmates can't just copy it.

---

## Parts

| Folder | What it is |
|---|---|
| `src/chess-bot.js` | Self-contained injection script: alpha-beta engine + DOM adapter + SVG arrow overlay + reasoning panel. |
| `server/` | FastAPI gate: register/login/dashboard, hashed passwords, invite-code required, serves the script only to logged-in users. |
| `test/smoke.mjs` | Node smoke tests for the engine (perft, mate-in-1, threat detection). |

## Engine

- Alpha-beta with iterative deepening
- Quiescence search over captures + promotions
- Move ordering: PV → MVV-LVA captures → killers → history heuristic
- Evaluation: material + piece-square tables + mobility + king safety + bishop-pair + endgame king PST
- **ELO 400–2400 (default 600)**: maps to search depth, time budget, and a softmax "temperature" used to sample among root moves by centipawn loss. Low ELO also adds a small probability of picking a much-worse move (simulates human oversights) so it doesn't feel like a pure randomizer.

Perft validation (`node test/smoke.mjs`): starting-position depth 3 = 8902, Kiwipete depth 2 = 2039.

## Usage (end-to-end)

### 1. Run the gate

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
INVITE_CODE=mittens SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))") \
  uvicorn main:app --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000`, register with the invite code, then go to the dashboard.

### 2. Install the bot on chess.com

1. Start a game on chess.com.
2. `F12` → **Console** tab.
3. On the gate dashboard, click **Copy** on either snippet:
   - **Full script**: paste the whole thing (works even if the gate site is unreachable later).
   - **Fetch loader** (one line): `fetch("…/api/script.js?elo=600",{credentials:"include"}).then(r=>r.text()).then(t=>(0,eval)(t));` — shorter but requires the gate site to be reachable and your session cookie to be valid.
4. Paste into the console, press Enter.
5. A draggable reasoning panel appears at top-right; SVG arrows render on the board:
   - **Green** = best move the bot will play
   - **Blue** = top candidate alternatives
   - **Red** = threat arrows pointing at your hanging pieces

### 3. Modes

| Mode | Behavior |
|---|---|
| `guided` | Shows arrows + reasoning. You move. |
| `autonomous` | Bot clicks the move for you after `CFG.autoPlayDelayMs` ms. |
| `off` | Panel stays up, no thinking. |

Change modes from the panel dropdown. Change ELO with the slider (takes effect on the next search).

### 4. Teardown

Click `×` on the panel, or run `window.__chessBotTeardown()` in the console.

## Environment variables

| Var | Default | What |
|---|---|---|
| `INVITE_CODE` | `mittens` | Required to register. Change this for your class. |
| `SECRET_KEY` | random per-process | HMAC key for signed session cookies. **Set this in production** or sessions break on restart. |
| `CHESS_BOT_DB` | `/tmp/chess-bot.sqlite` | SQLite database path. Use a persistent volume in prod. |

## Assignment note (closed-note week)

The engine under `src/chess-bot.js` is hand-written alpha-beta + minimax + PST — no Stockfish, no external chess library. Stockfish WASM can be added next week when open-source is allowed; drop its loader into the Controller and toggle it in the panel.

## Tests

```bash
node test/smoke.mjs
```

Runs perft(start, 3), perft(kiwipete, 2), mate-in-1, and hanging-piece detection.
