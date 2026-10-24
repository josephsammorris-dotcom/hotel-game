/* Plays many computer-vs-computer games and checks the rules never break. */
const E = require('../src/engine.js');
const Bots = require('../src/bots.js');
const board = require('../src/board-1986.js');

const GAMES = +process.argv[2] || 2000;
const CAP = 3000; // player-turns before a game is called a stalemate

function invariants(state, s0) {
  for (const p of state.players) if (p.cash < 0) throw new Error(`${p.name} has negative cash`);
  const onRoad = state.players.filter(p => p.active && p.pos >= 0).map(p => p.pos);
  if (new Set(onRoad).size !== onRoad.length) throw new Error('two cars on one space');
  for (const sp in state.entrances) {
    const id = state.entrances[sp], plot = state.plots[id];
    if (plot.owner === null || plot.built === 0) throw new Error(`entrance on ${sp} for unbuilt/unowned ${id}`);
    const b = E.bordering(board, id); if (!b.includes(+sp)) throw new Error(`entrance ${sp} does not border ${id}`);
  }
  for (const id in state.plots) {
    const plot = state.plots[id];
    if (plot.owner !== null && !state.players[plot.owner].active) throw new Error(`${id} owned by a bankrupt player`);
    if (plot.built > E.buildings(board, id) || plot.built < 0) throw new Error(`${id} built out of range`);
    if (plot.facilities && plot.built !== E.buildings(board, id)) throw new Error(`${id} facilities before buildings`);
  }
  const cash = state.players.reduce((a, p) => a + p.cash, 0);
  const expected = s0 + state.bank.paidOut - state.bank.takenIn;
  if (cash !== expected) throw new Error(`money leak: cash ${cash} expected ${expected}`);
}

const stats = { games: 0, wins: [0, 0, 0, 0], turns: [], stalemates: 0, actions: 0, spins: { green: 0, red: 0, H: 0, '2': 0 }, hotelWins: {}, hotelOwned: {}, auctions: 0, demolished: 0, longest: 0 };
for (const id in board.hotels) { stats.hotelWins[id] = 0; stats.hotelOwned[id] = 0; }

for (let g = 0; g < GAMES; g++) {
  const n = 2 + (g % 3);
  const autoClaim = g % 4 !== 3;
  const state = E.createGame(board, { seed: 1000 + g, autoClaim, players: Array.from({ length: n }, (_, i) => ({ name: 'Bot ' + (i + 1), ai: 'easy' })) });
  const s0 = n * 12000;
  let rnd = (() => { let a = 77 + g; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  try {
    while (state.winner === null && state.turn < CAP) {
      const acts = E.legalActions(state, board);
      if (!acts.length) throw new Error('no legal actions in phase ' + state.phase);
      const a = Bots.choose('easy', state, board, acts, rnd);
      const ev = E.apply(state, board, a);
      stats.actions++;
      for (const e of ev) {
        if (e.type === 'spin') stats.spins[e.result]++;
        if (e.type === 'auctionStart') stats.auctions++;
        if (e.type === 'demolished') stats.demolished++;
      }
      invariants(state, s0);
    }
  } catch (err) {
    console.error(`Game ${g} (seed ${1000 + g}, ${n} players, autoClaim ${autoClaim}) failed at turn ${state.turn}, phase ${state.phase}:`, err.message);
    console.error(state.log.slice(-12).join('\n'));
    process.exit(1);
  }
  stats.games++;
  if (state.winner === null) stats.stalemates++;
  else { stats.wins[state.winner]++; for (const id of E.ownedPlots(state, state.winner)) stats.hotelWins[id]++; }
  for (const id in state.plots) if (state.plots[id].owner !== null) stats.hotelOwned[id]++;
  stats.turns.push(state.turn); if (state.turn > stats.longest) stats.longest = state.turn;
}

stats.turns.sort((a, b) => a - b);
const q = f => stats.turns[Math.floor(f * (stats.turns.length - 1))];
console.log(`Played ${stats.games} games, ${stats.actions} actions, no rule violations.`);
console.log(`Player-turns per game: median ${q(0.5)}, 10th pct ${q(0.1)}, 90th pct ${q(0.9)}, longest ${stats.longest}. Stalemates (hit ${CAP}-turn cap): ${stats.stalemates}`);
console.log(`Wins by seat: ${stats.wins.join(' / ')} (seat order is random-start, so these should be close)`);
console.log(`Spinner: ${JSON.stringify(stats.spins)}  Auctions: ${stats.auctions}  Knocked down: ${stats.demolished}`);
console.log('Hotel held by the winner at the end (share of decided games):');
for (const id in stats.hotelWins) console.log(`  ${board.hotels[id].name.padEnd(10)} ${(100 * stats.hotelWins[id] / Math.max(1, stats.games - stats.stalemates)).toFixed(0).padStart(3)}%   owned at end in ${(100 * stats.hotelOwned[id] / stats.games).toFixed(0)}% of games`);
