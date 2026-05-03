// freertc Cloudflare Worker – Rust / workers-rs port of src/index.js
//
// Why Rust?
//  • WASM compiles to near-native machine code; no JIT warm-up per isolate.
//  • Zero-cost serde parsing instead of V8's dynamic JSON engine.
//  • Deterministic memory layout keeps GC pauses out of the hot path,
//    which reduces end-to-end latency for every browser that is waiting
//    on a relay or peer-list push.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use futures::StreamExt;
use js_sys::Date;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::*;

// ─── Protocol constants ──────────────────────────────────────────────────────

const PSP_VERSION: &str = "1.0";
const DEFAULT_TTL_MS: u64 = 30_000;
const MAX_TTL_MS: u64 = 120_000;
const MAX_MESSAGE_SIZE: usize = 64 * 1024;
const MAX_BATCH: usize = 50;

// ─── Message-type helpers ────────────────────────────────────────────────────

fn is_valid_type(t: &str) -> bool {
    matches!(
        t,
        "announce"
            | "withdraw"
            | "discover"
            | "peer_list"
            | "redirect"
            | "connect_request"
            | "connect_accept"
            | "connect_reject"
            | "offer"
            | "answer"
            | "ice_candidate"
            | "ice_end"
            | "renegotiate"
            | "ping"
            | "pong"
            | "bye"
            | "error"
            | "ack"
            | "ext"
    )
}

fn is_relay_type(t: &str) -> bool {
    matches!(
        t,
        "connect_request"
            | "connect_accept"
            | "connect_reject"
            | "offer"
            | "answer"
            | "ice_candidate"
            | "ice_end"
            | "renegotiate"
            | "bye"
            | "error"
            | "ack"
            | "ext"
            | "peer_list"
            | "redirect"
    )
}

// ─── Data types ──────────────────────────────────────────────────────────────

/// PSP envelope.  Unknown fields are intentionally dropped; the relay only
/// needs the fields it acts on and re-serialises the original raw string for
/// pass-through relay so no information is lost for the recipients.
#[derive(Deserialize, Serialize, Clone, Debug)]
struct PspMessage {
    psp_version: String,
    #[serde(rename = "type")]
    msg_type: String,
    from: String,
    network: String,
    message_id: String,
    timestamp: i64,
    #[serde(default)]
    ttl_ms: Option<u64>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default = "empty_object")]
    body: Value,
}

fn empty_object() -> Value {
    json!({})
}

#[derive(Deserialize, Debug)]
struct AnnouncementRow {
    peer_id: String,
    session_id: Option<String>,
    updated_at_ms: i64,
}

#[derive(Deserialize, Debug)]
struct RelayRow {
    id: i64,
    message_json: String,
}

/// Per-connection entry stored in the thread-local peer registry.
struct PeerEntry {
    /// Cloned handle to the server-side WebSocket; safe because wasm-bindgen
    /// extern types are reference-counted JS values and Clone just bumps the
    /// ref-count without copying socket state.
    socket: WebSocket,
}

// ─── Thread-local peer state ─────────────────────────────────────────────────
//
// Cloudflare Workers run in a single-threaded V8 isolate per deployment, so
// thread_local! + RefCell gives us shared mutable state without any locking
// overhead – no Mutex, no atomic ops, zero CPU cost for contention that can
// never happen.

thread_local! {
    /// key: "network:peerId"
    static LIVE_PEERS: RefCell<HashMap<String, PeerEntry>> =
        RefCell::new(HashMap::new());

    /// key: network -> set of peer-keys that are subscribed to broadcasts
    static NET_SUBS: RefCell<HashMap<String, HashSet<String>>> =
        RefCell::new(HashMap::new());
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

#[inline]
fn now_ms() -> i64 {
    Date::now() as i64
}

#[inline]
fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn relay_id(env: &Env) -> String {
    env.var("RELAY_PEER_ID")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "relay".to_string())
}

