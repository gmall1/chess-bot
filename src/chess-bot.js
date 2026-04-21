/* =====================================================================
 * chess-bot.js — autonomous / guided chess bot that runs inside chess.com
 * Paste into the DevTools Console on any chess.com game page.
 *
 *   SECTION 1  Config & Constants
 *   SECTION 2  Board Representation
 *   SECTION 3  Move Generation
 *   SECTION 4  Evaluation (material + PST + mobility + king safety)
 *   SECTION 5  Search (alpha-beta + quiescence + iterative deepening + TT)
 *   SECTION 6  Threat Detection (hanging pieces, forks, pins)
 *   SECTION 7  Chess.com DOM Adapter (FEN scrape + move execution)
 *   SECTION 8  Arrow Overlay (SVG on board)
 *   SECTION 9  Reasoning Panel (floating UI)
 *   SECTION 10 Controller (game loop, modes)
 *   SECTION 11 Bootstrap
 * ===================================================================== */
(() => {
'use strict';

if (window.__chessBotLoaded) {
  console.warn('chess-bot already loaded; reloading');
  window.__chessBotTeardown && window.__chessBotTeardown();
}
window.__chessBotLoaded = true;

/* ============================== SECTION 1 =============================
 * Config & Constants
 * ===================================================================== */
const CFG = {
  defaultDepth: 4,          // iterative deepening target ply (overridden by ELO)
  maxDepth: 8,              // hard cap
  maxThinkMs: 2500,         // soft time budget (overridden by ELO)
  autoPlayDelayMs: 350,     // delay before auto-playing (looks human-ish)
  mode: 'guided',           // 'guided' | 'autonomous' | 'off'
  drawThreats: true,
  drawCandidates: true,     // draw top-N alternative moves
  candidateCount: 2,
  elo: window.__chessBotElo || 600,  // target playing strength (400-2400)
};

/* ------------ ELO-based strength mapping ------------
 * Lower ELO: shallower search + higher temperature when sampling root moves
 * (softmax over centipawn loss). Higher ELO collapses toward always-best.
 */
function strengthProfile(elo) {
  elo = Math.max(200, Math.min(2400, elo));
  let depth, timeMs, temperature, blunderProb;
  if (elo < 500)      { depth = 1; timeMs = 250;  temperature = 400; blunderProb = 0.25; }
  else if (elo < 700) { depth = 2; timeMs = 350;  temperature = 280; blunderProb = 0.18; }
  else if (elo < 900) { depth = 2; timeMs = 500;  temperature = 180; blunderProb = 0.12; }
  else if (elo < 1100){ depth = 3; timeMs = 700;  temperature = 120; blunderProb = 0.08; }
  else if (elo < 1300){ depth = 3; timeMs = 900;  temperature =  80; blunderProb = 0.05; }
  else if (elo < 1500){ depth = 4; timeMs = 1200; temperature =  50; blunderProb = 0.03; }
  else if (elo < 1700){ depth = 4; timeMs = 1500; temperature =  30; blunderProb = 0.02; }
  else if (elo < 1900){ depth = 5; timeMs = 1800; temperature =  15; blunderProb = 0.01; }
  else if (elo < 2100){ depth = 5; timeMs = 2200; temperature =   8; blunderProb = 0.005; }
  else if (elo < 2300){ depth = 6; timeMs = 2500; temperature =   3; blunderProb = 0;   }
  else                { depth = 7; timeMs = 3000; temperature =   0; blunderProb = 0;   }
  return { depth, timeMs, temperature, blunderProb };
}

/* Weighted sample from [{move, score}] with softmax temperature T.
 * score is in centipawns (higher = better for side to move).
 */
function sampleByTemperature(options, T) {
  if (!options.length) return null;
  if (T <= 0) {
    return options.reduce((a, b) => b.score > a.score ? b : a).move;
  }
  const best = Math.max(...options.map(o => o.score));
  const weights = options.map(o => Math.exp(-(best - o.score) / T));
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r <= 0) return options[i].move;
  }
  return options[options.length - 1].move;
}

// Piece encoding. Positive = white, negative = black. 0 = empty.
const EMPTY = 0;
const wP = 1, wN = 2, wB = 3, wR = 4, wQ = 5, wK = 6;
const bP = -1, bN = -2, bB = -3, bR = -4, bQ = -5, bK = -6;

const PIECE_FROM_CHAR = { P: wP, N: wN, B: wB, R: wR, Q: wQ, K: wK,
                           p: bP, n: bN, b: bB, r: bR, q: bQ, k: bK };
const CHAR_FROM_PIECE = { [wP]:'P',[wN]:'N',[wB]:'B',[wR]:'R',[wQ]:'Q',[wK]:'K',
                           [bP]:'p',[bN]:'n',[bB]:'b',[bR]:'r',[bQ]:'q',[bK]:'k' };
const PIECE_NAME = { 1:'pawn', 2:'knight', 3:'bishop', 4:'rook', 5:'queen', 6:'king' };

const WHITE = 1, BLACK = -1;
const colorOf = (p) => p > 0 ? WHITE : p < 0 ? BLACK : 0;
const typeOf  = (p) => Math.abs(p);

// Centipawn values
const VAL = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 20000 };

// 0x88-style but we'll use 8x8 arrays (128 squares is overkill in JS).
// square indexing: sq = rank * 8 + file, file 0 = 'a', rank 0 = '1'.
const sq = (file, rank) => rank * 8 + file;
const fileOf = (s) => s & 7;
const rankOf = (s) => s >> 3;
const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const sqToAlg = (s) => String.fromCharCode(97 + fileOf(s)) + (rankOf(s) + 1);
const algToSq = (a) => sq(a.charCodeAt(0) - 97, parseInt(a[1], 10) - 1);

// Directional offsets
const KNIGHT_DELTAS = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
const BISHOP_DIRS   = [[1,1],[1,-1],[-1,1],[-1,-1]];
const ROOK_DIRS     = [[1,0],[-1,0],[0,1],[0,-1]];
const QUEEN_DIRS    = [...BISHOP_DIRS, ...ROOK_DIRS];
const KING_DELTAS   = [...QUEEN_DIRS];

/* ============================== SECTION 2 =============================
 * Board representation. Immutable-ish: make/unmake with a stack.
 * ===================================================================== */
class Board {
  constructor() {
    this.sq = new Int8Array(64);       // piece code per square
    this.turn = WHITE;                 // side to move
    this.castle = { wK: false, wQ: false, bK: false, bQ: false };
    this.ep = -1;                       // en-passant target square or -1
    this.halfmove = 0;                  // fifty-move counter
    this.fullmove = 1;
    this.history = [];                  // for unmake
    this.zobrist = 0n;
  }

  clone() {
    const b = new Board();
    b.sq.set(this.sq);
    b.turn = this.turn;
    b.castle = { ...this.castle };
    b.ep = this.ep;
    b.halfmove = this.halfmove;
    b.fullmove = this.fullmove;
    b.zobrist = this.zobrist;
    return b;
  }

