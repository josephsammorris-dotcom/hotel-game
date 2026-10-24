var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
import { DurableObject } from "cloudflare:workers";
var CODE = /^\/ws\/([A-Z0-9]{4,8})$/i;
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(CODE);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
      const room = env.ROOMS.get(env.ROOMS.idFromName(m[1].toUpperCase()));
      return room.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
var Room = class extends DurableObject {
  static {
    __name(this, "Room");
  }
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "host" ? "host" : "player";
    const id = (url.searchParams.get("id") || "").replace(/[^\w-]/g, "").slice(0, 40) || crypto.randomUUID();
    const [client, server] = Object.values(new WebSocketPair());
    if (role === "host") {
      for (const old of this.ctx.getWebSockets("host")) {
        try {
          old.close(4e3, "replaced");
        } catch (e) {
        }
      }
    } else {
      for (const old of this.ctx.getWebSockets("id:" + id)) {
        try {
          old.close(4001, "replaced");
        } catch (e) {
        }
      }
    }
    this.ctx.acceptWebSocket(server, [role, "id:" + id]);
    server.serializeAttachment({ role, id });
    const hostOn = this.ctx.getWebSockets("host").some((ws) => ws !== server && ws.readyState === 1) || role === "host";
    server.send(JSON.stringify({ t: "welcome", role, id, host: hostOn, players: this.playerIds() }));
    if (role === "host") this.toPlayers({ t: "host", on: true });
    else this.toHost({ t: "join", id });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > 4e6) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }
    const me = ws.deserializeAttachment() || {};
    if (me.role === "host") {
      if (msg.to) {
        for (const id of [].concat(msg.to)) for (const p of this.ctx.getWebSockets("id:" + id)) this.send(p, data);
      } else this.toPlayers(data);
    } else if (!this.toHost({ t: "from", id: me.id, m: msg })) {
      this.send(ws, { t: "host", on: false });
    }
  }
  async webSocketClose(ws, code) {
    this.gone(ws);
    try {
      ws.close(code, "bye");
    } catch (e) {
    }
  }
  async webSocketError(ws) {
    this.gone(ws);
  }
  gone(ws) {
    const me = ws.deserializeAttachment() || {};
    if (me.role === "host") {
      if (!this.ctx.getWebSockets("host").some((h) => h !== ws && h.readyState === 1)) this.toPlayers({ t: "host", on: false });
    } else if (!this.ctx.getWebSockets("id:" + me.id).some((p) => p !== ws && p.readyState === 1)) this.toHost({ t: "leave", id: me.id });
  }
  playerIds() {
    return [...new Set(this.ctx.getWebSockets("player").filter((w) => w.readyState === 1).map((w) => (w.deserializeAttachment() || {}).id))];
  }
  send(ws, msg) {
    try {
      ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
      return true;
    } catch (e) {
      return false;
    }
  }
  toHost(msg) {
    let ok = false;
    for (const h of this.ctx.getWebSockets("host")) ok = this.send(h, msg) || ok;
    return ok;
  }
  toPlayers(msg) {
    const s = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const p of this.ctx.getWebSockets("player")) this.send(p, s);
  }
};

// ../../../tmp/claude-0/-home-claude/03ad2957-f138-5a0b-96c7-f7e515cdd207/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../tmp/claude-0/-home-claude/03ad2957-f138-5a0b-96c7-f7e515cdd207/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-1aj6VX/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../tmp/claude-0/-home-claude/03ad2957-f138-5a0b-96c7-f7e515cdd207/scratchpad/wr/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-1aj6VX/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