/// Build a JSON PSP envelope string.  `to = None` serialises to `"to": null`
/// which matches the JS behaviour for broadcasts.
fn make_envelope(
    msg_type: &str,
    network: &str,
    from: &str,
    to: Option<&str>,
    body: Value,
) -> String {
    serde_json::to_string(&json!({
        "psp_version": PSP_VERSION,
        "type":        msg_type,
        "network":     network,
        "from":        from,
        "to":          to,
        "message_id":  new_uuid(),
        "timestamp":   now_ms(),
        "ttl_ms":      DEFAULT_TTL_MS,
        "body":        body,
    }))
    .unwrap_or_default()
}

fn valid_envelope(msg: &PspMessage) -> bool {
    msg.psp_version == PSP_VERSION
        && is_valid_type(&msg.msg_type)
        && !msg.from.trim().is_empty()
        && !msg.network.trim().is_empty()
        && !msg.message_id.is_empty()
        && msg.timestamp > 0
}

// ─── Entry point ─────────────────────────────────────────────────────────────

#[event(fetch)]
async fn main(req: Request, env: Env, ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let upgrade = req
        .headers()
        .get("Upgrade")?
        .unwrap_or_default()
        .to_lowercase();

    if upgrade == "websocket" {
        if url.path() != "/ws" {
            return Response::from_json(&json!({ "ok": false, "error": "WebSocket endpoint is /ws" }))
                .map(|r| r.with_status(404));
        }
        return handle_websocket(env, ctx).await;
    }

    if url.path() == "/ws" {
        return Response::from_json(
            &json!({ "ok": false, "error": "Expected WebSocket upgrade on /ws" }),
        )
        .map(|r| r.with_status(426));
    }

    if url.path() == "/health" {
        let peers = LIVE_PEERS.with(|m| m.borrow().len());
        return Response::from_json(&json!({
            "ok":      true,
            "version": PSP_VERSION,
            "peers":   peers,
        }));
    }

    Response::error("Not Found", 404)
}

// ─── WebSocket upgrade ───────────────────────────────────────────────────────

async fn handle_websocket(env: Env, ctx: Context) -> Result<Response> {
    let pair = WebSocketPair::new()?;
    let client = pair.client;
    let server = pair.server;

    server.accept()?;

    // Spawn the per-connection event loop.  ctx.wait_until keeps the isolate
    // alive for the lifetime of the WebSocket connection even after we return
    // the 101 response to the client.
    ctx.wait_until(async move {
        handle_socket(server, env).await;
    });

    Response::from_websocket(client)
}

// ─── Per-connection event loop ───────────────────────────────────────────────

async fn handle_socket(server: WebSocket, env: Env) {
    let mut cur_peer_key: Option<String> = None;
    let mut cur_network: Option<String> = None;
    let mut cur_peer_id: Option<String> = None;

    let mut events = match server.events() {
        Ok(e) => e,
        Err(e) => {
            console_error!("[WS] events() failed: {:?}", e);
            return;
        }
    };

    while let Some(event) = events.next().await {
        match event {
            Ok(WebsocketEvent::Message(msg)) => {
                let raw = match msg.text() {
                    Some(t) => t,
                    None => continue, // binary frames are ignored
                };

                if raw.len() > MAX_MESSAGE_SIZE {
                    continue;
                }

                match handle_message(
                    &server,
                    &raw,
                    &env,
                    cur_peer_key.as_deref(),
                    cur_network.as_deref(),
                )
                .await
                {
                    Ok(Some((pk, net, pid))) => {
                        cur_peer_key = Some(pk);
                        cur_network = Some(net);
                        cur_peer_id = Some(pid);
                    }
                    Ok(None) => {}
                    Err(e) => {
                        console_error!("[WS] handler error: {:?}", e);
                        let payload = make_envelope(
                            "error",
                            cur_network.as_deref().unwrap_or(""),
                            &relay_id(&env),
                            cur_peer_id.as_deref(),
                            json!({ "error": e.to_string() }),
                        );
                        let _ = server.send_with_str(&payload);
                    }
                }
            }

            // Close or stream error → exit the loop and clean up.
            Ok(WebsocketEvent::Close(_)) | Err(_) => break,
        }
    }

    // ── Cleanup on disconnect ────────────────────────────────────────────────
    let (net, pid) = match (cur_network, cur_peer_id) {
        (Some(n), Some(p)) => (n, p),
        _ => return,
    };

    let key = format!("{}:{}", net, pid);

    LIVE_PEERS.with(|m| m.borrow_mut().remove(&key));
    NET_SUBS.with(|s| {
        if let Some(set) = s.borrow_mut().get_mut(&net) {
            set.remove(&key);
        }
    });

    if let Ok(db) = env.d1("DB") {
        let _ = db_delete_announcement(&db, &net, &pid).await;
        let _ = db_broadcast_peer_list(&db, &net).await;
    }
}