  static fromFEN(fen) {
    const b = new Board();
    const [pos, turn, castling, ep, half, full] = fen.trim().split(/\s+/);
    const ranks = pos.split('/');
    if (ranks.length !== 8) throw new Error('Bad FEN: ' + fen);
    for (let r = 0; r < 8; r++) {
      const row = ranks[7 - r];
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { f += parseInt(ch, 10); continue; }
        b.sq[sq(f, r)] = PIECE_FROM_CHAR[ch] || 0;
        f++;
      }
    }
    b.turn = turn === 'w' ? WHITE : BLACK;
    b.castle = {
      wK: castling.includes('K'), wQ: castling.includes('Q'),
      bK: castling.includes('k'), bQ: castling.includes('q'),
    };
    b.ep = (ep && ep !== '-') ? algToSq(ep) : -1;
    b.halfmove = parseInt(half || '0', 10);
    b.fullmove = parseInt(full || '1', 10);
    return b;
  }

  toFEN() {
    let rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.sq[sq(f, r)];
        if (p === 0) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += CHAR_FROM_PIECE[p];
      }
      if (empty) row += empty;
      rows.push(row);
    }
    const castling = (this.castle.wK ? 'K' : '') + (this.castle.wQ ? 'Q' : '') +
                     (this.castle.bK ? 'k' : '') + (this.castle.bQ ? 'q' : '') || '-';
    return [
      rows.join('/'),
      this.turn === WHITE ? 'w' : 'b',
      castling,
      this.ep >= 0 ? sqToAlg(this.ep) : '-',
      this.halfmove,
      this.fullmove,
    ].join(' ');
  }

  findKing(color) {
    const target = color === WHITE ? wK : bK;
    for (let s = 0; s < 64; s++) if (this.sq[s] === target) return s;
    return -1;
  }

  /* ---- make / unmake ---- */
  make(mv) {
    const { from, to, promo, flag } = mv;
    const piece = this.sq[from];
    const captured = flag === 'ep' ? (this.turn === WHITE ? bP : wP) : this.sq[to];
    this.history.push({
      mv, captured,
      castle: { ...this.castle },
      ep: this.ep,
      halfmove: this.halfmove,
      fullmove: this.fullmove,
    });

    // Move piece
    this.sq[to] = promo ? promo * this.turn : piece;
    this.sq[from] = EMPTY;

    // En-passant capture removes pawn behind
    if (flag === 'ep') {
      const capSq = to + (this.turn === WHITE ? -8 : 8);
      this.sq[capSq] = EMPTY;
    }

    // Castling: move rook
    if (flag === 'OO') {
      if (this.turn === WHITE) { this.sq[sq(5,0)] = wR; this.sq[sq(7,0)] = EMPTY; }
      else                      { this.sq[sq(5,7)] = bR; this.sq[sq(7,7)] = EMPTY; }
    } else if (flag === 'OOO') {
      if (this.turn === WHITE) { this.sq[sq(3,0)] = wR; this.sq[sq(0,0)] = EMPTY; }
      else                      { this.sq[sq(3,7)] = bR; this.sq[sq(0,7)] = EMPTY; }
    }

    // Castling rights updates
    const pt = typeOf(piece);
    if (pt === 6) {
      if (this.turn === WHITE) { this.castle.wK = this.castle.wQ = false; }
      else                      { this.castle.bK = this.castle.bQ = false; }
    } else if (pt === 4) {
      if (from === sq(0,0)) this.castle.wQ = false;
      if (from === sq(7,0)) this.castle.wK = false;
      if (from === sq(0,7)) this.castle.bQ = false;
      if (from === sq(7,7)) this.castle.bK = false;
    }
    if (to === sq(0,0)) this.castle.wQ = false;
    if (to === sq(7,0)) this.castle.wK = false;
    if (to === sq(0,7)) this.castle.bQ = false;
    if (to === sq(7,7)) this.castle.bK = false;

    // En-passant target
    if (pt === 1 && Math.abs(to - from) === 16) {
      this.ep = (from + to) / 2;
    } else {
      this.ep = -1;
    }

    // Fifty-move counter
    if (pt === 1 || captured !== 0) this.halfmove = 0;
    else this.halfmove++;

    if (this.turn === BLACK) this.fullmove++;
    this.turn = -this.turn;
  }

  unmake() {
    const h = this.history.pop();
    if (!h) return;
    const { mv, captured } = h;
    this.castle = h.castle;
    this.ep = h.ep;
    this.halfmove = h.halfmove;
    this.fullmove = h.fullmove;
    this.turn = -this.turn;

    const { from, to, promo, flag } = mv;
    const moved = this.sq[to];

    // Put original piece back (undo promotion)
    this.sq[from] = promo ? (this.turn === WHITE ? wP : bP) : moved;
    this.sq[to] = (flag === 'ep') ? EMPTY : captured;

    if (flag === 'ep') {
      const capSq = to + (this.turn === WHITE ? -8 : 8);
      this.sq[capSq] = captured;
    }

    // Un-castle
    if (flag === 'OO') {
      if (this.turn === WHITE) { this.sq[sq(7,0)] = wR; this.sq[sq(5,0)] = EMPTY; }
      else                      { this.sq[sq(7,7)] = bR; this.sq[sq(5,7)] = EMPTY; }
    } else if (flag === 'OOO') {
      if (this.turn === WHITE) { this.sq[sq(0,0)] = wR; this.sq[sq(3,0)] = EMPTY; }
      else                      { this.sq[sq(0,7)] = bR; this.sq[sq(3,7)] = EMPTY; }
    }
  }

  /* ---- attack / check tests ---- */
  isSquareAttacked(target, byColor) {
    // Pawn attacks
    const dir = byColor === WHITE ? 1 : -1;
    const pawn = byColor === WHITE ? wP : bP;
    const tf = fileOf(target), tr = rankOf(target);
    for (const df of [-1, 1]) {
      const f = tf + df, r = tr - dir;
      if (onBoard(f, r) && this.sq[sq(f, r)] === pawn) return true;
    }
    // Knights
    const knight = byColor === WHITE ? wN : bN;
    for (const [df, dr] of KNIGHT_DELTAS) {
      const f = tf + df, r = tr + dr;
      if (onBoard(f, r) && this.sq[sq(f, r)] === knight) return true;
    }
    // Kings
    const king = byColor === WHITE ? wK : bK;
    for (const [df, dr] of KING_DELTAS) {
      const f = tf + df, r = tr + dr;
      if (onBoard(f, r) && this.sq[sq(f, r)] === king) return true;
    }
    // Sliders: bishops/queens on diagonals
    const bishop = byColor === WHITE ? wB : bB;
    const queen  = byColor === WHITE ? wQ : bQ;
    for (const [df, dr] of BISHOP_DIRS) {
      let f = tf + df, r = tr + dr;
      while (onBoard(f, r)) {
        const p = this.sq[sq(f, r)];
        if (p !== 0) {
          if (p === bishop || p === queen) return true;
          break;
        }
        f += df; r += dr;
      }
    }
    // Sliders: rooks/queens on files/ranks
    const rook = byColor === WHITE ? wR : bR;
    for (const [df, dr] of ROOK_DIRS) {
      let f = tf + df, r = tr + dr;
      while (onBoard(f, r)) {
        const p = this.sq[sq(f, r)];
        if (p !== 0) {
          if (p === rook || p === queen) return true;
          break;
        }
        f += df; r += dr;
      }
    }
    return false;
  }

  inCheck(color = this.turn) {
    const ks = this.findKing(color);
    if (ks < 0) return false;
    return this.isSquareAttacked(ks, -color);
  }
}

/* ============================== SECTION 3 =============================
 * Move generation
 * ===================================================================== */
function generatePseudoMoves(b) {
  const moves = [];
  const us = b.turn;
  for (let s = 0; s < 64; s++) {
    const p = b.sq[s];
    if (p === 0 || colorOf(p) !== us) continue;
    const t = typeOf(p);
    if (t === 1) genPawn(b, s, moves);
    else if (t === 2) genStep(b, s, moves, KNIGHT_DELTAS, false);
    else if (t === 3) genStep(b, s, moves, BISHOP_DIRS, true);
    else if (t === 4) genStep(b, s, moves, ROOK_DIRS, true);
    else if (t === 5) genStep(b, s, moves, QUEEN_DIRS, true);
    else if (t === 6) genKing(b, s, moves);
  }
  return moves;
}

