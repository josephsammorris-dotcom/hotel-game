/*
 * Hotel relay: one Durable Object per game room, passing messages between the TV (host) and the phones.
 *
 *   GET /ws/<CODE>?role=host|player&id=<client id>   -> WebSocket into room CODE
 *
 * The relay knows nothing about the game. It forwards:
 *   phone -> host   as { t: 'from', id, m: <the phone's message> }
 *   host  -> phones as the host's message, to everyone, or to the ids listed in msg.to
 * and tells the host when phones arrive or leave ({ t: 'join' | 'leave', id }) and the phones when the host
 * comes and goes ({ t: 'host', on }). Everything else (rules, seats, game state) lives in the page.
 * Uses the WebSocket Hibernation API, so an idle room costs nothing.
 */
import { DurableObject } from 'cloudflare:workers';

const CODE = /^\/ws\/([A-Z0-9]{4,8})$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(CODE);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
      const room = env.ROOMS.get(env.ROOMS.idFromName(m[1].toUpperCase()));
      return room.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // keep-alive pings are answered without waking the room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';
    const id = (url.searchParams.get('id') || '').replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomUUID();
    const [client, server] = Object.values(new WebSocketPair());

    if (role === 'host') {
      // a new TV tab takes over from any older one
      for (const old of this.ctx.getWebSockets('host')) { try { old.close(4000, 'replaced'); } catch (e) {} }
    } else {
      // the same phone reconnecting replaces its previous connection
      for (const old of this.ctx.getWebSockets('id:' + id)) { try { old.close(4001, 'replaced'); } catch (e) {} }
    }
    this.ctx.acceptWebSocket(server, [role, 'id:' + id]);
    server.serializeAttachment({ role, id });

    const hostOn = this.ctx.getWebSockets('host').some(ws => ws !== server && ws.readyState === 1) || role === 'host';
    server.send(JSON.stringify({ t: 'welcome', role, id, host: hostOn, players: this.playerIds() }));
    if (role === 'host') this.toPlayers({ t: 'host', on: true });
    else this.toHost({ t: 'join', id });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 4_000_000) return;
    let msg; try { msg = JSON.parse(data); } catch (e) { return; }
    const me = ws.deserializeAttachment() || {};
    if (me.role === 'host') {
      if (msg.to) {
        for (const id of [].concat(msg.to)) for (const p of this.ctx.getWebSockets('id:' + id)) this.send(p, data);
      } else this.toPlayers(data);
    } else if (!this.toHost({ t: 'from', id: me.id, m: msg })) {
      this.send(ws, { t: 'host', on: false });
    }
  }

  async webSocketClose(ws, code) { this.gone(ws); try { ws.close(code, 'bye'); } catch (e) {} }
  async webSocketError(ws) { this.gone(ws); }

  gone(ws) {
    const me = ws.deserializeAttachment() || {};
    if (me.role === 'host') { if (!this.ctx.getWebSockets('host').some(h => h !== ws && h.readyState === 1)) this.toPlayers({ t: 'host', on: false }); }
    else if (!this.ctx.getWebSockets('id:' + me.id).some(p => p !== ws && p.readyState === 1)) this.toHost({ t: 'leave', id: me.id });
  }

  playerIds() {
    return [...new Set(this.ctx.getWebSockets('player').filter(w => w.readyState === 1).map(w => (w.deserializeAttachment() || {}).id))];
  }
  send(ws, msg) { try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); return true; } catch (e) { return false; } }
  toHost(msg) { let ok = false; for (const h of this.ctx.getWebSockets('host')) ok = this.send(h, msg) || ok; return ok; }
  toPlayers(msg) { const s = typeof msg === 'string' ? msg : JSON.stringify(msg); for (const p of this.ctx.getWebSockets('player')) this.send(p, s); }
}
