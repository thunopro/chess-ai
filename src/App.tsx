// src/App.tsx — AI minimax + worker with safe fallback (react-chessboard v4)
import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'

type AiMode = 'random' | 'greedy' | 'minimax'
type MoveObj = { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }

const VAL: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 }

// ===== Main-thread AI (fallback) =====
function toShort(m: any): MoveObj {
  return m.promotion ? { from: m.from, to: m.to, promotion: m.promotion } : { from: m.from, to: m.to }
}

function randomPick(game: Chess): MoveObj | null {
  const ms = game.moves({ verbose: true }) as any[]
  if (!ms.length) return null
  return toShort(ms[Math.floor(Math.random() * ms.length)])
}

function greedyPick(game: Chess): MoveObj | null {
  const ms = game.moves({ verbose: true }) as any[]
  if (!ms.length) return null
  let best: any = null, bestScore = -1e15
  for (const m of ms) {
    let s = 0
    if (m.captured) s += (VAL[m.captured] ?? 0) - (VAL[m.piece] ?? 0) + 1
    const san: string = m.san
    if (san.includes('#')) s += 1e9
    else if (san.includes('+')) s += 5
    if (s > bestScore) { bestScore = s; best = m }
  }
  return best ? toShort(best) : toShort(ms[Math.floor(Math.random() * ms.length)])
}

function evaluate(game: Chess): number {
  const board = game.board()
  let score = 0
  for (const row of board) for (const sq of row) {
    if (!sq) continue
    const v = VAL[sq.type] ?? 0
    score += sq.color === 'w' ? v : -v
  }
  const turn = game.turn()
  const legal = game.moves().length
  score += (turn === 'w' ? 1 : -1) * Math.min(legal, 30)
  if (game.inCheck()) score += (turn === 'w' ? -15 : 15)
  if (game.isCheckmate()) return turn === 'w' ? -1e9 : 1e9
  if (game.isDraw() || game.isStalemate() || game.isInsufficientMaterial() || game.isThreefoldRepetition()) return 0
  return score
}

function minimaxPickMain(game: Chess, depthLimit: number, aiColor: 'w' | 'b'): MoveObj | null {
  const root = game.moves({ verbose: true }) as any[]
  if (!root.length) return null
  const aiWhite = aiColor === 'w'

  function search(depth: number, alpha: number, beta: number): number {
    if (depth === 0 || game.isGameOver()) return evaluate(game)
    const mv = game.moves({ verbose: true }) as any[]
    if (!mv.length) return evaluate(game)

    if (game.turn() === 'w') {
      let val = -Infinity
      for (const m of mv) {
        game.move(toShort(m))
        const child = search(depth - 1, alpha, beta)
        game.undo()
        val = Math.max(val, child)
        alpha = Math.max(alpha, val)
        if (alpha >= beta) break
      }
      return val
    } else {
      let val = Infinity
      for (const m of mv) {
        game.move(toShort(m))
        const child = search(depth - 1, alpha, beta)
        game.undo()
        val = Math.min(val, child)
        beta = Math.min(beta, val)
        if (alpha >= beta) break
      }
      return val
    }
  }

  let best: any = null
  let bestScore = aiWhite ? -Infinity : Infinity
  for (const m of root) {
    game.move(toShort(m))
    const v = search(depthLimit - 1, -Infinity, Infinity)
    game.undo()
    if (aiWhite ? v > bestScore : v < bestScore) { bestScore = v; best = m }
  }
  return best ? toShort(best) : null
}

