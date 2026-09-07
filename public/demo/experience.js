(() => {
  'use strict';
  const root = document.getElementById('demo');
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const activity = (text) => {
    $('activity').textContent = text;
  };
  let chatSession = null;
  let chatBusy = false;
  let voice = null;
  let eventSession;
  try {
    const key = `demo-view:${location.pathname}`;
    eventSession = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, eventSession);
  } catch {
    eventSession = crypto.randomUUID();
  }

  function track(kind) {
    if (!root.dataset.events) return;
    void fetch(root.dataset.events, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: eventSession, kind }),
      keepalive: true,
    }).catch(() => {});
  }
  track('opened');

  async function request(path, body, session, keepalive = false) {
    const response = await fetch(`${root.dataset.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-demo-csrf': root.dataset.csrf,
        ...(session ? { 'x-demo-session': session.token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      keepalive,
      signal: keepalive ? undefined : AbortSignal.timeout(35000),
    });
    if (response.status === 204) return {};
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || 'The connection failed. Please try again.');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function endRemote(session, keepalive = false) {
    if (session)
      void request(`/sessions/${session.id}/end`, {}, session, keepalive).catch(() => {});
  }

  function showBooking(booking) {
    if (!booking || booking.simulated !== true) return;
    $('booking-service').textContent = booking.service;
    $('booking-slot').textContent = `${booking.slot} · ${booking.confirmation}`;
    $('booking-card').hidden = false;
    activity('A demo appointment was captured from the conversation.');
  }

  function addMessage(container, role, text) {
    const element = document.createElement('div');
    element.className = `chat-message ${role}`;
    element.textContent = text;
    container.append(element);
    container.scrollTop = container.scrollHeight;
    return element;
  }

  function openChat() {
    if (!$('chat-panel')) return;
    $('chat-panel').hidden = false;
    $('chat-launcher').setAttribute('aria-expanded', 'true');
    $('chat-input').focus({ preventScroll: true });
  }
  $('chat-launcher')?.addEventListener('click', () => {
    if ($('chat-panel').hidden) openChat();
    else {
      $('chat-panel').hidden = true;
      $('chat-launcher').setAttribute('aria-expanded', 'false');
    }
  });
  $('close-chat')?.addEventListener('click', () => {
    $('chat-panel').hidden = true;
    $('chat-launcher').setAttribute('aria-expanded', 'false');
    $('chat-launcher').focus();
  });
  document
    .querySelectorAll('[data-open-chat]')
    .forEach((button) => button.addEventListener('click', openChat));

  async function sendMessage(message) {
    openChat();
    if (chatBusy || !$('chat-input') || $('chat-input').disabled || !message.trim()) return;
    chatBusy = true;
    $('send-chat').disabled = true;
    $('reset-chat').disabled = true;
    $('chat-error').hidden = true;
    $('chat-suggestions').hidden = true;
    addMessage($('chat-messages'), 'user', message);
    $('chat-input').value = '';
    const pending = addMessage($('chat-messages'), 'assistant typing', 'Thinking…');
    activity('Your website assistant is responding to a visitor.');
    try {
      if (!chatSession) chatSession = await request('/sessions', { channel: 'chat' });
      const result = await request(`/sessions/${chatSession.id}/message`, { message }, chatSession);
      pending.classList.remove('typing');
      pending.textContent = result.message;
      $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
      activity('Your AI assistant answered the visitor.');
      showBooking(result.booking);
      track('chatbot_tested');
    } catch (error) {
      pending.remove();
      $('chat-error').textContent = error.message || 'The assistant could not respond.';
      $('chat-error').hidden = false;
      $('chat-input').value = message;
      if ([401, 404, 410].includes(error.status)) {
        endRemote(chatSession);
        chatSession = null;
      }
      activity('Chat needs attention. Check the message in the chat window.');
    } finally {
      chatBusy = false;
      $('send-chat').disabled = false;
      $('reset-chat').disabled = false;
      $('chat-input').focus({ preventScroll: true });
    }
  }
  $('chat-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage($('chat-input').value.trim());
  });
  document.querySelectorAll('[data-prompt]').forEach((button) =>
    button.addEventListener('click', () => {
      void sendMessage(button.dataset.prompt);
    }),
  );
  $('reset-chat')?.addEventListener('click', () => {
    if (chatBusy) return;
    endRemote(chatSession);
    chatSession = null;
    $('chat-messages').replaceChildren();
    addMessage(
      $('chat-messages'),
      'assistant',
      `Hi! Welcome to ${root.dataset.name}. What can I help you with today?`,
    );
    $('chat-error').hidden = true;
    $('chat-suggestions').hidden = false;
    $('chat-input').value = '';
    $('chat-input').focus();
    activity('A fresh chat is ready.');
  });

  function voiceStatus(text, speaking = false) {
    if (!$('voice-status')) return;
    $('voice-status').textContent = text;
    $('waveform').classList.toggle('active', speaking);
    $('voice-orb').classList.toggle('speaking', Boolean(voice) && speaking);
    $('voice-orb').classList.toggle('listening', Boolean(voice) && !speaking);
  }
  function transcript(state, role, id, text, append = false) {
    if (!text) return;
    const key = `${role}:${id}`;
    let entry = state.transcripts.get(key);
    if (!entry) {
      $('voice-transcript').querySelector('.transcript-empty')?.remove();
      const row = document.createElement('p');
      const label = document.createElement('strong');
      label.textContent = role === 'user' ? 'You' : 'Receptionist';
      entry = document.createElement('span');
      row.append(label, entry);
      $('voice-transcript').append(row);
      state.transcripts.set(key, entry);
    }
    entry.textContent = append ? entry.textContent + text : text;
    $('voice-transcript').scrollTop = $('voice-transcript').scrollHeight;
  }

  function stopVoice(message = 'Conversation ended', keepalive = false) {
    const state = voice;
    voice = null;
    if (state) {
      state.cancelled = true;
      clearInterval(state.timer);
      clearInterval(state.poll);
      state.stream?.getTracks().forEach((track) => track.stop());
      state.pc?.getReceivers().forEach((receiver) => receiver.track?.stop());
      state.pc?.close();
      endRemote(state.session, keepalive);
    }
    if (!$('start-call')) return;
    $('receptionist-audio').srcObject = null;
    $('start-call').hidden = false;
    $('start-call').disabled = false;
    $('end-call').hidden = true;
    $('mute-call').hidden = true;
    $('play-audio').hidden = true;
    $('mute-call').textContent = 'Mute microphone';
    voiceStatus(message);
  }

  async function startVoice() {
    if (voice) return;
    if (
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      !window.RTCPeerConnection
    ) {
      voiceStatus('Use Chrome, Edge, or Safari on HTTPS (or localhost) to talk.');
      return;
    }
    const state = { cancelled: false, transcripts: new Map(), polling: false };
    voice = state;
    $('start-call').disabled = true;
    $('start-call').hidden = true;
    $('end-call').hidden = false;
    voiceStatus('Allow your microphone to begin');
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (state.cancelled) {
        state.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      voiceStatus('Connecting your receptionist…');
      state.session = await request('/sessions', { channel: 'voice' });
      if (state.cancelled) {
        endRemote(state.session);
        return;
      }
      const pc = new RTCPeerConnection();
      state.pc = pc;
      state.stream.getTracks().forEach((track) => pc.addTrack(track, state.stream));
      pc.ontrack = (event) => {
        if (state.cancelled) return;
        $('receptionist-audio').srcObject = event.streams[0] || new MediaStream([event.track]);
        void $('receptionist-audio')
          .play()
          .catch(() => {
            $('play-audio').hidden = false;
          });
      };
      pc.onconnectionstatechange = () => {
        if (state.cancelled) return;
        if (pc.connectionState === 'connected') {
          voiceStatus('Connected · Go ahead, say hello');
          activity('A visitor is speaking with your AI receptionist.');
        }
        if (pc.connectionState === 'failed')
          stopVoice('Connection lost. Start a new conversation.');
      };
      const dc = pc.createDataChannel('oai-events');
      // Request the greeting only after the browser's media/data connection is open.
      dc.onopen = () => {
        if (!state.cancelled) dc.send(JSON.stringify({ type: 'response.create' }));
      };
      dc.onmessage = (message) => {
        if (state.cancelled) return;
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        if (event.type === 'input_audio_buffer.speech_started')
          voiceStatus('Listening to you…', true);
        if (event.type === 'input_audio_buffer.speech_stopped') voiceStatus('Thinking…');
        if (event.type === 'conversation.item.input_audio_transcription.completed')
          transcript(state, 'user', event.item_id, event.transcript);
        if (event.type === 'response.output_audio_transcript.delta') {
          transcript(state, 'assistant', event.item_id, event.delta, true);
          voiceStatus('Your receptionist is speaking', true);
        }
        if (event.type === 'response.output_audio_transcript.done')
          transcript(state, 'assistant', event.item_id, event.transcript);
        if (event.type === 'output_audio_buffer.stopped')
          voiceStatus('Listening · What would you like to ask?');
        if (event.type === 'response.done' && event.response?.status === 'failed')
          stopVoice('The voice service could not respond. Please try again.');
        if (event.type === 'error')
          stopVoice('The voice service reported an error. Start a new conversation.');
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (state.cancelled) return;
      const result = await request(
        `/sessions/${state.session.id}/voice`,
        { sdp: pc.localDescription.sdp },
        state.session,
      );
      if (state.cancelled) {
        endRemote(state.session);
        return;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      $('mute-call').hidden = false;
      track('voice_previewed');
      const deadline = Date.parse(result.expiresAt);
      state.timer = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        $('call-clock').textContent =
          `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
        if (!remaining) stopVoice('Demo time complete. You can start another conversation.');
      }, 1000);
      state.poll = setInterval(async () => {
        if (state.polling || state.cancelled) return;
        state.polling = true;
        try {
          const status = await request(`/sessions/${state.session.id}`, undefined, state.session);
          if (state.cancelled) return;
          showBooking(status.booking);
          if (status.ended) stopVoice('Conversation ended. Start a new call when ready.');
        } catch {
          if (!state.cancelled) stopVoice('Connection interrupted. Start a new conversation.');
        } finally {
          state.polling = false;
        }
      }, 2000);
    } catch (error) {
      if (state.cancelled) return;
      stopVoice(
        error.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow it in your browser and try again.'
          : error.message || 'Could not connect. Please try again.',
      );
    }
  }
  $('start-call')?.addEventListener('click', () => {
    void startVoice();
  });
  $('end-call')?.addEventListener('click', () => {
    stopVoice();
    activity('Voice conversation ended.');
  });
  $('mute-call')?.addEventListener('click', () => {
    const track = voice?.stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('mute-call').textContent = track.enabled ? 'Mute microphone' : 'Unmute microphone';
    $('mute-call').setAttribute('aria-pressed', String(!track.enabled));
  });
  $('play-audio')?.addEventListener('click', () => {
    void $('receptionist-audio')
      .play()
      .then(() => {
        $('play-audio').hidden = true;
      })
      .catch(() => {
        voiceStatus('Check your browser audio permission and try Play again.');
      });
  });
  window.addEventListener('pagehide', () => {
    if (voice) stopVoice('Conversation ended', true);
    endRemote(chatSession, true);
  });
  $('present')?.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      activity(
        'Fullscreen is not available in this browser. You can use your browser’s presentation controls.',
      );
    }
  });
  document.addEventListener('fullscreenchange', () => {
    $('present').textContent = document.fullscreenElement
      ? 'Exit fullscreen'
      : 'Present fullscreen';
  });
  $('calculate')?.addEventListener('click', () => {
    const inputs = [...document.querySelectorAll('[data-roi]')];
    if (inputs.some((input) => !input.value || !input.reportValidity())) return;
    const [missed, recovered, qualified, closed, value, margin, fee] = inputs.map((input) =>
      Number(input.value),
    );
    const jobs = (((((missed * recovered) / 100) * qualified) / 100) * closed) / 100;
    const revenue = jobs * value;
    const contribution = (revenue * margin) / 100;
    const dollars = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });
    $('roi-result').textContent =
      `Hypothetical monthly scenario: ${jobs.toFixed(1)} additional jobs · ${dollars.format(revenue)} collected revenue · ${dollars.format(contribution - fee)} contribution after the ${dollars.format(fee)} fee. These are assumptions, not promised results.`;
    track('roi_used');
  });
})();
