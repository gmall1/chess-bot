// Pure-logic smoke test. Strips the DOM parts of chess-bot.js and runs
// perft + a short search against a known position.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.window = {};
globalThis.document = { createElementNS: () => ({}), createElement: () => ({ appendChild(){}, setAttribute(){}, style:{}, addEventListener(){}, querySelector(){}, classList:{add(){}}, remove(){} }), head:{appendChild(){}}, body:{appendChild(){}}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
globalThis.MouseEvent = class {};
globalThis.getComputedStyle = () => ({ position: 'static' });

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'chess-bot.js'), 'utf8');
// Strip Controller.start() auto-invocation tail by wrapping the IIFE and
// exposing internals.
const patched = src.replace('Controller.start();', '// Controller.start() disabled in tests');
// Evaluate in a function scope and grab internals via window.__chessBot
const run = new Function('window', patched + '\nreturn window.__chessBot;');
const api = run(globalThis.window);
const { Board, Searcher, generateLegalMoves, evaluate, findThreats } = api;

function perft(b, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of generateLegalMoves(b)) {
    b.make(m); n += perft(b, depth - 1); b.unmake();
  }
  return n;
}

let failed = 0;
function assertEq(actual, expected, label) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${actual} expected=${expected}`);
  if (!ok) failed++;
}

// Perft from starting position
const start = Board.fromFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
assertEq(perft(start, 1), 20, 'perft(start,1)');
assertEq(perft(start, 2), 400, 'perft(start,2)');
assertEq(perft(start, 3), 8902, 'perft(start,3)');

// Kiwipete (well-known perft position)
const kiwi = Board.fromFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
assertEq(perft(kiwi, 1), 48, 'perft(kiwipete,1)');
assertEq(perft(kiwi, 2), 2039, 'perft(kiwipete,2)');

// Search: in starting position, something reasonable should come back
const s = new Searcher(start.clone());
const r = s.searchIterative(3, 2000);
console.log(`search: depth=${r.depth} nodes=${r.nodes} pv=${r.pv.length} score=${r.score}`);
if (!r.pv.length) { console.log('FAIL  empty PV'); failed++; } else console.log('PASS  got a best move');

// Threat detection sanity: white queen on e5 attacked by black rook on e8,
// nothing defending -> queen is hanging.
const hang = Board.fromFEN('4r2k/8/8/4Q3/8/8/8/4K3 w - - 0 1');
const threats = findThreats(hang, 1);
console.log('threats:', threats.map(t => `${t.name}@${t.sq}:${t.reason}`));
if (!threats.some(t => t.name === 'queen')) { console.log('FAIL  queen threat not detected'); failed++; }
else console.log('PASS  threat detection');

// Tactical: mate in 1 — "back-rank" style. White to move, Qh7#.
// White queen on h3, black king h8, black pawns block on g7/h7? keep simple:
// White Qa1, black Kh1 in the corner, white Rb1 (pins nothing), white Ka3.
// Use classic: 8/8/8/8/8/8/R7/k6K w - - 0 1  -> Rh2# no. Use well-known:
// "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1"  -> Ra8#
const m1 = Board.fromFEN('6k1/5ppp/8/8/8/8/8/R6K w - - 0 1');
const sm1 = new Searcher(m1).searchIterative(4, 2000);
const uci = (mv) => {
  const f = mv.from & 7, r = mv.from >> 3, tf = mv.to & 7, tr = mv.to >> 3;
  return String.fromCharCode(97+f)+(r+1)+String.fromCharCode(97+tf)+(tr+1);
};
const move = sm1.pv[0];
console.log(`mate-in-1 best=${move ? uci(move) : 'none'} score=${sm1.score}`);
if (!move || uci(move) !== 'a1a8') { console.log('FAIL  mate-in-1 not found'); failed++; }
else console.log('PASS  mate-in-1');

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
