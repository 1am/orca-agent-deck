// Shared by the Property Inspectors: socket setup plus context tagging.
// OpenDeck mounts a hidden PI per action; the plugin tags each reply with the action id it is for,
// and this PI keeps only replies of its own type that carry its own context.
window.connectPi = (replyType, onReply) => {
  let ws, uuid;
  const send = (msg) =>
    ws.send(JSON.stringify({ event: 'sendToPlugin', context: uuid, payload: msg }));
  window.connectElgatoStreamDeckSocket = (port, id, registerEvent) => {
    uuid = id;
    ws = new WebSocket('ws://127.0.0.1:' + port);
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: registerEvent, uuid }));
      send({ type: 'load' });
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.event !== 'sendToPropertyInspector') return;
      if (m.payload.type !== replyType || m.payload.context !== uuid) return;
      onReply(m.payload);
    };
  };
  // The host app opens links for the inspector (`openUrl` is part of both hosts' inspector protocol).
  send.openUrl = (url) => ws.send(JSON.stringify({ event: 'openUrl', payload: { url } }));
  return send;
};
