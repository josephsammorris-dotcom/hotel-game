/* Hotel (MB 1986) — rules engine. No graphics. Works in Node and the browser.
 *
 * The engine is a state machine. `legalActions(state, board)` lists what can be done now,
 * `apply(state, board, action)` performs one of them (mutating state) and returns a list of
 * events describing what happened. Every random number comes from a seeded generator stored
 * in the state, so a game can be replayed exactly from its seed and action list.
 *
 * Phases (state.phase):
 *   roll        current player rolls the number die
 *   stay        a guest rolls for nights and pays
 *   townHall    buy one entrance per eligible hotel (after passing the Town Hall line)
 *   buy         buying space: buy the plot on one side
 *   build       planning permission space: declare what to build
 *   spin        spin the planning permission spinner
 *   freeEntrance / freeBuild   the two free spaces
 *   end         buy leisure facilities, then end the turn
 *   raise       a player who cannot pay must put a hotel up for auction
 *   auction     bidding
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.HotelEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SPINNER = ['green', 'green', 'green', 'red', 'H', '2'];
  const MOVER_PHASES = ['buy', 'build', 'freeEntrance', 'freeBuild', 'end'];
  const fmt = n => n.toLocaleString('en-GB');

  // ---------- random ----------
  function rand(state) {
    state.rng = (state.rng + 0x6D2B79F5) | 0;
    let t = Math.imul(state.rng ^ (state.rng >>> 15), 1 | state.rng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const d6 = state => 1 + Math.floor(rand(state) * 6);
  const spin = state => SPINNER[Math.floor(rand(state) * 6)];

  // ---------- setup ----------
  function createGame(board, opts) {
    opts = opts || {};
    const seed = (opts.seed === undefined ? (Math.random() * 2 ** 31) | 0 : opts.seed) | 0;
    const players = (opts.players || [{}, {}]).map((p, i) => ({
      id: i, name: p.name || 'Player ' + (i + 1), ai: p.ai || null,
      cash: opts.startingCash || 12000, pos: -1, active: true
    }));
    if (players.length < 2 || players.length > 4) throw new Error('2 to 4 players');
    const plots = {};
    for (const id in board.hotels) plots[id] = { owner: null, built: 0, facilities: false, boughtTurn: -1 };
    const state = {
      version: 1, seed, rng: seed, autoClaim: opts.autoClaim !== false,
      players, startingPlayers: players.length, plots, entrances: {},
      turn: 0, current: 0, phase: 'roll', queue: [], pending: {}, claims: {},
      extraTurn: false, debt: null, auction: null, winner: null, quiet: 0,
      log: [], bank: { paidOut: 0, takenIn: 0 }
    };
    // Highest roll starts.
    let best = -1;
    players.forEach(p => { const r = d6(state); if (r > best) { best = r; state.current = p.id; } });
    if (opts.first !== undefined) state.current = opts.first;
    push(state, [], `${cur(state).name} rolled highest and starts.`);
    return state;
  }

  // ---------- helpers ----------
  const cur = s => s.players[s.current];
  const active = s => s.players.filter(p => p.active);
  const bankPays = s => !(s.startingPlayers > 2 && active(s).length === 2);
  const buildings = (board, id) => board.hotels[id].stages.length - 1;
  const facilityCost = (board, id) => board.hotels[id].stages[board.hotels[id].stages.length - 1][1];
  const ownedPlots = (s, pid) => Object.keys(s.plots).filter(id => s.plots[id].owner === pid);
  const bordering = (board, id) => board.spaces.filter(sp => sp.inner === id || sp.outer === id).map(sp => sp.i);
  const freeSpaces = (board, s, id) => bordering(board, id).filter(i => s.entrances[i] === undefined);
  function costOf(board, id, from, k) {
    let c = 0; for (let j = from; j < from + k; j++) c += board.hotels[id].stages[j][1]; return c;
  }
  function nightlyRate(board, s, id) {
    const h = board.hotels[id], p = s.plots[id];
    if (p.built === 0) return 0;
    return p.facilities ? h.stages[h.stages.length - 1][2] : h.stages[p.built - 1][2];
  }
  function stars(board, s, id) { // star rating shown on deeds: buildings built + facilities
    const p = s.plots[id]; return p.built + (p.facilities ? 1 : 0);
  }
  function push(state, ev, text, extra) {
    const e = Object.assign({ text }, extra || {});
    ev.push(e); state.log.push(text); if (state.log.length > 500) state.log.shift();
  }
  const name = (s, pid) => s.players[pid].name;
  const hname = (board, id) => board.hotels[id].name;
  function actorOf(state) { return state.pending.player === undefined ? state.current : state.pending.player; }

  // ---------- legal actions ----------
  function legalActions(state, board) {
    if (state.winner !== null) return [];
    const A = [];
    const p = state.players[actorOf(state)];
    const pl = p.id;
    switch (state.phase) {
      case 'roll':
        A.push({ type: 'roll', player: pl });
        break;
      case 'stay':
        A.push({ type: 'rollStay', player: pl, hotel: state.pending.hotel });
        break;
      case 'townHall':
        for (const id of ownedPlots(state, pl)) {
          const cost = board.hotels[id].entrance;
          if (state.plots[id].built === 0 || state.pending.bought[id] || p.cash < cost) continue;
          for (const sp of freeSpaces(board, state, id)) A.push({ type: 'buyEntrance', player: pl, hotel: id, space: sp, cost });
        }
        A.push({ type: 'done', player: pl });
        break;
      case 'buy': {
        const sp = board.spaces[p.pos];
        for (const side of ['inner', 'outer']) {
          const id = sp[side]; if (!id) continue;
          const plot = state.plots[id], h = board.hotels[id];
          if (plot.owner === null && p.cash >= h.land) A.push({ type: 'buyLand', player: pl, hotel: id, cost: h.land, compulsory: false });
          else if (plot.owner !== null && plot.owner !== pl && plot.built === 0 && p.cash >= h.compulsory)
            A.push({ type: 'buyLand', player: pl, hotel: id, cost: h.compulsory, compulsory: true, from: plot.owner });
        }
        A.push({ type: 'pass', player: pl });
        break;
      }
      case 'build':
        for (const id of ownedPlots(state, pl)) {
          const plot = state.plots[id], n = buildings(board, id);
          if (plot.boughtTurn === state.turn || plot.built >= n) continue;
          for (let k = 1; k <= n - plot.built; k++) A.push({ type: 'declare', player: pl, hotel: id, stages: k, cost: costOf(board, id, plot.built, k) });
        }
        A.push({ type: 'pass', player: pl });
        break;
      case 'spin':
        A.push({ type: 'spin', player: pl });
        A.push({ type: 'withdraw', player: pl }); // the application can be withdrawn before it goes to the committee
        break;
      case 'freeEntrance':
        for (const id of ownedPlots(state, pl)) {
          if (state.plots[id].built === 0) continue;
          for (const sp of freeSpaces(board, state, id)) A.push({ type: 'placeEntrance', player: pl, hotel: id, space: sp });
        }
        A.push({ type: 'pass', player: pl });
        break;
      case 'freeBuild':
        for (const id of ownedPlots(state, pl)) {
          const plot = state.plots[id];
          if (plot.built < buildings(board, id)) A.push({ type: 'freeBuild', player: pl, hotel: id, facilities: false });
          else if (!plot.facilities) A.push({ type: 'freeBuild', player: pl, hotel: id, facilities: true });
        }
        A.push({ type: 'pass', player: pl });
        break;
      case 'end':
        for (const id of ownedPlots(state, pl)) {
          const plot = state.plots[id], cost = facilityCost(board, id);
          if (plot.built === buildings(board, id) && !plot.facilities && p.cash >= cost) A.push({ type: 'buyFacilities', player: pl, hotel: id, cost });
        }
        A.push({ type: 'endTurn', player: pl });
        break;
      case 'raise':
        for (const id of ownedPlots(state, pl)) A.push({ type: 'auctionLot', player: pl, hotel: id });
        break;
      case 'auction': {
        const a = state.auction, bidder = a.bidders[a.idx], b = state.players[bidder];
        const min = a.highBidder === null ? (a.reserve || 50) : a.high + 50;
        if (b.cash >= min) A.push({ type: 'bid', player: bidder, min, max: b.cash });
        A.push({ type: 'pass', player: bidder });
        break;
      }
    }
    // Claim-it-or-lose-it mode: unclaimed entitlements can be claimed until the next roll.
    if (!state.autoClaim && !state.debt && !state.auction && ['roll', 'townHall', ...MOVER_PHASES].includes(state.phase)) {
      const c = state.claims;
      if (c.bank) A.push({ type: 'claimBank', player: c.mover });
      if (c.stay) A.push({ type: 'claimStay', player: c.stay.owner, hotel: c.stay.hotel });
      if (c.townHall) A.push({ type: 'claimTownHall', player: c.mover });
    }
    return A;
  }

  // ---------- applying actions ----------
  const KEYS = ['hotel', 'space', 'stages', 'compulsory', 'facilities'];
  function matches(l, a) {
    if (l.type !== a.type) return false;
    if (a.player !== undefined && l.player !== a.player) return false;
    return KEYS.every(k => a[k] === undefined || l[k] === a[k]);
  }

  function apply(state, board, action) {
    if (state.winner !== null) throw new Error('Game over');
    const legal = legalActions(state, board);
    const m = legal.find(l => matches(l, action));
    if (!m) throw new Error('Illegal action ' + JSON.stringify(action) + ' in phase ' + state.phase);
    if (action.type === 'bid') {
      const amt = Math.floor(action.amount);
      if (!(amt >= m.min && amt <= m.max)) throw new Error('Bid must be between ' + m.min + ' and ' + m.max);
      action = Object.assign({}, action, { amount: amt });
    }
    action = Object.assign({}, m, action);
    const ev = [];
    const p = state.players[action.player];
    switch (action.type) {
      case 'roll': state.claims = {}; doRoll(state, board, ev, action.value); break;
      case 'rollStay': doStay(state, board, ev, action); break;
      case 'buyEntrance':
        pay(state, p, action.cost); state.entrances[action.space] = action.hotel; state.pending.bought[action.hotel] = true;
        push(state, ev, `${p.name} buys an entrance to the ${hname(board, action.hotel)} for ${fmt(action.cost)}.`, { type: 'entrance', hotel: action.hotel, space: action.space, player: p.id });
        break;
      case 'done': state.phase = null; break;
      case 'pass':
        if (state.phase === 'auction') auctionPass(state, board, ev); else { push(state, ev, `${p.name} passes.`); state.phase = null; }
        break;
      case 'buyLand': {
        const plot = state.plots[action.hotel];
        if (action.compulsory) {
          const prev = state.players[plot.owner];
          p.cash -= action.cost; prev.cash += action.cost;
          push(state, ev, `${p.name} forces ${prev.name} to sell the ${hname(board, action.hotel)} land for ${fmt(action.cost)}.`, { type: 'land', hotel: action.hotel, player: p.id, from: prev.id });
        } else {
          pay(state, p, action.cost);
          push(state, ev, `${p.name} buys the ${hname(board, action.hotel)} land for ${fmt(action.cost)}.`, { type: 'land', hotel: action.hotel, player: p.id });
        }
        plot.owner = p.id; plot.boughtTurn = state.turn; state.phase = null; state.quiet = 0;
        break;
      }
      case 'declare':
        state.pending = { player: p.id, hotel: action.hotel, stages: action.stages, cost: action.cost };
        state.phase = 'spin';
        push(state, ev, `${p.name} applies to build ${stageNames(board, state, action.hotel, action.stages)} on the ${hname(board, action.hotel)} (${fmt(action.cost)}).`);
        break;
      case 'spin': doSpin(state, board, ev); break;
      case 'withdraw':
        push(state, ev, `${p.name} withdraws the application for the ${hname(board, state.pending.hotel)}.`, { type: 'withdraw', player: p.id, hotel: state.pending.hotel });
        state.pending = { player: p.id }; state.phase = 'build';
        break;
      case 'placeEntrance':
        state.entrances[action.space] = action.hotel; state.phase = null; state.quiet = 0;
        push(state, ev, `${p.name} places a free entrance to the ${hname(board, action.hotel)}.`, { type: 'entrance', hotel: action.hotel, space: action.space, player: p.id });
        break;
      case 'freeBuild': {
        const plot = state.plots[action.hotel];
        if (action.facilities) { plot.facilities = true; push(state, ev, `${p.name} adds the ${hname(board, action.hotel)} leisure facilities free of charge.`, { type: 'built', hotel: action.hotel, facilities: true }); }
        else { plot.built++; push(state, ev, `${p.name} builds the ${hname(board, action.hotel)} ${board.hotels[action.hotel].stages[plot.built - 1][0].toLowerCase()} free of charge.`, { type: 'built', hotel: action.hotel, stage: plot.built - 1 }); }
        state.phase = null; state.quiet = 0;
        break;
      }
      case 'buyFacilities':
        pay(state, p, action.cost); state.plots[action.hotel].facilities = true;
        push(state, ev, `${p.name} buys the ${hname(board, action.hotel)} leisure facilities for ${fmt(action.cost)}.`, { type: 'built', hotel: action.hotel, facilities: true });
        break;
      case 'endTurn': state.queue = []; state.phase = null; break;
      case 'auctionLot': startAuction(state, board, ev, action.hotel); break;
      case 'bid': {
        const a = state.auction; a.high = action.amount; a.highBidder = p.id;
        push(state, ev, `${p.name} bids ${fmt(action.amount)} for the ${hname(board, a.lot)}.`);
        nextBidder(state, board, ev);
        break;
      }
      case 'claimBank':
        delete state.claims.bank; bankPay(state, p, 2000); push(state, ev, `${p.name} claims 2,000 from the Bank.`, { type: 'bank', player: p.id });
        break;
      case 'claimStay':
        delete state.claims.stay;
        interrupt(state, 'stay', { player: state.claims.mover, hotel: action.hotel });
        push(state, ev, `${p.name} claims payment for ${name(state, state.claims.mover)}'s stay at the ${hname(board, action.hotel)}.`);
        break;
      case 'claimTownHall':
        delete state.claims.townHall;
        interrupt(state, 'townHall', { player: state.claims.mover, bought: {} });
        push(state, ev, `${p.name} claims the right to buy entrances at the Town Hall.`);
        break;
    }
    continueTurn(state, board, ev);
    return ev;
  }

  function stageNames(board, state, id, k) {
    const from = state.plots[id].built, h = board.hotels[id];
    const names = []; for (let j = from; j < from + k; j++) names.push(h.stages[j][0].toLowerCase());
    return names.join(', ');
  }
  function pay(state, p, amount) { p.cash -= amount; state.bank.takenIn += amount; state.quiet = 0; }
  function bankPay(state, p, amount) { p.cash += amount; state.bank.paidOut += amount; state.quiet = 0; }
  function interrupt(state, phase, pending) {
    state.queue.unshift({ phase: state.phase, pending: state.pending });
    state.phase = phase; state.pending = pending;
  }

  // ---------- the turn ----------
  function doRoll(state, board, ev, forced) {
    const p = cur(state), N = board.spaces.length;
    const r = forced || d6(state);
    if (r === 6) state.extraTurn = true;
    let pos = p.pos; const crossed = [];
    const step = () => {
      const from = pos, to = (pos + 1) % N;
      if (from >= 0) for (const l of board.lines) if (l.between[0] === from && l.between[1] === to) crossed.push(l.id);
      pos = to;
    };
    for (let i = 0; i < r; i++) step();
    let bumped = false;
    while (state.players.some(q => q.active && q.id !== p.id && q.pos === pos)) { step(); bumped = true; }
    p.pos = pos;
    const sp = board.spaces[pos];
    push(state, ev, `${p.name} rolls ${r}${r === 6 ? ' (extra turn)' : ''} and moves to ${spaceLabel(sp)}${bumped ? ' (the space it rolled to was taken, so it moves on one)' : ''}.`, { type: 'move', player: p.id, roll: r, to: pos, crossed });

    const q = [], c = { mover: p.id };
    if (crossed.includes('bank')) {
      if (bankPays(state)) { if (state.autoClaim) { bankPay(state, p, 2000); push(state, ev, `${p.name} passes the Bank and collects 2,000.`, { type: 'bank', player: p.id }); } else c.bank = true; }
      else push(state, ev, `${p.name} passes the Bank, but with two players left the Bank pays nothing.`);
    }
    const ent = state.entrances[pos];
    if (ent !== undefined && state.plots[ent].owner !== null && state.plots[ent].owner !== p.id) {
      if (state.autoClaim) q.push({ phase: 'stay', pending: { player: p.id, hotel: ent } });
      else c.stay = { hotel: ent, owner: state.plots[ent].owner };
    }
    if (crossed.includes('townHall')) {
      if (state.autoClaim) q.push({ phase: 'townHall', pending: { player: p.id, bought: {} } });
      else c.townHall = true;
    }
    if (['buy', 'build', 'freeEntrance', 'freeBuild'].includes(sp.type)) q.push(sp.type);
    q.push('end');
    state.claims = c; state.queue = q; state.phase = null;
  }

  function spaceLabel(sp) {
    return { start: 'the start', buy: 'a buying space', build: 'a planning permission space', freeEntrance: 'a free entrance space', freeBuild: "a 'build one phase free' space" }[sp.type];
  }

  function doStay(state, board, ev, action) {
    const p = state.players[action.player], id = action.hotel, owner = state.players[state.plots[id].owner];
    const nights = d6(state), rate = nightlyRate(board, state, id), amount = nights * rate;
    push(state, ev, `${p.name} stays ${nights} night${nights > 1 ? 's' : ''} at the ${stars(board, state, id)}-star ${hname(board, id)} and owes ${owner.name} ${fmt(amount)}.`, { type: 'stay', player: p.id, hotel: id, nights, amount, to: owner.id });
    state.phase = null;
    charge(state, board, ev, p, owner.id, amount, { type: 'stay', hotel: id });
  }

  function doSpin(state, board, ev) {
    const d = state.pending, p = state.players[d.player], plot = state.plots[d.hotel];
    const result = spin(state);
    state.phase = null;
    const what = stageNames(board, state, d.hotel, d.stages);
    if (result === 'red') { push(state, ev, `Spinner: RED. Permission refused.`, { type: 'spin', result }); return; }
    plot.built += d.stages; state.quiet = 0;
    if (result === 'H') { push(state, ev, `Spinner: H. ${p.name} builds ${what} on the ${hname(board, d.hotel)} free of charge.`, { type: 'spin', result, hotel: d.hotel, stages: d.stages }); return; }
    const cost = result === '2' ? d.cost * 2 : d.cost;
    push(state, ev, result === '2' ? `Spinner: 2. Permission granted at DOUBLE cost: ${fmt(cost)}.` : `Spinner: GREEN. Permission granted, ${fmt(cost)} to pay.`, { type: 'spin', result, hotel: d.hotel, stages: d.stages });
    charge(state, board, ev, p, 'bank', cost, { type: 'build', hotel: d.hotel, stages: d.stages });
    if (!state.debt) push(state, ev, `${p.name} builds ${what} on the ${hname(board, d.hotel)}.`, { type: 'built', hotel: d.hotel, stages: d.stages });
  }

  function charge(state, board, ev, p, to, amount, reason) {
    if (p.cash >= amount) { transfer(state, p, to, amount); return; }
    state.debt = { from: p.id, to, amount, reason };
    push(state, ev, `${p.name} has ${fmt(p.cash)} and cannot pay ${fmt(amount)}. A hotel must be auctioned.`, { type: 'debt', player: p.id, amount });
  }
  function transfer(state, p, to, amount) {
    p.cash -= amount; state.quiet = 0;
    if (to === 'bank') state.bank.takenIn += amount; else state.players[to].cash += amount;
  }

  // ---------- auctions ----------
  function startAuction(state, board, ev, lot) {
    const seller = state.debt.from;
    const reserve = auctionReserve(state, board, lot);
    state.auction = { lot, seller, bidders: active(state).filter(q => q.id !== seller).map(q => q.id), idx: 0, high: 0, highBidder: null, reserve };
    state.phase = 'auction'; state.pending = {};
    push(state, ev, `${name(state, seller)} puts the ${hname(board, lot)} up for auction (${describePlot(board, state, lot)}). Reserve price ${fmt(reserve)}.`, { type: 'auctionStart', hotel: lot, reserve });
  }
  // What has gone into a hotel so far: land, finished buildings, facilities and entrances (building work that
  // started this auction and was never paid for does not count).
  function amountSpent(state, board, id) {
    const h = board.hotels[id], plot = state.plots[id], d = state.debt;
    let built = plot.built;
    if (d && d.reason && d.reason.type === 'build' && d.reason.hotel === id) built -= d.reason.stages;
    let v = h.land; for (let j = 0; j < built; j++) v += h.stages[j][1];
    if (plot.facilities && built === buildings(board, id)) v += facilityCost(board, id);
    v += Object.values(state.entrances).filter(x => x === id).length * (h.entrance || 0);
    return v;
  }
  // The reserve: half of what has been spent, to the nearest 50 below. Bids start here, and if nobody bids the
  // Bank buys the hotel at this price and knocks it down.
  const RESERVE_SHARE = 0.5;
  function auctionReserve(state, board, id) { return Math.max(50, Math.floor(amountSpent(state, board, id) * RESERVE_SHARE / 50) * 50); }
  function describePlot(board, state, id) {
    const plot = state.plots[id], n = buildings(board, id);
    const ents = Object.values(state.entrances).filter(h => h === id).length;
    if (plot.built === 0) return 'land only';
    return `${plot.built} of ${n} buildings${plot.facilities ? ', facilities' : ''}, ${ents} entrance${ents === 1 ? '' : 's'}`;
  }
  function auctionPass(state, board, ev) {
    const a = state.auction;
    push(state, ev, `${name(state, a.bidders[a.idx])} passes.`);
    a.bidders.splice(a.idx, 1);
    a.idx = a.idx % Math.max(1, a.bidders.length);
    settleBidder(state, board, ev, false);
  }
  function nextBidder(state, board, ev) {
    const a = state.auction;
    a.idx = (a.idx + 1) % a.bidders.length;
    settleBidder(state, board, ev, true);
  }
  // Point idx at the next bidder who is not the current high bidder; finish if there is none.
  function settleBidder(state, board, ev, advanced) {
    const a = state.auction;
    if (a.bidders.length === 0) return finishAuction(state, board, ev);
    const others = a.bidders.filter(b => b !== a.highBidder);
    if (others.length === 0) return finishAuction(state, board, ev);
    if (a.bidders[a.idx] === a.highBidder) a.idx = (a.idx + 1) % a.bidders.length;
  }
  function finishAuction(state, board, ev) {
    const a = state.auction, plot = state.plots[a.lot], seller = state.players[a.seller], debt = state.debt;
    state.auction = null; state.phase = null;
    const unpaidBuild = debt.reason.type === 'build' && debt.reason.hotel === a.lot;
    if (unpaidBuild) { plot.built -= debt.reason.stages; state.debt = null; push(state, ev, `The unpaid building work on the ${hname(board, a.lot)} is cancelled; nothing is owed for it.`); }
    if (a.highBidder === null) {
      const price = a.reserve || 0;
      plot.owner = null; plot.built = 0; plot.facilities = false; plot.boughtTurn = -1;
      for (const sp in state.entrances) if (state.entrances[sp] === a.lot) delete state.entrances[sp];
      if (price > 0) { seller.cash += price; state.bank.paidOut += price; state.quiet = 0; }
      push(state, ev, `Nobody bids. The Bank buys the ${hname(board, a.lot)} for the reserve of ${fmt(price)}, knocks down every building and entrance, and puts the land back up for sale.`, { type: 'demolished', hotel: a.lot, amount: price, from: seller.id, bank: true });
    } else {
      const buyer = state.players[a.highBidder];
      buyer.cash -= a.high; seller.cash += a.high; plot.owner = buyer.id; plot.boughtTurn = state.turn;
      push(state, ev, `${buyer.name} buys the ${hname(board, a.lot)} at auction for ${fmt(a.high)}.`, { type: 'auctionSold', hotel: a.lot, player: buyer.id, amount: a.high, from: seller.id });
    }
    if (state.debt) settleDebt(state, board, ev);
  }
  function settleDebt(state, board, ev) {
    const d = state.debt, p = state.players[d.from];
    const now = Math.min(p.cash, d.amount);
    if (now > 0) { transfer(state, p, d.to, now); d.amount -= now; push(state, ev, `${p.name} pays ${fmt(now)}${d.amount > 0 ? ', still owing ' + fmt(d.amount) : ''}.`); }
    if (d.amount <= 0) state.debt = null;
  }
  function goBankrupt(state, board, ev, p) {
    const d = state.debt; state.debt = null;
    p.active = false; p.pos = -1;
    push(state, ev, `${p.name} has no money, no hotels and no land left and is out of the game.`, { type: 'bankrupt', player: p.id });
    const left = active(state);
    if (left.length === 1) { state.winner = left[0].id; push(state, ev, `${left[0].name} is the last Hotel Tycoon standing and wins!`, { type: 'win', player: left[0].id }); return; }
    if (state.startingPlayers > 2 && left.length === 2) push(state, ev, `Two players left: the Bank no longer pays 2,000.`);
    if (p.id === state.current) { state.queue = []; state.extraTurn = false; }
  }

  // ---------- turn driver ----------
  function continueTurn(state, board, ev) {
    for (let guard = 0; guard < 100; guard++) {
      if (state.winner !== null) return;
      if (state.phase === null) {
        if (state.debt) {
          const p = state.players[state.debt.from];
          if (ownedPlots(state, p.id).length === 0) { goBankrupt(state, board, ev, p); continue; }
          state.phase = 'raise'; state.pending = { player: p.id };
          return;
        }
        if (state.queue.length === 0) { nextTurn(state, board, ev); return; }
        const item = state.queue.shift();
        if (typeof item === 'string') { state.phase = item; state.pending = { player: state.current }; }
        else { state.phase = item.phase; state.pending = item.pending; }
      }
      // Skip a phase where the only choice is to do nothing (never an auction: passing there is a real bid decision).
      const acts = legalActions(state, board).filter(a => !a.type.startsWith('claim'));
      // (the end of a turn stays open while a completed hotel still lacks its leisure facilities, so the player can see why they can't buy them yet)
      const waitingFacilities = state.phase === 'end' && ownedPlots(state, state.current).some(id => state.plots[id].built === buildings(board, id) && !state.plots[id].facilities) && !cur(state).ai;
      if (state.phase !== 'auction' && !waitingFacilities && acts.length === 1 && ['pass', 'done', 'endTurn'].includes(acts[0].type)) {
        if (acts[0].type === 'endTurn') state.queue = [];
        state.phase = null; continue;
      }
      return;
    }
  }
  function nextTurn(state, board, ev) {
    state.turn++; state.quiet++;
    if (state.quiet >= QUIET_LIMIT) return stalemate(state, board, ev);
    const p = cur(state);
    if (!(state.extraTurn && p.active)) {
      let i = state.current;
      do { i = (i + 1) % state.players.length; } while (!state.players[i].active);
      state.current = i;
    }
    state.extraTurn = false; state.phase = 'roll'; state.pending = { player: state.current }; state.queue = [];
    push(state, ev, `— ${cur(state).name}'s turn —`, { type: 'turn', player: state.current });
  }

  // Digital-only rule: if nothing has been bought, built or paid for QUIET_LIMIT player-turns in a row
  // (possible when two players are left with no bank income and no hotels), the richer player wins.
  const QUIET_LIMIT = 80;
  function netWorth(board, state, pid) {
    let v = state.players[pid].cash;
    for (const id of ownedPlots(state, pid)) {
      const h = board.hotels[id], plot = state.plots[id];
      v += h.land; for (let j = 0; j < plot.built; j++) v += h.stages[j][1];
      if (plot.facilities) v += facilityCost(board, id);
    }
    return v;
  }
  function stalemate(state, board, ev) {
    const ranked = active(state).map(p => ({ p, w: netWorth(board, state, p.id) })).sort((a, b) => b.w - a.w);
    state.winner = ranked[0].p.id;
    push(state, ev, `Nothing has changed hands for ${QUIET_LIMIT} turns. ${ranked[0].p.name} wins as the richest tycoon (${fmt(ranked[0].w)}).`, { type: 'win', player: state.winner, stalemate: true });
  }

  // ---------- summaries for UIs and bots ----------
  function summary(state, board) {
    return state.players.map(p => ({
      id: p.id, name: p.name, ai: p.ai, cash: p.cash, pos: p.pos, active: p.active,
      hotels: ownedPlots(state, p.id).map(id => ({ id, name: hname(board, id), built: state.plots[id].built, of: buildings(board, id), facilities: state.plots[id].facilities, rate: nightlyRate(board, state, id), entrances: Object.keys(state.entrances).filter(sp => state.entrances[sp] === id).map(Number) }))
    }));
  }
  function describeAction(a, state, board) {
    const H = id => hname(board, id);
    switch (a.type) {
      case 'roll': return 'Roll the die';
      case 'rollStay': return `Roll for nights at the ${H(a.hotel)}`;
      case 'buyEntrance': return `Entrance to the ${H(a.hotel)} (${fmt(a.cost)})`;
      case 'done': return 'Done with entrances — carry on';
      case 'pass': return state.phase === 'auction' ? 'Pass' : state.phase === 'build' ? 'Don\'t build this time' : 'Do nothing';
      case 'buyLand': return a.compulsory ? `Force-buy the ${H(a.hotel)} land from ${name(state, a.from)} (${fmt(a.cost)})` : `Buy the ${H(a.hotel)} land (${fmt(a.cost)})`;
      case 'declare': return `${H(a.hotel)}: build ${stageNames(board, state, a.hotel, a.stages)} (${fmt(a.cost)}, or ${fmt(a.cost * 2)} on a 2)`;
      case 'spin': return 'Spin for planning permission';
      case 'withdraw': return 'Withdraw the application';
      case 'placeEntrance': return `Free entrance to the ${H(a.hotel)}`;
      case 'freeBuild': return a.facilities ? `${H(a.hotel)}: free leisure facilities` : `${H(a.hotel)}: free ${board.hotels[a.hotel].stages[state.plots[a.hotel].built][0].toLowerCase()}`;
      case 'buyFacilities': return `Buy the ${H(a.hotel)} leisure facilities (${fmt(a.cost)})`;
      case 'endTurn': return 'End turn';
      case 'auctionLot': return `Auction the ${H(a.hotel)} (${describePlot(board, state, a.hotel)})`;
      case 'bid': return `Bid (${fmt(a.min)} to ${fmt(a.max)})`;
      case 'claimBank': return 'Claim 2,000 from the Bank';
      case 'claimStay': return `Claim payment for the stay at the ${H(a.hotel)}`;
      case 'claimTownHall': return 'Claim Town Hall entrances';
    }
    return a.type;
  }

  return { amountSpent, auctionReserve, createGame, legalActions, apply, summary, netWorth, describeAction, nightlyRate, stars, freeSpaces, bordering, buildings, facilityCost, costOf, ownedPlots, SPINNER, fmt, clone: s => JSON.parse(JSON.stringify(s)) };
});