// ─── Message dispatcher ──────────────────────────────────────────────────────

/// Returns `Ok(Some((peer_key, network, peer_id)))` on a valid message, or
/// `Ok(None)` if the message was silently dropped.
async fn handle_message(
    socket: &WebSocket,
    raw: &str,
    env: &Env,
    prev_key: Option<&str>,
    prev_network: Option<&str>,
) -> Result<Option<(String, String, String)>> {
    let rid = relay_id(env);

    // ── Parse ────────────────────────────────────────────────────────────────
    let message: PspMessage = match serde_json::from_str(raw) {
        Ok(m) => m,
        Err(_) => {
            let payload =
                make_envelope("error", "", &rid, Some("client"), json!({ "error": "Invalid JSON" }));
            let _ = socket.send_with_str(&payload);
            return Ok(None);
        }
    };

    if !valid_envelope(&message) {
        let payload = make_envelope(
            "error",
            &message.network,
            &rid,
            Some(&message.from),
            json!({ "error": "Invalid PSP envelope" }),
        );
        let _ = socket.send_with_str(&payload);
        return Ok(None);
    }

    let network = message.network.clone();
    let peer_id = message.from.clone();
    let msg_type = message.msg_type.clone();
    let peer_key = format!("{}:{}", network, peer_id);

    // ── Network subscription ─────────────────────────────────────────────────
    let network_changed = prev_key.is_none() || prev_network != Some(network.as_str());
    if network_changed {
        // Unsubscribe from old network if switching.
        if let Some(pn) = prev_network {
            if pn != network {
                NET_SUBS.with(|s| {
                    if let Some(set) = s.borrow_mut().get_mut(pn) {
                        if let Some(pk) = prev_key {
                            set.remove(pk);
                        }
                    }
                });
            }
        }
        NET_SUBS.with(|s| {
            s.borrow_mut()
                .entry(network.clone())
                .or_insert_with(HashSet::new)
                .insert(peer_key.clone());
        });
        console_log!("[NET] {} subscribed to {}", peer_id, network);
    }

    // ── Register live peer ───────────────────────────────────────────────────
    // Clone the WebSocket handle (increments the JS ref-count, no syscall).
    LIVE_PEERS.with(|m| {
        m.borrow_mut()
            .insert(peer_key.clone(), PeerEntry { socket: socket.clone() });
    });

    let db = env.d1("DB").ok();

    // ── Dispatch ─────────────────────────────────────────────────────────────
    match msg_type.as_str() {
        "announce" => {
            if let Some(ref db) = db {
                db_upsert_announcement(db, &message).await?;
                db_deliver_queued(db, socket, &network, &peer_id).await?;
            }
            // Only broadcast when the peer is newly joining, not on
            // keep-alive re-announces (saves CPU for every subscribed browser).
            let is_heartbeat = prev_key == Some(peer_key.as_str());
            if !is_heartbeat {
                if let Some(ref db) = db {
                    let _ = db_broadcast_peer_list(db, &network).await;
                }
            }
        }

        "withdraw" => {
            LIVE_PEERS.with(|m| m.borrow_mut().remove(&peer_key));
            if let Some(ref db) = db {
                db_delete_announcement(db, &network, &peer_id).await?;
                let _ = db_broadcast_peer_list(db, &network).await;
            }
        }

        "discover" => {
            if let Some(ref db) = db {
                let _ = db_broadcast_peer_list(db, &network).await;
            }
        }

        "ping" => {
            let pong = make_envelope("pong", &network, &rid, Some(&peer_id), json!({}));
            let _ = socket.send_with_str(&pong);
            if let Some(ref db) = db {
                db_deliver_queued(db, socket, &network, &peer_id).await?;
            }
        }

        "bye" => {
            LIVE_PEERS.with(|m| m.borrow_mut().remove(&peer_key));
            if let Some(ref db) = db {
                db_delete_announcement(db, &network, &peer_id).await?;
                let _ = db_broadcast_peer_list(db, &network).await;
            }
        }

        t if is_relay_type(t) => {
            let to_peer = match &message.to {
                Some(p) => p.clone(),
                // No recipient → nothing to relay; just return state.
                None => return Ok(Some((peer_key, network, peer_id))),
            };

            // Try immediate in-memory delivery first (cheapest path for
            // browsers – no DB round-trip, lowest latency).
            let live_key = format!("{}:{}", network, to_peer);
            // Borrow briefly to clone the socket handle; drop borrow before await.
            let live_sock =
                LIVE_PEERS.with(|m| m.borrow().get(&live_key).map(|p| p.socket.clone()));

            let mut delivered = false;
            if let Some(sock) = live_sock {
                if sock.send_with_str(raw).is_ok() {
                    delivered = true;
                    console_log!(
                        "[RELAY] {} from {} → {} (live)",
                        msg_type,
                        peer_id,
                        to_peer
                    );
                }
            }

            if !delivered {
                if let Some(ref db) = db {
                    db_insert_relay(db, &message).await?;
                    console_log!("[RELAY] {} for {} queued (offline)", msg_type, to_peer);
                } else {
                    console_warn!(
                        "[RELAY] {} for {} dropped; no DB and peer offline",
                        msg_type,
                        to_peer
                    );
                }
            }
        }

        _ => {} // unknown type already rejected by valid_envelope
    }

    // Opportunistic expiry sweep (same semantics as the JS version).
    if let Some(ref db) = db {
        let _ = db_cleanup_expired(db).await;
    }

    Ok(Some((peer_key, network, peer_id)))
}

