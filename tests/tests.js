const E=require('../src/engine.js'),board=require('../src/board-1986.js');
const assert=require('assert');
const mk=(o={})=>E.createGame(board,Object.assign({seed:5,first:0,players:[{name:'A'},{name:'B'},{name:'C'}]},o));
const act=(s,a)=>E.apply(s,board,a);
const types=s=>E.legalActions(s,board).map(a=>a.type);
let s;

// 1. Rolling a 6 gives an extra turn; landing on an occupied space bumps forward; the bump can cross the Bank line.
s=mk(); act(s,{type:'roll',value:6}); assert.strictEqual(s.players[0].pos,5);
assert.strictEqual(s.current,0,'extra turn after a 6'); act(s,{type:'roll',value:1}); assert.strictEqual(s.players[0].pos,6);
assert.strictEqual(s.current,1);
act(s,{type:'roll',value:6}); assert.strictEqual(s.players[1].pos,5); assert.strictEqual(s.current,1);
act(s,{type:'roll',value:1}); assert.strictEqual(s.players[1].pos,7,'bumped past A');
assert.strictEqual(s.players[1].cash,14000,'bank line crossed by the bump pays 2000');
console.log('ok: dice, bumping, bank line');

// 2. Buying land, compulsory purchase, and no building on the turn of purchase.
s=mk(); act(s,{type:'roll',value:3}); // space 2: buy, fujiyama/boomerang
assert(types(s).includes('buyLand')); act(s,{type:'buyLand',hotel:'boomerang'});
assert.strictEqual(s.plots.boomerang.owner,0); assert.strictEqual(s.players[0].cash,11500);
// B lands on 4 (buy space bordering boomerang) and force-buys
if(s.phase==='end')act(s,{type:'endTurn'});
assert.strictEqual(s.current,1);{act(s,{type:'roll',value:5}); const c=E.legalActions(s,board).find(a=>a.type==='buyLand'&&a.hotel==='boomerang'); assert(c&&c.compulsory&&c.cost===250); act(s,c); assert.strictEqual(s.plots.boomerang.owner,1); assert.strictEqual(s.players[0].cash,11750,'seller receives the money');}
console.log('ok: land purchase and compulsory purchase');

// 3. Planning permission: forced spinner via rng is hard, so test the build flow and unpaid-build cancellation via auction.
s=mk(); s.plots.royal.owner=0; s.plots.royal.boughtTurn=-1; s.players[0].cash=100; s.plots.boomerang.owner=0; s.plots.boomerang.built=1;
act(s,{type:'roll',value:2}); // space 1 build
const d=E.legalActions(s,board).find(a=>a.type==='declare'&&a.hotel==='royal'&&a.stages===1); act(s,d);
assert.strictEqual(s.phase,'spin');
// spin until not red (rng-driven): keep re-creating until we get green or 2
let tries=0; while(true){ const c=E.clone(s); act(c,{type:'spin'}); if(c.debt){ s=c; break;} s.rng=(s.rng+1)|0; if(++tries>50) throw new Error('no debt'); }
assert.strictEqual(s.phase,'raise'); assert.strictEqual(s.plots.royal.built,1);
act(s,{type:'auctionLot',hotel:'royal'}); assert.strictEqual(s.phase,'auction');
act(s,{type:'pass'}); act(s,{type:'pass'});
assert.strictEqual(s.plots.royal.owner,null,'knocked down'); assert.strictEqual(s.debt,null,'building debt cancelled'); assert.strictEqual(s.players[0].active,true);
console.log('ok: permission debt cancelled when that site is auctioned');

// 4. Stay payment, auction sale to highest bidder, bankruptcy and winner.
s=mk({players:[{name:'A'},{name:'B'}]}); s.plots.boomerang.owner=1; s.plots.boomerang.built=1; s.plots.boomerang.facilities=true; s.entrances[3]='boomerang'; s.players[0].cash=100; s.plots.taj.owner=0;
act(s,{type:'roll',value:4}); assert.strictEqual(s.phase,'stay'); act(s,{type:'rollStay'});
assert(s.debt&&s.debt.to===1); assert.strictEqual(s.phase,'raise'); act(s,{type:'auctionLot',hotel:'taj'});
assert.strictEqual(E.legalActions(s,board).find(a=>a.type==='bid').min,s.auction.reserve,'bids start at the reserve'); act(s,{type:'bid',amount:s.auction.reserve}); assert.strictEqual(s.plots.taj.owner,1); assert.strictEqual(s.players[0].active,false); assert.strictEqual(s.winner,1);
console.log('ok: stay, auction sale, bankruptcy, win');