function genPawn(b, from, moves) {
  const us = b.turn;
  const dir = us === WHITE ? 1 : -1;
  const startRank = us === WHITE ? 1 : 6;
  const promoRank = us === WHITE ? 7 : 0;
  const f = fileOf(from), r = rankOf(from);

  // Single push
  const one = sq(f, r + dir);
  if (onBoard(f, r + dir) && b.sq[one] === 0) {
    if (r + dir === promoRank) {
      for (const promo of [5, 4, 3, 2]) moves.push({ from, to: one, promo });
    } else {
      moves.push({ from, to: one });
      // Double push
      if (r === startRank) {
        const two = sq(f, r + 2 * dir);
        if (b.sq[two] === 0) moves.push({ from, to: two });
      }
    }
  }
  // Captures
  for (const df of [-1, 1]) {
    const nf = f + df, nr = r + dir;
    if (!onBoard(nf, nr)) continue;
    const to = sq(nf, nr);
    const victim = b.sq[to];
    if (victim !== 0 && colorOf(victim) !== us) {
      if (nr === promoRank) {
        for (const promo of [5, 4, 3, 2]) moves.push({ from, to, promo });
      } else {
        moves.push({ from, to });
      }
    } else if (to === b.ep) {
      moves.push({ from, to, flag: 'ep' });
    }
  }
}

function genStep(b, from, moves, dirs, slide) {
  const us = b.turn;
  const f = fileOf(from), r = rankOf(from);
  for (const [df, dr] of dirs) {
    let nf = f + df, nr = r + dr;
    while (onBoard(nf, nr)) {
      const to = sq(nf, nr);
      const p = b.sq[to];
      if (p === 0) {
        moves.push({ from, to });
      } else {
        if (colorOf(p) !== us) moves.push({ from, to });
        break;
      }
      if (!slide) break;
      nf += df; nr += dr;
    }
  }
}

function genKing(b, from, moves) {
  genStep(b, from, moves, KING_DELTAS, false);
  // Castling
  const us = b.turn;
  const back = us === WHITE ? 0 : 7;
  if (from !== sq(4, back)) return;
  if (b.inCheck(us)) return;
  const rights = us === WHITE ? b.castle : { wK: b.castle.bK, wQ: b.castle.bQ };
  const kSide = us === WHITE ? b.castle.wK : b.castle.bK;
  const qSide = us === WHITE ? b.castle.wQ : b.castle.bQ;
  if (kSide) {
    if (b.sq[sq(5, back)] === 0 && b.sq[sq(6, back)] === 0 &&
        !b.isSquareAttacked(sq(5, back), -us) &&
        !b.isSquareAttacked(sq(6, back), -us)) {
      moves.push({ from, to: sq(6, back), flag: 'OO' });
    }
  }
  if (qSide) {
    if (b.sq[sq(3, back)] === 0 && b.sq[sq(2, back)] === 0 && b.sq[sq(1, back)] === 0 &&
        !b.isSquareAttacked(sq(3, back), -us) &&
        !b.isSquareAttacked(sq(2, back), -us)) {
      moves.push({ from, to: sq(2, back), flag: 'OOO' });
    }
  }
}

function generateLegalMoves(b) {
  const pseudo = generatePseudoMoves(b);
  const legal = [];
  const us = b.turn;
  for (const mv of pseudo) {
    b.make(mv);
    if (!b.isSquareAttacked(b.findKing(us), -us)) legal.push(mv);
    b.unmake();
  }
  return legal;
}

function moveToUci(mv) {
  let s = sqToAlg(mv.from) + sqToAlg(mv.to);
  if (mv.promo) s += 'qrbn'[[5,4,3,2].indexOf(mv.promo)];
  return s;
}

function moveToSan(b, mv) {
  // Simplified SAN; enough for display
  const piece = b.sq[mv.from];
  const pt = typeOf(piece);
  if (mv.flag === 'OO') return 'O-O';
  if (mv.flag === 'OOO') return 'O-O-O';
  const capture = b.sq[mv.to] !== 0 || mv.flag === 'ep';
  let s = '';
  if (pt === 1) {
    if (capture) s += String.fromCharCode(97 + fileOf(mv.from)) + 'x';
    s += sqToAlg(mv.to);
    if (mv.promo) s += '=' + 'QRBN'['54321'.indexOf(String(mv.promo))];
  } else {
    s += CHAR_FROM_PIECE[Math.abs(piece)].toUpperCase();
    // Ambiguity: check if another same-type piece can reach mv.to
    const amb = [];
    for (const other of generateLegalMoves(b)) {
      if (other.from !== mv.from && other.to === mv.to &&
          typeOf(b.sq[other.from]) === pt) amb.push(other.from);
    }
    if (amb.length) {
      const sameFile = amb.some(o => fileOf(o) === fileOf(mv.from));
      const sameRank = amb.some(o => rankOf(o) === rankOf(mv.from));
      if (!sameFile) s += String.fromCharCode(97 + fileOf(mv.from));
      else if (!sameRank) s += String(rankOf(mv.from) + 1);
      else s += sqToAlg(mv.from);
    }
    if (capture) s += 'x';
    s += sqToAlg(mv.to);
  }
  // Check/mate marker
  b.make(mv);
  if (b.inCheck()) {
    const noReply = generateLegalMoves(b).length === 0;
    s += noReply ? '#' : '+';
  }
  b.unmake();
  return s;
}

/* ============================== SECTION 4 =============================
 * Evaluation. Material + Piece-Square Tables + mobility + king safety.
 * All tables from white's POV; mirror for black via rank flip.
 * ===================================================================== */
