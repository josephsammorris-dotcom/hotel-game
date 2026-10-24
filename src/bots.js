/* Computer players for Hotel. `choose(level, state, board, actions, rnd)` picks one legal action.
 * 'easy' is the first, simple opponent; smarter levels come in Phase 5. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./engine.js'));
  else root.HotelBots = factory(root.HotelEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

  // What a plot is worth to a bidder: land plus what has been built on it.
  function plotValue(board, state, id) {
    const h = board.hotels[id], p = state.plots[id];
    let v = h.land; for (let j = 0; j < p.built; j++) v += h.stages[j][1];
    if (p.facilities) v += E.facilityCost(board, id);
    return v;
  }
  // Income potential: nightly rate at the top stage times entrance spaces available.
  function potential(board, state, id) {
    const h = board.hotels[id];
    return h.stages[h.stages.length - 1][2] * E.bordering(board, id).length;
  }

  function easy(state, board, actions, rnd) {
    const me = state.players[actions[0].player];
    const by = t => actions.filter(a => a.type === t);
    const only = t => by(t)[0];
    const reserve = 1500;
    if (only('roll')) return only('roll');
    if (only('rollStay')) return only('rollStay');
    if (only('spin')) return only('spin');
    if (only('claimStay')) return only('claimStay');
    if (only('claimBank')) return only('claimBank');
    if (only('claimTownHall')) return only('claimTownHall');

    switch (state.phase) {
      case 'buy': {
        const buys = by('buyLand').filter(a => me.cash - a.cost >= reserve);
        if (buys.length) return buys.sort((a, b) => (potential(board, state, b.hotel) / b.cost) - (potential(board, state, a.hotel) / a.cost))[0];
        return only('pass');
      }
      case 'build': {
        // Build as much as can be paid for even if the spinner shows 2, keeping a reserve.
        const ok = by('declare').filter(a => me.cash - a.cost * 2 >= reserve);
        if (!ok.length) return only('pass');
        ok.sort((a, b) => b.stages - a.stages || potential(board, state, b.hotel) - potential(board, state, a.hotel));
        return ok[0];
      }
      case 'townHall': {
        const buys = by('buyEntrance').filter(a => me.cash - a.cost >= reserve);
        if (buys.length) return pick(buys, rnd);
        return only('done');
      }
      case 'freeEntrance': {
        const opts = by('placeEntrance'); return opts.length ? pick(opts, rnd) : only('pass');
      }
      case 'freeBuild': {
        const opts = by('freeBuild'); return opts.length ? pick(opts, rnd) : only('pass');
      }
      case 'end': {
        const fac = by('buyFacilities').filter(a => me.cash - a.cost >= reserve);
        return fac.length ? fac[0] : only('endTurn');
      }
      case 'raise': {
        const lots = by('auctionLot');
        return lots.sort((a, b) => plotValue(board, state, a.hotel) - plotValue(board, state, b.hotel))[0];
      }
      case 'auction': {
        const bid = only('bid'), a = state.auction;
        if (!bid) return only('pass');
        const bidder = state.players[bid.player];
        const worth = Math.floor(plotValue(board, state, a.lot) * (0.5 + rnd() * 0.45));
        const cap = Math.min(worth, bidder.cash - reserve);
        if (cap >= bid.min) return { type: 'bid', player: bid.player, amount: Math.min(cap, bid.min + Math.floor(rnd() * 1000)) };
        return only('pass');
      }
    }
    return actions[0];
  }

  function choose(level, state, board, actions, rnd) {
    rnd = rnd || Math.random;
    return easy(state, board, actions, rnd);
  }

  return { choose, plotValue, potential };
});