// ─── D1 database helpers ─────────────────────────────────────────────────────

async fn db_upsert_announcement(db: &D1Database, msg: &PspMessage) -> Result<()> {
    let now = now_ms();
    let ttl = msg.ttl_ms.unwrap_or(DEFAULT_TTL_MS).min(MAX_TTL_MS);
    let expires_at = now + ttl as i64;

    db.prepare(
        "INSERT INTO psp_announcements \
             (network, peer_id, session_id, expires_at_ms, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(network, peer_id) DO UPDATE SET \
             session_id    = excluded.session_id, \
             expires_at_ms = excluded.expires_at_ms, \
             updated_at_ms = excluded.updated_at_ms",
    )
    .bind(&[
        JsValue::from_str(&msg.network),
        JsValue::from_str(&msg.from),
        msg.session_id
            .as_deref()
            .map_or(JsValue::NULL, JsValue::from_str),
        JsValue::from_f64(expires_at as f64),
        JsValue::from_f64(now as f64),
    ])?
    .run()
    .await?;
    Ok(())
}

async fn db_delete_announcement(db: &D1Database, network: &str, peer_id: &str) -> Result<()> {
    db.prepare("DELETE FROM psp_announcements WHERE network = ?1 AND peer_id = ?2")
        .bind(&[JsValue::from_str(network), JsValue::from_str(peer_id)])?
        .run()
        .await?;
    Ok(())
}