const PST = {
  // pawn
  1: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10,-20,-20, 10, 10,  5,
     5, -5,-10,  0,  0,-10, -5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5,  5, 10, 25, 25, 10,  5,  5,
    10, 10, 20, 30, 30, 20, 10, 10,
    50, 50, 50, 50, 50, 50, 50, 50,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  // knight
  2: [
   -50,-40,-30,-30,-30,-30,-40,-50,
   -40,-20,  0,  5,  5,  0,-20,-40,
   -30,  5, 10, 15, 15, 10,  5,-30,
   -30,  0, 15, 20, 20, 15,  0,-30,
   -30,  5, 15, 20, 20, 15,  5,-30,
   -30,  0, 10, 15, 15, 10,  0,-30,
   -40,-20,  0,  0,  0,  0,-20,-40,
   -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  // bishop
  3: [
   -20,-10,-10,-10,-10,-10,-10,-20,
   -10,  5,  0,  0,  0,  0,  5,-10,
   -10, 10, 10, 10, 10, 10, 10,-10,
   -10,  0, 10, 10, 10, 10,  0,-10,
   -10,  5,  5, 10, 10,  5,  5,-10,
   -10,  0,  5, 10, 10,  5,  0,-10,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  // rook
  4: [
     0,  0,  5, 10, 10,  5,  0,  0,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     5, 10, 10, 10, 10, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  // queen
  5: [
   -20,-10,-10, -5, -5,-10,-10,-20,
   -10,  0,  5,  0,  0,  0,  0,-10,
   -10,  5,  5,  5,  5,  5,  0,-10,
     0,  0,  5,  5,  5,  5,  0, -5,
    -5,  0,  5,  5,  5,  5,  0, -5,
   -10,  0,  5,  5,  5,  5,  0,-10,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  // king (middlegame)
  6: [
    20, 30, 10,  0,  0, 10, 30, 20,
    20, 20,  0,  0,  0,  0, 20, 20,
   -10,-20,-20,-20,-20,-20,-20,-10,
   -20,-30,-30,-40,-40,-30,-30,-20,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
  ],
  // king endgame
  'k_eg': [
   -50,-30,-30,-30,-30,-30,-30,-50,
   -30,-30,  0,  0,  0,  0,-30,-30,
   -30,-10, 20, 30, 30, 20,-10,-30,
   -30,-10, 30, 40, 40, 30,-10,-30,
   -30,-10, 30, 40, 40, 30,-10,-30,
   -30,-10, 20, 30, 30, 20,-10,-30,
   -30,-20,-10,  0,  0,-10,-20,-30,
   -50,-40,-30,-20,-20,-30,-40,-50,
  ],
};

function isEndgame(b) {
  let nonPawn = 0;
  for (let s = 0; s < 64; s++) {
    const t = typeOf(b.sq[s]);
    if (t >= 2 && t <= 5) nonPawn += VAL[t];
  }
  return nonPawn < 2400;
}

function evaluate(b) {
  let score = 0;
  const eg = isEndgame(b);
  let wMobility = 0, bMobility = 0;
  let wBishops = 0, bBishops = 0;

  for (let s = 0; s < 64; s++) {
    const p = b.sq[s];
    if (p === 0) continue;
    const t = typeOf(p);
    const c = colorOf(p);
    const mat = VAL[t];
    // PST lookup: for white use s, for black mirror rank
    const pstIdx = c === WHITE ? s : sq(fileOf(s), 7 - rankOf(s));
    const table = (t === 6 && eg) ? PST.k_eg : PST[t];
    const pst = table[pstIdx];
    score += c * (mat + pst);
    if (t === 3) { c === WHITE ? wBishops++ : bBishops++; }
  }

  // Bishop pair bonus
  if (wBishops >= 2) score += 30;
  if (bBishops >= 2) score -= 30;

  // Mobility (cheap proxy: count pseudo moves for side to move and opponent)
  // Expensive to compute both sides; approximate by caller's turn only.
  const origTurn = b.turn;
  const myMoves = generatePseudoMoves(b).length;
  b.turn = -origTurn;
  const oppMoves = generatePseudoMoves(b).length;
  b.turn = origTurn;
  score += origTurn * 3 * (myMoves - oppMoves);

  // King safety: count attackers on squares around own king
  score += kingSafety(b, WHITE) - kingSafety(b, BLACK);

  // Return from side-to-move perspective
  return origTurn * score;
}

function kingSafety(b, color) {
  if (isEndgame(b)) return 0;
  const ks = b.findKing(color);
  if (ks < 0) return 0;
  const f = fileOf(ks), r = rankOf(ks);
  let attackers = 0;
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    const nf = f + df, nr = r + dr;
    if (!onBoard(nf, nr)) continue;
    if (b.isSquareAttacked(sq(nf, nr), -color)) attackers++;
  }
  return -attackers * 8;
}

/* ============================== SECTION 5 =============================
 * Search: iterative deepening alpha-beta with quiescence and killer moves.
 * ===================================================================== */
const MATE = 30000;
const INF = 40000;

class Searcher {
  constructor(board) {
    this.b = board;
    this.nodes = 0;
    this.qnodes = 0;
    this.killers = [[null, null]];
    this.history = new Map();
    this.pv = [];
    this.stopAt = Infinity;
    this.stopped = false;
  }

  sortMoves(moves, pvMove, depth) {
    const k1 = this.killers[depth]?.[0];
    const k2 = this.killers[depth]?.[1];
    const score = (mv) => {
      if (pvMove && mv.from === pvMove.from && mv.to === pvMove.to && mv.promo === pvMove.promo)
        return 1000000;
      const victim = this.b.sq[mv.to];
      if (victim !== 0) {
        // MVV-LVA
        const v = VAL[typeOf(victim)];
        const a = VAL[typeOf(this.b.sq[mv.from])];
        return 100000 + v * 10 - a;
      }
      if (mv.promo) return 90000 + mv.promo;
      if (k1 && mv.from === k1.from && mv.to === k1.to) return 80000;
      if (k2 && mv.from === k2.from && mv.to === k2.to) return 70000;
      return this.history.get(mv.from * 64 + mv.to) || 0;
    };
    moves.sort((a, c) => score(c) - score(a));
  }

  quiesce(alpha, beta) {
    if (performance.now() > this.stopAt) { this.stopped = true; return 0; }
    this.qnodes++;
    const standPat = evaluate(this.b);
    if (standPat >= beta) return beta;
    if (alpha < standPat) alpha = standPat;

    const moves = generatePseudoMoves(this.b).filter(m =>
      this.b.sq[m.to] !== 0 || m.flag === 'ep' || m.promo);
    this.sortMoves(moves, null, 0);

    const us = this.b.turn;
    for (const mv of moves) {
      this.b.make(mv);
      if (this.b.isSquareAttacked(this.b.findKing(us), -us)) { this.b.unmake(); continue; }
      const score = -this.quiesce(-beta, -alpha);
      this.b.unmake();
      if (this.stopped) return 0;
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  negamax(depth, alpha, beta, ply, pvLine) {
    if (performance.now() > this.stopAt) { this.stopped = true; return 0; }
    if (depth <= 0) return this.quiesce(alpha, beta);
    this.nodes++;
    while (this.killers.length <= ply) this.killers.push([null, null]);

    const us = this.b.turn;
    const moves = generatePseudoMoves(this.b);
    this.sortMoves(moves, pvLine[0], ply);

    let bestScore = -INF;
    let legalCount = 0;
    const childPV = [];

    for (const mv of moves) {
      this.b.make(mv);
      if (this.b.isSquareAttacked(this.b.findKing(us), -us)) { this.b.unmake(); continue; }
      legalCount++;
      childPV.length = 0;
      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, childPV);
      this.b.unmake();
      if (this.stopped) return 0;

      if (score > bestScore) {
        bestScore = score;
        if (score > alpha) {
          alpha = score;
          pvLine.length = 0;
          pvLine.push(mv, ...childPV);
        }
      }
      if (alpha >= beta) {
        // Beta cutoff: record killer if quiet move
        if (this.b.sq[mv.to] === 0 && !mv.promo) {
          const k = this.killers[ply];
          if (!k[0] || k[0].from !== mv.from || k[0].to !== mv.to) {
            k[1] = k[0]; k[0] = mv;
          }
          const key = mv.from * 64 + mv.to;
          this.history.set(key, (this.history.get(key) || 0) + depth * depth);
        }
        break;
      }
    }
    if (legalCount === 0) {
      return this.b.inCheck() ? -MATE + ply : 0;
    }
    return bestScore;
  }

  searchIterative(maxDepth, timeMs) {
    this.stopAt = performance.now() + timeMs;
    this.stopped = false;
    let bestPV = [];
    let bestScore = 0;
    let reachedDepth = 0;
    for (let d = 1; d <= maxDepth; d++) {
      this.nodes = 0; this.qnodes = 0;
      const pv = [...bestPV];
      const score = this.negamax(d, -INF, INF, 0, pv);
      if (this.stopped && d > 1) break;
      bestPV = pv;
      bestScore = score;
      reachedDepth = d;
      if (Math.abs(score) >= MATE - 100) break;
    }
    return { pv: bestPV, score: bestScore, depth: reachedDepth,
             nodes: this.nodes, qnodes: this.qnodes };
  }
}

/* ============================== SECTION 6 =============================
 * Threat detection: hanging pieces, attacked squares summary,
 * basic fork/pin heuristics.
 * ===================================================================== */
function findThreats(b, forColor) {
  // Return list of { sq, piece, description } for pieces of `forColor`
  // that are in danger (attacked and under-defended).
  const threats = [];
  const opp = -forColor;
  for (let s = 0; s < 64; s++) {
    const p = b.sq[s];
    if (p === 0 || colorOf(p) !== forColor) continue;
    if (b.isSquareAttacked(s, opp)) {
      const attackers = countAttackers(b, s, opp);
      const defenders = countAttackers(b, s, forColor);
      const leastAttackerVal = leastAttacker(b, s, opp);
      const pieceVal = VAL[typeOf(p)];
      // Hanging: no defenders or attacker cheaper than us
      if (defenders === 0 || leastAttackerVal < pieceVal) {
        threats.push({
          sq: s,
          piece: p,
          name: PIECE_NAME[typeOf(p)],
          severity: pieceVal,
          attackers, defenders,
          reason: defenders === 0 ? 'hanging' : 'under-defended',
        });
      }
    }
  }
  threats.sort((a, c) => c.severity - a.severity);
  return threats;
}

function countAttackers(b, target, byColor) {
  let n = 0;
  const tf = fileOf(target), tr = rankOf(target);
  const dir = byColor === WHITE ? 1 : -1;
  const pawn = byColor === WHITE ? wP : bP;
  for (const df of [-1, 1]) {
    const f = tf + df, r = tr - dir;
    if (onBoard(f, r) && b.sq[sq(f, r)] === pawn) n++;
  }
  const knight = byColor === WHITE ? wN : bN;
  for (const [df, dr] of KNIGHT_DELTAS) {
    const f = tf + df, r = tr + dr;
    if (onBoard(f, r) && b.sq[sq(f, r)] === knight) n++;
  }
  const king = byColor === WHITE ? wK : bK;
  for (const [df, dr] of KING_DELTAS) {
    const f = tf + df, r = tr + dr;
    if (onBoard(f, r) && b.sq[sq(f, r)] === king) n++;
  }
  const bishop = byColor === WHITE ? wB : bB;
  const queen  = byColor === WHITE ? wQ : bQ;
  for (const [df, dr] of BISHOP_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const p = b.sq[sq(f, r)];
      if (p !== 0) { if (p === bishop || p === queen) n++; break; }
      f += df; r += dr;
    }
  }
  const rook = byColor === WHITE ? wR : bR;
  for (const [df, dr] of ROOK_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const p = b.sq[sq(f, r)];
      if (p !== 0) { if (p === rook || p === queen) n++; break; }
      f += df; r += dr;
    }
  }
  return n;
}

function leastAttacker(b, target, byColor) {
  // Return centipawn value of cheapest attacker, or Infinity if none.
  let best = Infinity;
  const tf = fileOf(target), tr = rankOf(target);
  const dir = byColor === WHITE ? 1 : -1;
  const pawn = byColor === WHITE ? wP : bP;
  for (const df of [-1, 1]) {
    const f = tf + df, r = tr - dir;
    if (onBoard(f, r) && b.sq[sq(f, r)] === pawn) best = Math.min(best, VAL[1]);
  }
  const knight = byColor === WHITE ? wN : bN;
  for (const [df, dr] of KNIGHT_DELTAS) {
    const f = tf + df, r = tr + dr;
    if (onBoard(f, r) && b.sq[sq(f, r)] === knight) best = Math.min(best, VAL[2]);
  }
  const bishop = byColor === WHITE ? wB : bB, queen = byColor === WHITE ? wQ : bQ;
  for (const [df, dr] of BISHOP_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const p = b.sq[sq(f, r)];
      if (p !== 0) {
        if (p === bishop) best = Math.min(best, VAL[3]);
        else if (p === queen) best = Math.min(best, VAL[5]);
        break;
      }
      f += df; r += dr;
    }
  }
  const rook = byColor === WHITE ? wR : bR;
  for (const [df, dr] of ROOK_DIRS) {
    let f = tf + df, r = tr + dr;
    while (onBoard(f, r)) {
      const p = b.sq[sq(f, r)];
      if (p !== 0) {
        if (p === rook) best = Math.min(best, VAL[4]);
        else if (p === queen) best = Math.min(best, VAL[5]);
        break;
      }
      f += df; r += dr;
    }
  }
  const king = byColor === WHITE ? wK : bK;
  for (const [df, dr] of KING_DELTAS) {
    const f = tf + df, r = tr + dr;
    if (onBoard(f, r) && b.sq[sq(f, r)] === king) best = Math.min(best, VAL[6]);
  }
  return best;
}

/* ============================== SECTION 7 =============================
 * Chess.com DOM adapter.
 * Chess.com uses a <wc-chess-board> (or <chess-board>) custom element.
 * Pieces are <div class="piece {color}{type} square-{file}{rank}">
 *   e.g. "piece wp square-52"  =>  white pawn on file 5 rank 2 => e2
 * Board flipped (player is black) is indicated by `.flipped` on the board.
 * ===================================================================== */
const ChessCom = {
  findBoardEl() {
    return document.querySelector('wc-chess-board')
        || document.querySelector('chess-board')
        || document.querySelector('.board')
        || document.querySelector('cg-board'); // lichess fallback
  },

  isFlipped(boardEl) {
    if (!boardEl) return false;
    return boardEl.classList.contains('flipped')
        || boardEl.getAttribute('flipped') === 'true';
  },

  playerColor(boardEl) {
    // On chess.com, orientation reflects player color.
    return this.isFlipped(boardEl) ? BLACK : WHITE;
  },

  scrapePieces() {
    const boardEl = this.findBoardEl();
    if (!boardEl) return null;
    const pieces = boardEl.querySelectorAll('.piece');
    const sqMap = {};
    for (const el of pieces) {
      let pieceCode = null, squareCode = null;
      for (const cls of el.classList) {
        if (/^[wb][prnbqk]$/.test(cls)) pieceCode = cls;
        else if (/^square-\d{2}$/.test(cls)) squareCode = cls.slice(7);
      }
      if (!pieceCode || !squareCode) continue;
      const file = parseInt(squareCode[0], 10) - 1; // 1-8 -> 0-7
      const rank = parseInt(squareCode[1], 10) - 1;
      const color = pieceCode[0];
      const type = pieceCode[1];
      const piece = PIECE_FROM_CHAR[color === 'w' ? type.toUpperCase() : type];
      sqMap[sq(file, rank)] = piece;
    }
    return sqMap;
  },

  buildFEN(prevBoard) {
    // Scrape pieces + infer turn/castling/ep from prevBoard if available.
    const sqMap = this.scrapePieces();
    if (!sqMap) return null;
    const b = new Board();
    for (const [k, v] of Object.entries(sqMap)) b.sq[parseInt(k, 10)] = v;

    // Infer side to move from the last-move highlights if possible.
    // Chess.com marks the last move with `.highlight square-XX`.
    const boardEl = this.findBoardEl();
    const hls = boardEl ? [...boardEl.querySelectorAll('.highlight')] : [];
    let inferredTurn = null;
    if (hls.length >= 2) {
      const coords = hls.map(h => {
        for (const cls of h.classList) if (/^square-\d{2}$/.test(cls))
          return { f: parseInt(cls[7], 10) - 1, r: parseInt(cls[8], 10) - 1 };
        return null;
      }).filter(Boolean);
      // Whichever of the two highlights has a piece on it was the destination.
      const destHl = coords.find(c => b.sq[sq(c.f, c.r)] !== 0);
      if (destHl) {
        const p = b.sq[sq(destHl.f, destHl.r)];
        inferredTurn = -colorOf(p); // other side to move now
      }
    }

    if (prevBoard && inferredTurn == null) {
      inferredTurn = -prevBoard.turn;
    }
    b.turn = inferredTurn || WHITE;

    // Conservative castling rights: only enable if king and rook on home squares.
    b.castle.wK = b.sq[sq(4,0)] === wK && b.sq[sq(7,0)] === wR;
    b.castle.wQ = b.sq[sq(4,0)] === wK && b.sq[sq(0,0)] === wR;
    b.castle.bK = b.sq[sq(4,7)] === bK && b.sq[sq(7,7)] === bR;
    b.castle.bQ = b.sq[sq(4,7)] === bK && b.sq[sq(0,7)] === bR;

    // Carry en-passant from prev if the last move was a double pawn push.
    if (prevBoard) {
      const diffs = [];
      for (let s = 0; s < 64; s++) if (prevBoard.sq[s] !== b.sq[s]) diffs.push(s);
      if (diffs.length === 2) {
        const [a, c] = diffs;
        const pa = prevBoard.sq[a], pb = b.sq[c];
        if (typeOf(pa) === 1 && pa === pb && Math.abs(a - c) === 16) {
          b.ep = (a + c) / 2;
        }
      }
    }
    return b;
  },

  /** Play a move by dispatching the same events chess.com uses internally. */
  async playMove(mv) {
    const boardEl = this.findBoardEl();
    if (!boardEl) return false;

    // Preferred: use the element's exposed game API when available.
    const game = boardEl.game || window.chesscom?.game;
    if (game && typeof game.move === 'function') {
      try {
        const from = sqToAlg(mv.from), to = sqToAlg(mv.to);
        const promo = mv.promo ? 'qrbn'[[5,4,3,2].indexOf(mv.promo)] : undefined;
        const result = game.move({ from, to, promotion: promo });
        if (result) return true;
      } catch (e) { /* fall through */ }
    }

    // Fallback: click source then destination square.
    const clickSquare = (s) => {
      const f = fileOf(s) + 1, r = rankOf(s) + 1;
      const cls = `square-${f}${r}`;
      // Try to click the square element itself
      const sqEl = boardEl.querySelector(`.${cls}`);
      const rect = (sqEl || boardEl).getBoundingClientRect();
      const boardRect = boardEl.getBoundingClientRect();
      const sqSize = boardRect.width / 8;
      const flipped = this.isFlipped(boardEl);
      const cx = boardRect.left + (flipped ? (7 - fileOf(s)) : fileOf(s)) * sqSize + sqSize / 2;
      const cy = boardRect.top  + (flipped ? rankOf(s) : (7 - rankOf(s))) * sqSize + sqSize / 2;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        const ev = new MouseEvent(type, {
          clientX: cx, clientY: cy,
          bubbles: true, cancelable: true, button: 0,
        });
        (sqEl || boardEl).dispatchEvent(ev);
      }
    };
    clickSquare(mv.from);
    await new Promise(r => setTimeout(r, 60));
    clickSquare(mv.to);
    // Promotion handling — default queen, clicking again usually auto-picks.
    return true;
  },
};

