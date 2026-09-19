/* ═══════════════════════════════════════════════════════════════════
   N.E.X.U.S. WATCH — GAMES  v1.0.0
   Tic-Tac-Toe, Snake, 2048 — headless engines, ready to render.
   Depends on: nexus-watch-core.js
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';
  const W = global.NexusWatch;
  if (!W) { console.error('[Games] core not loaded'); return; }
  const { Bus, Haptics, Storage } = W;

  // ═══════════════════════════════════════════════════════════════
  // 1. TIC-TAC-TOE
  // ═══════════════════════════════════════════════════════════════
  const TicTacToe = (() => {
    let board, turn, winner, over;

    function reset() {
      board = Array(9).fill('');
      turn = 'X';
      winner = null;
      over = false;
      emit();
    }

    function emit() {
      Bus.emit('ttt:update', { board: board.slice(), turn, winner, over });
    }

    function move(i) {
      if (over || i < 0 || i > 8 || board[i]) return false;
      board[i] = turn;
      if (checkWin(turn)) { winner = turn; over = true; Haptics.success(); }
      else if (board.every(c => c)) { winner = 'draw'; over = true; Haptics.double(); }
      else turn = turn === 'X' ? 'O' : 'X';
      emit();
      return true;
    }

    function checkWin(p) {
      const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      return lines.some(([a,b,c]) => board[a] === p && board[b] === p && board[c] === p);
    }

    function aiMove() {
      if (over) return;
      const best = minimax(board.slice(), 'O');
      move(best.index);
    }

    function minimax(b, player) {
      if (checkWinBoard(b, 'X')) return { score: -10 };
      if (checkWinBoard(b, 'O')) return { score: 10 };
      if (b.every(c => c)) return { score: 0 };

      const moves = [];
      for (let i = 0; i < 9; i++) {
        if (b[i]) continue;
        b[i] = player;
        const r = minimax(b, player === 'O' ? 'X' : 'O');
        moves.push({ index: i, score: r.score });
        b[i] = '';
      }
      if (player === 'O') {
        return moves.reduce((a, m) => m.score > a.score ? m : a);
      } else {
        return moves.reduce((a, m) => m.score < a.score ? m : a);
      }
    }

    function checkWinBoard(b, p) {
      const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      return lines.some(([a,c,d]) => b[a] === p && b[c] === p && b[d] === p);
    }

    reset();
    return { reset, move, aiMove, get board() { return board.slice(); }, get state() { return { turn, winner, over }; } };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 2. SNAKE
  // ═══════════════════════════════════════════════════════════════
  const Snake = (() => {
    const COLS = 12, ROWS = 12;
    let snake, dir, nextDir, food, over, score, timer, speedMs;

    function reset() {
      snake = [{ x: 6, y: 6 }, { x: 5, y: 6 }, { x: 4, y: 6 }];
      dir = { x: 1, y: 0 };
      nextDir = dir;
      score = 0;
      over = false;
      speedMs = 220;
      placeFood();
      emit();
    }

    function placeFood() {
      do {
        food = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
      } while (snake.some(s => s.x === food.x && s.y === food.y));
    }

    function emit() {
      Bus.emit('snake:update', { snake: snake.slice(), food, score, over, cols: COLS, rows: ROWS });
    }

    function setDir(x, y) {
      if (x === -dir.x && y === -dir.y) return;   // no 180
      nextDir = { x, y };
    }

    function step() {
      if (over) return;
      dir = nextDir;
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) return die();
      if (snake.some(s => s.x === head.x && s.y === head.y)) return die();
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score++;
        Haptics.tap();
        placeFood();
        if (speedMs > 90) speedMs -= 8;
      } else {
        snake.pop();
      }
      emit();
    }

    function die() {
      over = true;
      Haptics.error();
      Bus.emit('snake:over', { score });
      stop();
      emit();
    }

    function start() {
      if (timer) return;
      reset();
      timer = setInterval(step, speedMs);
      // reduce interval dynamically
      const tick = setInterval(() => {
        if (!timer || over) return clearInterval(tick);
        clearInterval(timer);
        timer = setInterval(step, speedMs);
      }, 500);
    }

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    reset();
    return { start, stop, reset, setDir, get score() { return score; }, get over() { return over; } };
  })();

  // ═══════════════════════════════════════════════════════════════
  // 3. 2048
  // ═══════════════════════════════════════════════════════════════
  const Game2048 = (() => {
    const SIZE = 4;
    const STORAGE_KEY = 'games.2048.best';
    let grid, score, over, won;
    let best = Storage.get(STORAGE_KEY, 0);

    function reset() {
      grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
      score = 0;
      over = false;
      won = false;
      spawn(); spawn();
      emit();
    }

    function spawn() {
      const empties = [];
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!grid[r][c]) empties.push({ r, c });
      if (!empties.length) return;
      const cell = empties[Math.floor(Math.random() * empties.length)];
      grid[cell.r][cell.c] = Math.random() < 0.9 ? 2 : 4;
    }

    function emit() {
      Bus.emit('g2048:update', { grid: grid.map(r => r.slice()), score, best, over, won });
    }

    function slide(row) {
      const arr = row.filter(v => v);
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === arr[i + 1]) {
          out.push(arr[i] * 2);
          score += arr[i] * 2;
          if (arr[i] * 2 === 2048) won = true;
          i++;
        } else {
          out.push(arr[i]);
        }
      }
      while (out.length < SIZE) out.push(0);
      return out;
    }

    function move(dir) {
      if (over) return;
      const before = JSON.stringify(grid);
      if (dir === 'left')  grid = grid.map(slide);
      if (dir === 'right') grid = grid.map(r => slide(r.slice().reverse()).reverse());
      if (dir === 'up')    transpose().map(slide) && (grid = untranspose());
      if (dir === 'down')  transpose().map(r => slide(r.slice().reverse()).reverse()) && (grid = untranspose());
      if (JSON.stringify(grid) === before) return;
      spawn();
      if (!canMove()) { over = true; Haptics.error(); }
      else Haptics.tap();
      if (score > best) { best = score; Storage.set(STORAGE_KEY, best); }
      emit();
    }

    function transpose() {
      const t = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) t[c][r] = grid[r][c];
      grid = t;
      return grid;
    }
    function untranspose() { return transpose(); }

    function canMove() {
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        if (!grid[r][c]) return true;
        if (c < SIZE - 1 && grid[r][c] === grid[r][c + 1]) return true;
        if (r < SIZE - 1 && grid[r][c] === grid[r + 1][c]) return true;
      }
      return false;
    }

    reset();
    return { reset, move, get grid() { return grid.map(r => r.slice()); }, get score() { return score; }, get best() { return best; }, get over() { return over; } };
  })();

  W.Games = { TicTacToe, Snake, Game2048 };
  console.log('✅ NexusWatch games loaded');
})(window);
