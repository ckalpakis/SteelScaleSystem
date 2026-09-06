(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var clientId = script.getAttribute('data-client-id');
  var apiBase = (script.getAttribute('data-api-base') || new URL(script.src).origin).replace(
    /\/$/,
    '',
  );
  var assistantName = script.getAttribute('data-assistant-name') || 'Steel Scale assistant';
  if (!clientId) {
    window.console.error('Steel Scale chatbot requires data-client-id.');
    return;
  }

  var sessionKey = 'steel-scale-chat-session:' + clientId;
  var transcriptKey = sessionKey + ':messages';
  var sessionId = window.localStorage.getItem(sessionKey);
  if (!sessionId) {
    sessionId =
      window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
    window.localStorage.setItem(sessionKey, sessionId);
  }

  var host = document.createElement('div');
  host.style.cssText =
    'position:fixed;right:clamp(14px,2.5vw,28px);bottom:clamp(14px,2.5vw,28px);z-index:2147483647';
  document.body.appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var safeName = assistantName.replace(/[<>&"]/g, '');

  root.innerHTML = [
    '<style>',
    '*{box-sizing:border-box}button,textarea{font:inherit}',
    ':host{--ink:#07131f;--panel:#10283c;--blue:#2878ff;--cyan:#6cebff;--cloud:#f3f7fa;--line:#d7e1e7;font-family:Inter,system-ui,-apple-system,sans-serif;color:var(--ink)}',
    '.launcher{display:flex;align-items:center;gap:11px;margin-left:auto;border:1px solid #6cebff59;border-radius:15px;padding:9px 11px 9px 9px;background:var(--ink);color:#fff;box-shadow:0 18px 48px #07131f4a;cursor:pointer;transition:transform .18s ease,background .18s ease}',
    '.launcher:hover{transform:translateY(-2px);background:#0d2031}.launcher:focus-visible,.close:focus-visible,.send:focus-visible,.choice:focus-visible,textarea:focus-visible{outline:3px solid #ff7448;outline-offset:3px}',
    '.launcher-icon{width:40px;height:40px;display:grid;place-items:center;border-radius:10px;background:linear-gradient(145deg,var(--blue),#1559d6);color:var(--cyan)}.launcher-icon svg{width:21px}.launcher-copy{display:grid;text-align:left;line-height:1.15}.launcher-copy strong{font:700 13px/1.2 "Space Grotesk",Inter,sans-serif}.launcher-copy small{margin-top:4px;color:#a9bdc9;font-size:10px}.status-dot{width:7px;height:7px;margin-right:5px;display:inline-block;border-radius:50%;background:var(--cyan);box-shadow:0 0 9px var(--cyan)}',
    '.panel{display:none;position:absolute;right:0;bottom:70px;width:min(390px,calc(100vw - 28px));height:min(610px,calc(100vh - 105px));overflow:hidden;background:#fff;border:1px solid #cddbe3;border-radius:18px;box-shadow:0 25px 80px #07131f59}.panel.open{display:flex;flex-direction:column}',
    '.head{min-height:88px;padding:17px 18px;display:flex;align-items:center;gap:12px;color:#fff;background:var(--ink);border-bottom:1px solid #6cebff2e}.agent-mark{width:42px;height:42px;flex:none;display:grid;place-items:center;border:1px solid #6cebff59;border-radius:12px;background:#10283c;color:var(--cyan);font:700 18px "Space Grotesk",sans-serif}.identity{min-width:0;display:grid}.identity strong{font:700 15px "Space Grotesk",sans-serif}.identity span{margin-top:3px;color:#a9bdc9;font-size:11px}.close{width:36px;height:36px;margin-left:auto;border:0;border-radius:9px;background:#ffffff12;color:#fff;font-size:24px;line-height:1;cursor:pointer}.close:hover{background:#ffffff20}',
    '.thread{flex:1;overflow-y:auto;padding:18px;background:linear-gradient(180deg,#f7fafc,#f3f7fa);scroll-behavior:smooth}.day{margin:0 0 14px;color:#718592;text-align:center;font-size:9px;font-weight:700}.msg-row{display:flex;gap:7px;align-items:flex-end;margin:0 0 11px}.msg-row.user{justify-content:flex-end}.bot-avatar{width:22px;height:22px;flex:none;display:grid;place-items:center;border-radius:7px;background:var(--panel);color:var(--cyan);font-size:9px;font-weight:700}.msg{max-width:82%;padding:10px 12px;border-radius:5px 13px 13px 13px;line-height:1.48;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.bot .msg{background:#fff;border:1px solid var(--line);box-shadow:0 4px 12px #07131f0a}.user .msg{color:#fff;background:var(--blue);border-radius:13px 5px 13px 13px}.error .msg{color:#991b1b;background:#fff1f1;border:1px solid #fecaca}',
    '.typing{display:flex;gap:4px;align-items:center;height:34px}.typing i{width:5px;height:5px;border-radius:50%;background:#72909f;animation:pulse 1.1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}.choices{padding:0 18px 12px;display:flex;gap:7px;overflow-x:auto;background:var(--cloud)}.choice{flex:none;border:1px solid #9cb1bd;border-radius:999px;padding:7px 11px;color:#17364a;background:#fff;font-size:11px;font-weight:600;cursor:pointer}.choice:hover{border-color:var(--blue);color:var(--blue)}',
    '.form{padding:12px;display:grid;grid-template-columns:1fr 43px;gap:8px;align-items:end;background:#fff;border-top:1px solid var(--line)}.input{width:100%;max-height:96px;min-height:43px;resize:none;border:1px solid #bdccd5;border-radius:11px;padding:11px 12px;color:var(--ink);background:#fff;line-height:1.35;font-size:13px}.input::placeholder{color:#7c8f9a}.send{width:43px;height:43px;border:0;border-radius:11px;display:grid;place-items:center;background:var(--blue);color:#fff;cursor:pointer}.send svg{width:18px}.send:hover{background:#1559d6}.send:disabled{opacity:.45;cursor:wait}.privacy{grid-column:1/-1;margin:0 2px;color:#82939d;font-size:9px}',
    '@keyframes pulse{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}@media(max-width:480px){.launcher-copy{display:none}.launcher{padding:8px}.launcher-icon{width:43px;height:43px}.panel{position:fixed;inset:10px;width:auto;height:auto;max-height:none;border-radius:16px}.head{min-height:76px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}',
    '</style>',
    '<section class="panel" role="dialog" aria-modal="false" aria-label="Chat with ' +
      safeName +
      '"><header class="head"><span class="agent-mark" aria-hidden="true">SS</span><span class="identity"><strong>' +
      safeName +
      '</strong><span><i class="status-dot"></i>Online now</span></span><button class="close" type="button" aria-label="Close chat">&times;</button></header><div class="thread" role="log" aria-live="polite" aria-relevant="additions"><p class="day">Today</p></div><div class="choices" aria-label="Suggested messages"><button class="choice" type="button">I miss customer calls</button><button class="choice" type="button">I need a website</button><button class="choice" type="button">Book a consultation</button></div><form class="form"><textarea class="input" rows="1" aria-label="Message" placeholder="How can we help?" maxlength="4000"></textarea><button class="send" type="submit" aria-label="Send message"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button><p class="privacy">Please don’t share passwords or payment information.</p></form></section>',
    '<button class="launcher" type="button" aria-label="Open chat" aria-expanded="false"><span class="launcher-icon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14a4 4 0 0 1-4 4H9l-5 3v-7a4 4 0 0 1-1-2.65V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4v7Z" stroke="currentColor" stroke-width="1.7"/><path d="M8 9h8M8 13h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span><span class="launcher-copy"><strong>Chat with our AI</strong><small><i class="status-dot"></i>Replies instantly</small></span></button>',
  ].join('');

  var panel = root.querySelector('.panel');
  var launcher = root.querySelector('.launcher');
  var close = root.querySelector('.close');
  var thread = root.querySelector('.thread');
  var form = root.querySelector('.form');
  var input = root.querySelector('.input');
  var send = root.querySelector('.send');
  var choices = root.querySelector('.choices');
  var messages = [];
  try {
    messages = JSON.parse(window.sessionStorage.getItem(transcriptKey) || '[]');
    if (!Array.isArray(messages)) messages = [];
  } catch (_) {
    messages = [];
  }

  function remember(text, kind) {
    messages.push({ text: text, kind: kind });
    messages = messages.slice(-30);
    window.sessionStorage.setItem(transcriptKey, JSON.stringify(messages));
  }
  function addMessage(text, kind, persist) {
    var row = document.createElement('div');
    row.className = 'msg-row ' + kind;
    if (kind === 'bot') {
      var avatar = document.createElement('span');
      avatar.className = 'bot-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = 'SS';
      row.appendChild(avatar);
    }
    var message = document.createElement('div');
    message.className = 'msg';
    message.textContent = text;
    row.appendChild(message);
    thread.appendChild(row);
    thread.scrollTop = thread.scrollHeight;
    if (persist !== false) remember(text, kind);
  }
  function setOpen(open) {
    panel.classList.toggle('open', open);
    launcher.setAttribute('aria-expanded', String(open));
    launcher.style.display = open ? 'none' : 'flex';
    if (open)
      window.setTimeout(function () {
        input.focus();
      }, 0);
    else launcher.focus();
  }
  if (messages.length)
    messages.forEach(function (message) {
      addMessage(message.text, message.kind, false);
    });
  else
    addMessage(
      'Hi! I can answer questions about our AI systems or help you book a consultation. What would you like to improve?',
      'bot',
    );

  launcher.addEventListener('click', function () {
    setOpen(true);
  });
  close.addEventListener('click', function () {
    setOpen(false);
  });
  root.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
  });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  choices.addEventListener('click', function (event) {
    if (event.target.classList.contains('choice')) {
      input.value = event.target.textContent;
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var value = input.value.trim();
    if (!value || send.disabled) return;
    addMessage(value, 'user');
    input.value = '';
    input.style.height = 'auto';
    input.disabled = true;
    send.disabled = true;
    choices.style.display = 'none';
    var typing = document.createElement('div');
    typing.className = 'msg-row bot';
    typing.setAttribute('aria-label', 'Assistant is typing');
    typing.innerHTML =
      '<span class="bot-avatar" aria-hidden="true">SS</span><div class="msg typing"><i></i><i></i><i></i></div>';
    thread.appendChild(typing);
    thread.scrollTop = thread.scrollHeight;
    try {
      var response = await fetch(apiBase + '/chatbot/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, session_id: sessionId, message: value }),
      });
      var body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed');
      typing.remove();
      addMessage(body.reply, 'bot');
    } catch (_) {
      typing.remove();
      addMessage(
        'Chat is temporarily unavailable. Call us at (412) 324-4254 or try again in a moment.',
        'error',
      );
    } finally {
      input.disabled = false;
      send.disabled = false;
      input.focus();
    }
  });
})();