/* ============================== SECTION 8 =============================
 * Arrow overlay (SVG) drawn on top of chess.com board.
 * ===================================================================== */
const Arrows = {
  svg: null,
  ensure() {
    const boardEl = ChessCom.findBoardEl();
    if (!boardEl) return null;
    if (this.svg && this.svg.isConnected) return this.svg;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('id', '__chess-bot-arrows');
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '9999';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    for (const [id, color] of [['arrBest','rgba(80,200,120,0.85)'],
                                ['arrCand','rgba(80,140,220,0.7)'],
                                ['arrThreat','rgba(230,80,80,0.9)']]) {
      const m = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      m.setAttribute('id', id);
      m.setAttribute('viewBox', '0 0 10 10');
      m.setAttribute('refX', '6'); m.setAttribute('refY', '5');
      m.setAttribute('markerWidth', '5'); m.setAttribute('markerHeight', '5');
      m.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      path.setAttribute('fill', color);
      m.appendChild(path);
      defs.appendChild(m);
    }
    svg.appendChild(defs);
    // boardEl must be position:relative for absolute SVG to fit
    if (getComputedStyle(boardEl).position === 'static') boardEl.style.position = 'relative';
    boardEl.appendChild(svg);
    this.svg = svg;
    return svg;
  },

  clear() {
    const svg = this.svg;
    if (!svg) return;
    while (svg.childNodes.length > 1) svg.removeChild(svg.lastChild);
  },

  draw(arrows) {
    const svg = this.ensure();
    if (!svg) return;
    this.clear();
    const boardEl = ChessCom.findBoardEl();
    const flipped = ChessCom.isFlipped(boardEl);
    const rect = boardEl.getBoundingClientRect();
    const size = rect.width / 8;
    svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    for (const a of arrows) {
      const { from, to, kind } = a;
      const fx = flipped ? (7 - fileOf(from)) : fileOf(from);
      const fy = flipped ? rankOf(from) : (7 - rankOf(from));
      const tx = flipped ? (7 - fileOf(to)) : fileOf(to);
      const ty = flipped ? rankOf(to) : (7 - rankOf(to));
      const x1 = fx * size + size / 2;
      const y1 = fy * size + size / 2;
      const x2 = tx * size + size / 2;
      const y2 = ty * size + size / 2;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      const color = kind === 'best' ? 'rgba(80,200,120,0.85)'
                  : kind === 'threat' ? 'rgba(230,80,80,0.9)'
                  : 'rgba(80,140,220,0.7)';
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', Math.max(size * 0.12, 6));
      line.setAttribute('stroke-linecap', 'round');
      const markerId = kind === 'best' ? 'arrBest' : kind === 'threat' ? 'arrThreat' : 'arrCand';
      line.setAttribute('marker-end', `url(#${markerId})`);
      svg.appendChild(line);
    }
  },

  highlightSquares(squares, color = 'rgba(230,80,80,0.35)') {
    const svg = this.ensure();
    if (!svg) return;
    const boardEl = ChessCom.findBoardEl();
    const flipped = ChessCom.isFlipped(boardEl);
    const rect = boardEl.getBoundingClientRect();
    const size = rect.width / 8;
    for (const s of squares) {
      const fx = flipped ? (7 - fileOf(s)) : fileOf(s);
      const fy = flipped ? rankOf(s) : (7 - rankOf(s));
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', fx * size); r.setAttribute('y', fy * size);
      r.setAttribute('width', size); r.setAttribute('height', size);
      r.setAttribute('fill', color);
      svg.appendChild(r);
    }
  },
};

