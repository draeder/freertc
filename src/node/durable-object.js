// A Durable Object namespace for a relay running under Node: one instance per
// name, in this process. It covers what the relay's objects use: fetch(), and
// the WebSocket hibernation API (acceptWebSocket with tags, getWebSockets,
// serialize/deserializeAttachment, setWebSocketAutoResponse, and the
// webSocketMessage / webSocketClose / webSocketError handlers). Nothing
// hibernates here; the process simply keeps the object.

function createState(instanceOf) {
  const sockets = new Map(); // socket → tags
  let autoResponse = null;
  return {
    acceptWebSocket(socket, tags = []) {
      sockets.set(socket, [...tags]);
      socket.accept?.();
      socket.addEventListener('message', (event) => {
        if (autoResponse && event.data === autoResponse.request) {
          try { socket.send(autoResponse.response); } catch {}
          return;
        }
        return instanceOf().webSocketMessage?.(socket, event.data);
      });
      socket.addEventListener('close', (event) => {
        if (!sockets.delete(socket)) return;
        return instanceOf().webSocketClose?.(socket, event.code, event.reason, true);
      });
      socket.addEventListener('error', (event) => {
        if (!sockets.has(socket)) return;
        return instanceOf().webSocketError?.(socket, event.error);
      });
    },
    getWebSockets(tag) {
      return [...sockets].filter(([, tags]) => tag === undefined || tags.includes(tag)).map(([socket]) => socket);
    },
    setWebSocketAutoResponse(pair) {
      autoResponse = pair ?? null;
    },
  };
}

export function nodeDurableNamespace(ObjectClass, env) {
  const instances = new Map();
  const instance = (name) => {
    let object = instances.get(name);
    if (!object) {
      object = new ObjectClass(createState(() => instances.get(name)), env);
      instances.set(name, object);
    }
    return object;
  };
  return {
    idFromName: (name) => String(name),
    get: (id) => ({
      fetch: (input, init) => instance(String(id)).fetch(input instanceof Request && !init ? input : new Request(input, init)),
    }),
  };
}
