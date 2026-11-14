// Shared by the Property Inspectors: socket setup plus context tagging.
// OpenDeck mounts a hidden PI per action; the plugin tags each reply with the action id it is for,
// and this PI keeps only replies of its own type that carry its own context.
// A reply the app drops (the inspector registered late, or `load` reached the plugin before the app announced the
// inspector) must not leave the inspector empty: it asks again every second until `isDone(payload)` holds.
window.connectPi = (replyType, onReply, isDone = () => true) => {
  let ws, uuid, timer;
  /** The ids a reply may be tagged with: the inspector's uuid and the action context (the app's two may differ). */
  const mine = new Set();
  let tries = 0;
  const send = (msg) =>
    ws.send(JSON.stringify({ event: 'sendToPlugin', context: uuid, payload: msg }));
  window.connectElgatoStreamDeckSocket = (port, id, registerEvent, _info, actionInfo) => {
    uuid = id;
    mine.add(id);
    try {
      const context = JSON.parse(actionInfo)?.context;
      if (context) mine.add(context);
    } catch {
      // no action info: the uuid is all there is
    }
    ws = new WebSocket('ws://127.0.0.1:' + port);
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: registerEvent, uuid }));
      send({ type: 'load' });
      timer = setInterval(() => {
        if (++tries > 30 || ws.readyState !== WebSocket.OPEN) clearInterval(timer);
        else send({ type: 'load' });
      }, 1000);
    };
    ws.onmessage = (e) => {
      // Never fail silently: a dropped frame is logged with its reason, a failure shows in the hint line.
      const drop = (why) =>
        console.log('pi: dropped frame (' + why + '): ' + String(e.data).slice(0, 200));
      try {
        const m = JSON.parse(e.data);
        if (m.event !== 'sendToPropertyInspector') return drop('event ' + m.event);
        if (m.payload?.type !== replyType)
          return drop('type ' + m.payload?.type + ', want ' + replyType);
        if (!mine.has(m.payload.context))
          return drop('context ' + m.payload.context + ', mine ' + [...mine].join(' | '));
        if (isDone(m.payload)) clearInterval(timer);
        onReply(m.payload);
      } catch (err) {
        console.log('pi: reply failed: ' + (err?.stack ?? err));
        const hint = document.getElementById('hint');
        if (hint) hint.textContent = 'Inspector error: ' + (err?.message ?? err);
      }
    };
  };
  // The host app opens links for the inspector (`openUrl` is part of both hosts' inspector protocol).
  send.openUrl = (url) => ws.send(JSON.stringify({ event: 'openUrl', payload: { url } }));
  return send;
};