/* ============================== SECTION 9 =============================
 * Reasoning panel (floating draggable UI).
 * ===================================================================== */
const Panel = {
  el: null,
  build() {
    if (this.el && this.el.isConnected) return this.el;
    const wrap = document.createElement('div');
    wrap.id = '__chess-bot-panel';
    wrap.innerHTML = `
      <div class="cb-head">
        <span class="cb-title">Chess Bot</span>
        <span class="cb-drag">⋮⋮</span>
        <button class="cb-close" title="close">×</button>
      </div>
      <div class="cb-row">
        <label>Mode</label>
        <select class="cb-mode">
          <option value="guided">Guided</option>
          <option value="autonomous">Autonomous</option>
          <option value="off">Off</option>
        </select>
      </div>
      <div class="cb-row">
        <label>ELO</label>
        <input type="range" class="cb-elo" min="400" max="2400" step="100" value="${CFG.elo}">
        <span class="cb-elo-val">${CFG.elo}</span>
      </div>
      <div class="cb-evalbar"><div class="cb-evalfill"></div><span class="cb-evaltxt">0.00</span></div>
      <div class="cb-section"><h4>Best move</h4><div class="cb-best">—</div></div>
      <div class="cb-section"><h4>Principal variation</h4><div class="cb-pv">—</div></div>
      <div class="cb-section"><h4>Threats</h4><ul class="cb-threats"><li class="cb-empty">none</li></ul></div>
      <div class="cb-section cb-stats"><span class="cb-d">d=0</span> <span class="cb-n">0 nodes</span> <span class="cb-t">0 ms</span></div>
      <div class="cb-row cb-actions">
        <button class="cb-think">Think now</button>
        <button class="cb-play">Play best</button>
      </div>
      <div class="cb-log"></div>
    `;
    const style = document.createElement('style');
    style.textContent = `
      #__chess-bot-panel {
        position: fixed; top: 72px; right: 16px; width: 320px; z-index: 100000;
        background: #1f2225; color: #e8ecef; border: 1px solid #3a3f44;
        border-radius: 10px; padding: 10px 12px 12px;
        font-family: 'DM Sans', system-ui, sans-serif; font-size: 13px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.5);
        user-select: none;
      }
      #__chess-bot-panel .cb-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; cursor: move; }
      #__chess-bot-panel .cb-title { font-weight:700; font-size:14px; flex:1; }
      #__chess-bot-panel .cb-close { background:none; border:none; color:#8f9399; font-size:18px; cursor:pointer; }
      #__chess-bot-panel .cb-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
      #__chess-bot-panel .cb-row label { width:48px; color:#8f9399; font-size:11px; text-transform:uppercase; letter-spacing:.5px; }
      #__chess-bot-panel .cb-row select,
      #__chess-bot-panel .cb-row input { flex:1; background:#272b2e; color:#e8ecef; border:1px solid #3a3f44; border-radius:4px; padding:4px 6px; font-size:12px; }
      #__chess-bot-panel .cb-elo-val { width:40px; text-align:right; color:#99c060; font-family:'JetBrains Mono',monospace; font-size:12px; }
      #__chess-bot-panel .cb-evalbar { position:relative; height:18px; background:#111; border-radius:3px; overflow:hidden; margin:8px 0; }
      #__chess-bot-panel .cb-evalfill { position:absolute; left:0; top:0; bottom:0; width:50%; background:linear-gradient(to right,#7fa650,#99c060); transition: width .2s; }
      #__chess-bot-panel .cb-evaltxt { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700; color:#fff; text-shadow:0 0 3px #000; }
      #__chess-bot-panel .cb-section { margin: 6px 0; }
      #__chess-bot-panel .cb-section h4 { font-size:10px; text-transform:uppercase; letter-spacing:.8px; color:#8f9399; margin-bottom:4px; font-weight:600; }
      #__chess-bot-panel .cb-best { font-family:'JetBrains Mono',monospace; font-size:16px; color:#99c060; font-weight:700; }
      #__chess-bot-panel .cb-pv { font-family:'JetBrains Mono',monospace; font-size:11px; color:#e8ecef; line-height:1.5; word-break:break-word; }
      #__chess-bot-panel .cb-threats { list-style:none; padding-left:0; max-height:80px; overflow:auto; }
      #__chess-bot-panel .cb-threats li { font-size:11px; color:#e07b39; padding:2px 0; }
      #__chess-bot-panel .cb-threats li.cb-empty { color:#5c6068; }
      #__chess-bot-panel .cb-stats { display:flex; gap:8px; font-family:'JetBrains Mono',monospace; font-size:10px; color:#8f9399; }
      #__chess-bot-panel .cb-actions button { flex:1; background:#2e3235; color:#e8ecef; border:1px solid #3a3f44; border-radius:4px; padding:6px; cursor:pointer; font-size:12px; }
      #__chess-bot-panel .cb-actions button:hover { background:#363b3f; }
      #__chess-bot-panel .cb-log { margin-top:8px; max-height:70px; overflow:auto; font-family:'JetBrains Mono',monospace; font-size:10px; color:#8f9399; line-height:1.4; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(wrap);
    this.el = wrap;
    this.wireEvents();
    return wrap;
  },

  wireEvents() {
    const el = this.el;
    // drag
    const head = el.querySelector('.cb-head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      el.style.left = (e.clientX - drag.dx) + 'px';
      el.style.top  = (e.clientY - drag.dy) + 'px';
      el.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => drag = null);
    el.querySelector('.cb-close').addEventListener('click', () => {
      window.__chessBotTeardown && window.__chessBotTeardown();
    });
    el.querySelector('.cb-mode').addEventListener('change', (e) => {
      CFG.mode = e.target.value;
      this.log(`mode -> ${CFG.mode}`);
    });
    const eloEl = el.querySelector('.cb-elo');
    const eloVal = el.querySelector('.cb-elo-val');
    eloEl.addEventListener('input', () => {
      CFG.elo = parseInt(eloEl.value, 10);
      eloVal.textContent = eloEl.value;
    });
    el.querySelector('.cb-think').addEventListener('click', () => Controller.think(true));
    el.querySelector('.cb-play').addEventListener('click', () => Controller.playBest());
  },

  log(msg) {
    const el = this.el?.querySelector('.cb-log');
    if (!el) return;
    const d = document.createElement('div');
    const t = new Date().toLocaleTimeString();
    d.textContent = `[${t}] ${msg}`;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
    while (el.childNodes.length > 50) el.removeChild(el.firstChild);
  },

  updateEval(cp) {
    if (!this.el) return;
    const clamp = Math.max(-800, Math.min(800, cp));
    const pct = 50 + (clamp / 800) * 50;
    this.el.querySelector('.cb-evalfill').style.width = pct + '%';
    const sign = cp >= 0 ? '+' : '';
    this.el.querySelector('.cb-evaltxt').textContent =
      Math.abs(cp) > MATE - 1000
        ? `#${Math.ceil((MATE - Math.abs(cp)) / 2) * Math.sign(cp)}`
        : `${sign}${(cp / 100).toFixed(2)}`;
  },

  updateSearch({ best, pv, depth, nodes, qnodes, elapsed, score }) {
    if (!this.el) return;
    this.el.querySelector('.cb-best').textContent = best || '—';
    this.el.querySelector('.cb-pv').textContent = pv || '—';
    this.el.querySelector('.cb-d').textContent = `d=${depth}`;
    this.el.querySelector('.cb-n').textContent = `${nodes + qnodes} nodes`;
    this.el.querySelector('.cb-t').textContent = `${elapsed.toFixed(0)} ms`;
    if (score != null) this.updateEval(score);
  },

  updateThreats(threats) {
    if (!this.el) return;
    const ul = this.el.querySelector('.cb-threats');
    ul.innerHTML = '';
    if (!threats.length) {
      const li = document.createElement('li'); li.className = 'cb-empty';
      li.textContent = 'none'; ul.appendChild(li); return;
    }
    for (const t of threats.slice(0, 6)) {
      const li = document.createElement('li');
      li.textContent = `${t.name} on ${sqToAlg(t.sq)} — ${t.reason} (${t.attackers}a/${t.defenders}d)`;
      ul.appendChild(li);
    }
  },
};