// 4b. Reserve price follows what was spent; no bids means the Bank buys at the reserve and knocks it all down.
s=mk({players:[{name:'A'},{name:'B'},{name:'C'}]}); s.plots.boomerang.owner=1; s.plots.boomerang.built=1; s.entrances[3]='boomerang'; s.players[0].cash=100;
s.plots.fujiyama.owner=0; s.plots.fujiyama.built=1; s.entrances[9]='fujiyama';
{ const h=board.hotels.fujiyama, spent=h.land+h.stages[0][1]+h.entrance; assert.strictEqual(E.amountSpent(s,board,'fujiyama'),spent);
  assert.strictEqual(E.auctionReserve(s,board,'fujiyama'),Math.floor(spent*0.5/50)*50);
  act(s,{type:'roll',value:4}); act(s,{type:'rollStay'}); assert.strictEqual(s.phase,'raise');
  const before=s.players[0].cash, owed=s.debt.amount; act(s,{type:'auctionLot',hotel:'fujiyama'}); const res=s.auction.reserve;
  act(s,{type:'pass'}); act(s,{type:'pass'});
  assert.strictEqual(s.plots.fujiyama.owner,null); assert.strictEqual(s.plots.fujiyama.built,0); assert(!Object.values(s.entrances).includes('fujiyama'),'entrances knocked down');
  assert.strictEqual(s.players[0].cash, Math.max(0, before+res-owed),'bank paid the reserve, which went to the debt');
  assert.strictEqual(s.bank.paidOut>=res,true); }
console.log('ok: auction reserve and bank buy-out');

// 5. Two players left in a 3-player game: bank stops paying.
s=mk(); s.players[2].active=false; s.players[2].pos=-1; act(s,{type:'roll',value:6}); act(s,{type:'roll',value:2});
assert.strictEqual(s.players[0].cash,12000,'no bank money with two left'); console.log('ok: two-player bank rule');

// 6. Claim mode: stay claim expires when next player rolls.
s=mk({autoClaim:false}); s.plots.boomerang.owner=1; s.plots.boomerang.built=1; s.entrances[3]='boomerang';
act(s,{type:'roll',value:4}); assert(types(s).includes('claimStay')); assert.strictEqual(s.current,1);
act(s,{type:'roll',value:2}); assert(!types(s).includes('claimStay')); assert.strictEqual(s.players[0].cash,12000);
s=mk({autoClaim:false}); s.plots.boomerang.owner=1; s.plots.boomerang.built=1; s.entrances[3]='boomerang';
act(s,{type:'roll',value:4}); act(s,{type:'claimStay',player:1}); assert.strictEqual(s.phase,'stay'); act(s,{type:'rollStay'}); assert(s.players[0].cash<12000); assert.strictEqual(s.phase,'roll'); assert.strictEqual(s.current,1);
console.log('ok: claim-it-or-lose-it');

// 7. Town Hall: one entrance per hotel; no two entrances on one space.
s=mk(); s.plots.safari.owner=0; s.plots.safari.built=1; s.plots.etoile.owner=0; s.plots.etoile.built=1; s.players[0].pos=24;
act(s,{type:'roll',value:2}); assert.strictEqual(s.phase,'townHall');
const e1=E.legalActions(s,board).find(a=>a.type==='buyEntrance'&&a.hotel==='safari'&&a.space===28); act(s,e1);
assert(!E.legalActions(s,board).some(a=>a.type==='buyEntrance'&&a.hotel==='safari'),'one per hotel');
assert(!E.legalActions(s,board).some(a=>a.type==='buyEntrance'&&a.space===28),'space taken');
console.log('ok: town hall entrances');
console.log('ALL TESTS PASSED');