// ===== React component =====
export default function App() {
  const gameRef = useRef(new Chess())
  const thinkingRef = useRef(false)

  const [fen, setFen] = useState(gameRef.current.fen())
  const [boardWidth, setBoardWidth] = useState(Math.min(520, Math.floor(window.innerWidth * 0.9)))

  const [playVsAI, setPlayVsAI] = useState(true)
  const [aiPlays, setAiPlays] = useState<'white' | 'black'>('black')
  const [aiMode, setAiMode] = useState<AiMode>('minimax')
  const [depth, setDepth] = useState(3)
  const [isThinking, setIsThinking] = useState(false)

  // Worker
  const workerRef = useRef<Worker | null>(null)
  const reqIdRef = useRef(0)

  useEffect(() => {
    try {
      const w = new Worker(new URL('./engine/ai.worker.ts', import.meta.url), { type: 'module' })
      workerRef.current = w
      w.onmessage = (e: MessageEvent<{ id: number; move: MoveObj | null }>) => {
        if (e.data.id !== reqIdRef.current) return
        const { move } = e.data
        if (move) {
          const ok = gameRef.current.move(move)
          if (ok) setFen(gameRef.current.fen())
        }
        setIsThinking(false)
        thinkingRef.current = false
      }
      w.onerror = () => {
        // sẽ fallback
        setIsThinking(false)
        thinkingRef.current = false
      }
      return () => { w.terminate(); workerRef.current = null }
    } catch {
      // nếu trình duyệt không tạo được worker thì thôi, dùng fallback
      workerRef.current = null
    }
  }, [])

  const updateFen = () => setFen(gameRef.current.fen())

  function resetGame() {
    gameRef.current.reset()
    updateFen()
    maybeAIMove()
  }

  function requestAiMoveWithFallback() {
    const aiColor: 'w' | 'b' = aiPlays === 'white' ? 'w' : 'b'
    const g = new Chess(gameRef.current.fen())

    const doFallback = () => {
      let move: MoveObj | null = null
      if (aiMode === 'random') move = randomPick(g)
      else if (aiMode === 'greedy') move = greedyPick(g)
      else move = minimaxPickMain(g, depth, aiColor)

      if (move) {
        const ok = gameRef.current.move(move)
        if (ok) setFen(gameRef.current.fen())
      }
      setIsThinking(false)
      thinkingRef.current = false
    }

    const w = workerRef.current
    if (!w) { setTimeout(doFallback, 0); return }

    const id = ++reqIdRef.current
    w.postMessage({ id, fen: g.fen(), mode: aiMode, depth, aiColor })

    // nếu sau 2.5s chưa trả lời → fallback
    setTimeout(() => {
      if (!thinkingRef.current) return
      doFallback()
    }, 2500)
  }

  function maybeAIMove() {
    const game = gameRef.current
    const aiTurn = aiPlays === 'white' ? 'w' : 'b'
    if (!playVsAI || game.isGameOver() || game.turn() !== aiTurn) return
    if (thinkingRef.current) return
    thinkingRef.current = true
    setIsThinking(true)
    requestAiMoveWithFallback()
  }

  function onDrop(source: string, target: string) {
    if (isThinking) return false
    const mv = gameRef.current.move({ from: source, to: target, promotion: 'q' })
    if (!mv) return false
    updateFen()
    maybeAIMove()
    return true
  }

  useEffect(() => {
    const onResize = () => setBoardWidth(Math.min(520, Math.floor(window.innerWidth * 0.9)))
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    maybeAIMove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playVsAI, aiPlays, aiMode, depth])

  const status = useMemo(() => {
    const g = gameRef.current
    if (g.isCheckmate()) return 'Checkmate'
    if (g.isDraw()) return 'Draw'
    if (g.isStalemate()) return 'Stalemate'
    if (g.isThreefoldRepetition()) return 'Threefold repetition'
    if (g.isInsufficientMaterial()) return 'Insufficient material'
    if (g.inCheck()) return `${g.turn() === 'w' ? 'White' : 'Black'} in check`
    return `${g.turn() === 'w' ? 'White' : 'Black'} to move`
  }, [fen])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Chessboard
          position={fen}
          onPieceDrop={onDrop}
          boardWidth={boardWidth}
          arePiecesDraggable={!isThinking}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={resetGame} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ddd' }}>
              New Game
            </button>
            <button onClick={() => setPlayVsAI(v => !v)} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ddd' }}>
              Mode: {playVsAI ? 'Human vs AI' : 'Human vs Human'}
            </button>
            {playVsAI && (
              <>
                <button onClick={() => setAiPlays(s => (s === 'black' ? 'white' : 'black'))} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ddd' }}>
                  AI plays: {aiPlays}
                </button>
                <button
                  onClick={() => setAiMode(m => (m === 'minimax' ? 'greedy' : m === 'greedy' ? 'random' : 'minimax'))}
                  style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #ddd' }}
                >
                  AI mode: {aiMode}
                </button>
                {aiMode === 'minimax' && (
                  <select value={depth} onChange={e => setDepth(Number(e.target.value))} style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid #ddd' }}>
                    <option value={2}>Depth 2</option>
                    <option value={3}>Depth 3</option>
                    <option value={4}>Depth 4</option>
                  </select>
                )}
              </>
            )}
          </div>
          <span style={{ fontSize: 14, opacity: 0.8 }}>
            {isThinking ? '🤖 thinking…' : status}
          </span>
        </div>
      </div>
    </div>
  )
}