/* ============================== SECTION 10 ============================
 * Controller: orchestrates scraping, thinking, drawing, playing.
 * ===================================================================== */
const Controller = {
  board: null,
  lastFEN: null,
  thinking: false,
  timer: null,
  lastBestMove: null,

  start() {
    Panel.build();
    Arrows.ensure();
    this.tick();
    this.timer = setInterval(() => this.tick(), 800);
    window.addEventListener('resize', () => {
      if (this.lastBestMove) this.drawArrows(this.lastBestMove, this.lastCandidates || [], this.lastThreats || []);
    });
    Panel.log('chess-bot started');
  },

  stop() {
    clearInterval(this.timer);
    Arrows.clear();
    if (this.el?.isConnected) this.el.remove();
  },

  tick() {
    if (CFG.mode === 'off') return;
    if (this.thinking) return;
    const boardEl = ChessCom.findBoardEl();
    if (!boardEl) return;
    const b = ChessCom.buildFEN(this.board);
    if (!b) return;
    const fen = b.toFEN();
    if (fen === this.lastFEN) return;
    this.board = b;
    this.lastFEN = fen;
    Panel.log(`new position: ${fen.split(' ').slice(0,2).join(' ')}`);
    const playerColor = ChessCom.playerColor(boardEl);
    if (b.turn !== playerColor) {
      Panel.log('opponent to move — standing by');
      return;
    }
    this.think();
  },

  async think(manual = false) {
    if (!this.board) return;
    if (this.thinking) return;
    this.thinking = true;
    try {
      const b = this.board.clone();
      const prof = strengthProfile(CFG.elo);
      const targetDepth = Math.min(prof.depth, CFG.maxDepth);

      // Score every legal root move at the target depth so we can both
      // (a) show candidates/arrows and (b) sample by temperature for ELO.
      const t0 = performance.now();
      const legal = generateLegalMoves(b);
      if (!legal.length) { Panel.log('no legal moves'); return; }
      const rootScores = [];
      const perMoveBudget = Math.max(50, prof.timeMs / Math.max(1, legal.length));
      let totalNodes = 0, totalQ = 0, bestPV = [];
      for (const mv of legal) {
        b.make(mv);
        const s = new Searcher(b);
        const childDepth = Math.max(1, targetDepth - 1);
        const r = s.searchIterative(childDepth, perMoveBudget);
        b.unmake();
        const score = -r.score;
        totalNodes += r.nodes; totalQ += r.qnodes;
        rootScores.push({ move: mv, score, childPV: r.pv });
      }
      rootScores.sort((a, c) => c.score - a.score);
      const bestEntry = rootScores[0];
      const bestScore = bestEntry.score;

      // ELO-based selection: sample among moves weighted by centipawn loss.
      let chosenMove = sampleByTemperature(rootScores, prof.temperature) || bestEntry.move;

      // Blunder injection: at very low ELO, occasionally pick a much-worse
      // but still legal move (mimics true beginner oversights).
      if (Math.random() < prof.blunderProb && rootScores.length > 1) {
        const worst = rootScores.slice(Math.ceil(rootScores.length * 0.6));
        if (worst.length) {
          chosenMove = worst[Math.floor(Math.random() * worst.length)].move;
        }
      }

      // Build SAN PV for DISPLAY — always show the engine's true best line
      // even when the bot intends to play a weaker move (so the reasoning
      // panel is honest about what "best" is).
      const sanPV = [];
      const tmp = b.clone();
      const pvForDisplay = [bestEntry.move, ...bestEntry.childPV];
      for (const m of pvForDisplay) {
        try { sanPV.push(moveToSan(tmp, m)); tmp.make(m); } catch { break; }
      }
      const elapsed = performance.now() - t0;

      const chosenEntry = rootScores.find(r => r.move === chosenMove) || bestEntry;
      const chosenSan = (() => {
        const tb = b.clone();
        try { return moveToSan(tb, chosenMove); } catch { return moveToUci(chosenMove); }
      })();

      Panel.updateSearch({
        best: chosenMove === bestEntry.move
          ? `${sanPV[0] || moveToUci(bestEntry.move)}  (${sqToAlg(bestEntry.move.from)}→${sqToAlg(bestEntry.move.to)})`
          : `${chosenSan}  [engine best: ${sanPV[0]}, ${((bestScore - chosenEntry.score)/100).toFixed(2)} worse]`,
        pv: sanPV.join(' '),
        depth: targetDepth, nodes: totalNodes, qnodes: totalQ, elapsed, score: bestScore,
      });

      // Candidates = next N after best
      const candidates = rootScores.slice(1, 1 + CFG.candidateCount).map(r => r.move);

      // Threats
      const threats = findThreats(b, b.turn);
      Panel.updateThreats(threats);

      this.lastBestMove = chosenMove;
      this.lastCandidates = candidates;
      this.lastThreats = threats;
      this.drawArrows(chosenMove, candidates, threats);

      if (CFG.mode === 'autonomous' && !manual) {
        setTimeout(() => this.playBest(), CFG.autoPlayDelayMs);
      }
    } catch (err) {
      console.error(err);
      Panel.log('error: ' + err.message);
    } finally {
      this.thinking = false;
    }
  },

  findCandidates(b, best, n) {
    const moves = generateLegalMoves(b);
    const scored = [];
    for (const m of moves) {
      if (m.from === best.from && m.to === best.to && m.promo === best.promo) continue;
      b.make(m);
      const s = new Searcher(b);
      const res = s.searchIterative(Math.max(1, CFG.defaultDepth - 2), 250);
      b.unmake();
      scored.push({ m, score: -res.score });
    }
    scored.sort((a, c) => c.score - a.score);
    return scored.slice(0, n).map(x => x.m);
  },

  drawArrows(best, candidates, threats) {
    const arrows = [];
    arrows.push({ from: best.from, to: best.to, kind: 'best' });
    if (CFG.drawCandidates) {
      for (const c of candidates) arrows.push({ from: c.from, to: c.to, kind: 'cand' });
    }
    if (CFG.drawThreats) {
      // For each hanging piece, draw red arrow from its attacker to it.
      const us = this.board.turn;
      for (const t of threats) {
        // Find one attacker square
        const oppColor = -us;
        const attSq = this.findAttackerSquare(this.board, t.sq, oppColor);
        if (attSq >= 0) arrows.push({ from: attSq, to: t.sq, kind: 'threat' });
      }
    }
    Arrows.draw(arrows);
    Arrows.highlightSquares(threats.map(t => t.sq), 'rgba(230,80,80,0.28)');
  },

  findAttackerSquare(b, target, byColor) {
    // Return first attacker square we find.
    for (let s = 0; s < 64; s++) {
      const p = b.sq[s];
      if (p === 0 || colorOf(p) !== byColor) continue;
      const saved = b.turn;
      b.turn = byColor;
      const moves = generatePseudoMoves(b).filter(m => m.from === s && m.to === target);
      b.turn = saved;
      if (moves.length) return s;
    }
    return -1;
  },

  async playBest() {
    if (!this.lastBestMove) { Panel.log('no move to play'); return; }
    Panel.log(`playing ${sqToAlg(this.lastBestMove.from)}→${sqToAlg(this.lastBestMove.to)}`);
    const ok = await ChessCom.playMove(this.lastBestMove);
    if (!ok) Panel.log('playMove failed (chess.com DOM may have changed)');
  },
};

/* ============================== SECTION 11 ============================
 * Bootstrap
 * ===================================================================== */
window.__chessBotTeardown = () => {
  try { Controller.stop(); } catch {}
  try { Panel.el?.remove(); } catch {}
  try { Arrows.svg?.remove(); } catch {}
  window.__chessBotLoaded = false;
};

Controller.start();

// Expose a handful of internals for debugging.
window.__chessBot = {
  Board, Searcher, ChessCom, Arrows, Panel, Controller,
  generateLegalMoves, evaluate, findThreats,
};

console.log('%cchess-bot loaded', 'color:#99c060;font-weight:700;font-size:14px');
console.log('window.__chessBot for internals; Controller.think() to force a search');

})();