/// Push the current peer list to every subscriber in the network.
async fn db_broadcast_peer_list(db: &D1Database, network: &str) -> Result<()> {
    let now = now_ms();

    let rows = db
        .prepare(
            "SELECT peer_id, session_id, updated_at_ms \
             FROM psp_announcements \
             WHERE network = ?1 AND expires_at_ms > ?2 \
             ORDER BY peer_id ASC \
             LIMIT ?3",
        )
        .bind(&[
            JsValue::from_str(network),
            JsValue::from_f64(now as f64),
            JsValue::from_f64(MAX_BATCH as f64),
        ])?
        .all()
        .await?
        .results::<AnnouncementRow>()?;

    let peers: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "peer_id":    r.peer_id,
                "session_id": r.session_id,
                "timestamp":  r.updated_at_ms,
            })
        })
        .collect();

    let payload = make_envelope(
        "peer_list",
        network,
        "bootstrap-relay",
        None,
        json!({ "peers": peers }),
    );

    // Collect subscriber keys without holding the RefCell borrow during send.
    let keys: Vec<String> = NET_SUBS.with(|s| {
        s.borrow()
            .get(network)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    });

    for key in &keys {
        // Brief borrow to clone the socket; borrow is released before the next
        // iteration so there is never a borrow across any await point.
        let sock = LIVE_PEERS.with(|m| m.borrow().get(key.as_str()).map(|p| p.socket.clone()));
        if let Some(sock) = sock {
            let _ = sock.send_with_str(&payload);
        }
    }

    Ok(())
}

async fn db_insert_relay(db: &D1Database, msg: &PspMessage) -> Result<()> {
    let now = now_ms();
    let ttl = msg.ttl_ms.unwrap_or(DEFAULT_TTL_MS).min(MAX_TTL_MS);
    let expires_at = now + ttl as i64;
    let json_str =
        serde_json::to_string(msg).map_err(|e| Error::RustError(e.to_string()))?;

    db.prepare(
        "INSERT INTO psp_relay \
             (network, to_peer_id, type, session_id, message_json, expires_at_ms, created_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&[
        JsValue::from_str(&msg.network),
        JsValue::from_str(msg.to.as_deref().unwrap_or("")),
        JsValue::from_str(&msg.msg_type),
        msg.session_id
            .as_deref()
            .map_or(JsValue::NULL, JsValue::from_str),
        JsValue::from_str(&json_str),
        JsValue::from_f64(expires_at as f64),
        JsValue::from_f64(now as f64),
    ])?
    .run()
    .await?;
    Ok(())
}

async fn db_deliver_queued(
    db: &D1Database,
    socket: &WebSocket,
    network: &str,
    peer_id: &str,
) -> Result<usize> {
    let now = now_ms();

    let rows = db
        .prepare(
            "SELECT id, message_json \
             FROM psp_relay \
             WHERE network = ?1 AND to_peer_id = ?2 AND expires_at_ms > ?3 \
             ORDER BY created_at_ms ASC \
             LIMIT ?4",
        )
        .bind(&[
            JsValue::from_str(network),
            JsValue::from_str(peer_id),
            JsValue::from_f64(now as f64),
            JsValue::from_f64(MAX_BATCH as f64),
        ])?
        .all()
        .await?
        .results::<RelayRow>()?;

    if rows.is_empty() {
        return Ok(0);
    }

    console_log!("[OUT] Delivering {} queued messages to {}", rows.len(), peer_id);

    let mut delivered_ids: Vec<i64> = Vec::new();
    for row in &rows {
        if socket.send_with_str(&row.message_json).is_ok() {
            delivered_ids.push(row.id);
        }
    }

    if !delivered_ids.is_empty() {
        db_delete_relay_ids(db, &delivered_ids).await?;
    }

    Ok(delivered_ids.len())
}

async fn db_delete_relay_ids(db: &D1Database, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders: String = (1..=ids.len())
        .map(|i| format!("?{}", i))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("DELETE FROM psp_relay WHERE id IN ({})", placeholders);
    let binds: Vec<JsValue> = ids.iter().map(|id| JsValue::from_f64(*id as f64)).collect();
    db.prepare(&sql).bind(&binds)?.run().await?;
    Ok(())
}

async fn db_cleanup_expired(db: &D1Database) -> Result<()> {
    let now = JsValue::from_f64(now_ms() as f64);
    db.prepare("DELETE FROM psp_announcements WHERE expires_at_ms <= ?1")
        .bind(&[now.clone()])?
        .run()
        .await?;
    db.prepare("DELETE FROM psp_relay WHERE expires_at_ms <= ?1")
        .bind(&[now])?
        .run()
        .await?;
    Ok(())
}
