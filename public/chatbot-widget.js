(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var clientId = script.getAttribute('data-client-id');
  var apiBase = (script.getAttribute('data-api-base') || new URL(script.src).origin).replace(
    /\/$/,
    '',
  );
  if (!clientId) {
    window.console.error('SteelScale chatbot requires data-client-id.');
    return;
  }

  var sessionKey = 'steel-scale-chat-session:' + clientId;
  var sessionId = window.localStorage.getItem(sessionKey);
  if (!sessionId) {
    sessionId =
      window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
    window.localStorage.setItem(sessionKey, sessionId);
  }

  var host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.right = '20px';
  host.style.bottom = '20px';
  host.style.zIndex = '2147483647';
  document.body.appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  root.innerHTML = [
    '<style>',
    '*{box-sizing:border-box}button,input{font:inherit}',
    '.bubble{width:58px;height:58px;border:0;border-radius:50%;background:#172554;color:#fff;cursor:pointer;box-shadow:0 10px 28px rgba(15,23,42,.28);font-size:24px}',
    '.panel{display:none;position:absolute;right:0;bottom:72px;width:min(360px,calc(100vw - 32px));height:500px;max-height:calc(100vh - 110px);background:#fff;border:1px solid #dbe3ee;border-radius:16px;overflow:hidden;box-shadow:0 18px 55px rgba(15,23,42,.22);font-family:system-ui,-apple-system,sans-serif;color:#172033}',
    '.panel.open{display:flex;flex-direction:column}.head{padding:16px 18px;background:#172554;color:#fff;font-weight:700}.thread{flex:1;overflow:auto;padding:16px;background:#f7f9fc}',
    '.msg{max-width:84%;padding:10px 12px;margin:0 0 10px;border-radius:13px;line-height:1.4;font-size:14px;white-space:pre-wrap}.bot{background:#fff;border:1px solid #dbe3ee}.user{margin-left:auto;background:#2563eb;color:#fff}.error{background:#fee2e2;color:#991b1b}',
    '.form{display:flex;gap:8px;padding:12px;border-top:1px solid #dbe3ee;background:#fff}.input{min-width:0;flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:10px}.send{border:0;border-radius:10px;background:#2563eb;color:#fff;padding:0 14px;cursor:pointer}.send:disabled{opacity:.55}',
    '</style>',
    '<section class="panel" aria-label="Booking chat"><div class="head">How can we help?</div><div class="thread" aria-live="polite"></div><form class="form"><input class="input" aria-label="Message" placeholder="Type your message…" autocomplete="off"><button class="send" type="submit">Send</button></form></section>',
    '<button class="bubble" type="button" aria-label="Open chat" aria-expanded="false">✦</button>',
  ].join('');

  var panel = root.querySelector('.panel');
  var bubble = root.querySelector('.bubble');
  var thread = root.querySelector('.thread');
  var form = root.querySelector('.form');
  var input = root.querySelector('.input');
  var send = root.querySelector('.send');

  function addMessage(text, kind) {
    var message = document.createElement('div');
    message.className = 'msg ' + kind;
    message.textContent = text;
    thread.appendChild(message);
    thread.scrollTop = thread.scrollHeight;
  }

  addMessage('Hi! Tell me what you need help with, and I can help arrange an appointment.', 'bot');

  bubble.addEventListener('click', function () {
    var open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    bubble.setAttribute('aria-expanded', String(open));
    bubble.textContent = open ? '×' : '✦';
    if (open) input.focus();
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    input.value = '';
    input.disabled = true;
    send.disabled = true;
    try {
      var response = await fetch(apiBase + '/chatbot/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, session_id: sessionId, message: text }),
      });
      var body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed');
      addMessage(body.reply, 'bot');
    } catch (error) {
      addMessage('Sorry, chat is temporarily unavailable. Please try again.', 'error');
    } finally {
      input.disabled = false;
      send.disabled = false;
      input.focus();
    }
  });
})();
