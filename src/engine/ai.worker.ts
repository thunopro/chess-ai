/// <reference lib="webworker" />
import { Chess } from 'chess.js';

type Req = {
  id: number;
  fen: string;
  mode: 'random' | 'greedy' | 'minimax';
  depth: number;
  aiColor: 'w' | 'b';
};

type MoveObj = { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' };
type Res = { id: number; move: MoveObj | null };

const VAL: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// helpers
function toShort(m: any): MoveObj {
  // chỉ đính kèm promotion nếu thực sự là nước phong cấp
  return m.promotion ? { from: m.from, to: m.to, promotion: m.promotion } : { from: m.from, to: m.to };
}

function randomPicker(game: Chess): MoveObj | null {
  const moves = game.moves({ verbose: true }) as any[];
  if (!moves.length) return null;
  return toShort(moves[Math.floor(Math.random() * moves.length)]);
}

function greedyPicker(game: Chess): MoveObj | null {
  const moves = game.moves({ verbose: true }) as any[];
  if (!moves.length) return null;

  let best: any = null, bestScore = -1e15;
  for (const m of moves) {
    let s = 0;
    if (m.captured) s += (VAL[m.captured] ?? 0) - (VAL[m.piece] ?? 0) + 1;
    const san: string = m.san;
    if (san.includes('#')) s += 1e9; else if (san.includes('+')) s += 5;
    if (s > bestScore) { bestScore = s; best = m; }
  }
  if (best) return toShort(best);
  return toShort(moves[Math.floor(Math.random() * moves.length)]);
}

// evaluate: vật chất + mobility nhỏ + phạt/ thưởng check, mate/draw
function evaluate(game: Chess): number {
  const board = game.board();
  let score = 0;
  for (const row of board) for (const sq of row) {
    if (!sq) continue;
    const v = VAL[sq.type] ?? 0;
    score += sq.color === 'w' ? v : -v;
  }
  const turn = game.turn();
  const legal = game.moves().length;
  score += (turn === 'w' ? 1 : -1) * Math.min(legal, 30);

  if (game.inCheck()) score += (turn === 'w' ? -15 : 15);
  if (game.isCheckmate()) return turn === 'w' ? -1e9 : 1e9;
  if (game.isDraw() || game.isStalemate() || game.isInsufficientMaterial() || game.isThreefoldRepetition()) return 0;
  return score;
}

function minimaxPick(game: Chess, depthLimit: number, aiColor: 'w' | 'b'): MoveObj | null {
  const root = game.moves({ verbose: true }) as any[];
  if (!root.length) return null;
  const aiIsWhite = (aiColor === 'w');

  function search(depth: number, alpha: number, beta: number): number {
    if (depth === 0 || game.isGameOver()) return evaluate(game);
    const mv = game.moves({ verbose: true }) as any[];
    if (!mv.length) return evaluate(game);

    if (game.turn() === 'w') {
      let val = -Infinity;
      for (const m of mv) {
        game.move(toShort(m));                 // ⬅️ dùng object ngắn
        const child = search(depth - 1, alpha, beta);
        game.undo();
        val = Math.max(val, child);
        alpha = Math.max(alpha, val);
        if (alpha >= beta) break;
      }
      return val;
    } else {
      let val = Infinity;
      for (const m of mv) {
        game.move(toShort(m));                 // ⬅️ dùng object ngắn
        const child = search(depth - 1, alpha, beta);
        game.undo();
        val = Math.min(val, child);
        beta = Math.min(beta, val);
        if (alpha >= beta) break;
      }
      return val;
    }
  }

  let best: any = null;
  let bestScore = aiIsWhite ? -Infinity : Infinity;

  for (const m of root) {
    game.move(toShort(m));                     // ⬅️ dùng object ngắn
    const v = search(depthLimit - 1, -Infinity, Infinity);
    game.undo();
    if (aiIsWhite ? v > bestScore : v < bestScore) {
      bestScore = v; best = m;
    }
  }
  return best ? toShort(best) : null;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, fen, mode, depth, aiColor } = e.data;
  const game = new Chess(fen);

  let move: MoveObj | null = null;
  if (mode === 'random') move = randomPicker(game);
  else if (mode === 'greedy') move = greedyPicker(game);
  else move = minimaxPick(game, depth, aiColor);

  (self as any).postMessage({ id, move } as Res);
};
