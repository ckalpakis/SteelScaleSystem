import { escapeHtml as e, type Presentation } from './core.js';

export type LivePageConfig = { base: string; csrf: string; chat: boolean; voice: boolean };
const mic =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
const bubble =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11a9 9 0 0 1-9 9H4l-3 2 2-7a9 9 0 1 1 18-4Z"/><path d="M7 10h10M7 14h6"/></svg>';

export function publicView(
  p: Presentation,
  endpoint: string,
  preview: boolean,
  live?: LivePageConfig,
): string {
  const voice = p.modules.includes('voice');
  const chat = p.modules.includes('chatbot');
  const initial = e(p.businessName.charAt(0));
  const services = p.services.slice(0, 4);
  const name = e(p.businessName);
  const service = e(services[0] || 'a service consultation');
  const ready = Boolean(live?.voice || live?.chat);
  const cards = services
    .map(
      (s) =>
        `<button class="service-tile" data-prompt="${e(`I'd like to ask about ${s}.`)}" ${chat ? '' : 'disabled'}><span class="service-symbol" aria-hidden="true">↗</span><span>${e(s)}</span><small>Ask our assistant</small></button>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${name} · Live experience</title><link rel="stylesheet" href="/demo/assets/experience.css"><script src="/demo/assets/experience.js" defer></script></head>
  <body><div id="demo" data-events="${e(preview ? '' : endpoint)}" data-base="${e(live?.base || '')}" data-csrf="${e(live?.csrf || '')}" data-name="${name}"></div>
  <header class="presenter-bar"><a href="${preview ? '/admin/demos' : '#'}" class="steel-brand"><span class="steel-mark" aria-hidden="true">S</span>Steel Scale<span class="bar-divider"></span><span class="bar-label">Your business, in action</span></a><div class="presentation-actions"><span class="demo-label">Live AI demo · bookings simulated</span><button id="present" class="quiet-button">Present fullscreen</button></div></header>
  <main><div class="intro"><div><p class="intro-context">Built for ${name}</p><h1>Meet your next customer experience.</h1><p>Call your AI receptionist. Ask your website a question. Watch the conversation become an appointment.</p></div><span class="connection-pill"><i class="${ready ? 'ready' : ''}"></i>${ready ? 'Ready to connect' : 'Live AI awaiting setup'}</span></div>
  ${preview ? '<p class="preview-note">PRIVATE ADMIN PREVIEW · Public engagement tracking is off. Live conversations use the AI provider.</p>' : ''}
  <div class="experience-stage ${voice ? '' : 'without-voice'}">
  ${voice ? `<section class="voice-console" aria-labelledby="voice-title" data-module="voice"><div class="console-top"><span class="console-icon">${mic}</span><span>AI receptionist</span><span id="call-clock">03:00</span></div><div class="voice-center"><div id="voice-orb" class="voice-orb">${mic}<div class="orb-ring"></div></div><h2 id="voice-title">${name}</h2><p id="voice-status" role="status">${live?.voice ? 'Ready when you are' : 'Voice is awaiting setup'}</p><div id="waveform" class="waveform" aria-hidden="true">${Array.from({ length: 19 }, (_, i) => `<i style="--bar:${(i * 7) % 19}"></i>`).join('')}</div><button id="start-call" class="call-button" ${live?.voice ? '' : 'disabled'}>${mic} Start conversation</button><button id="end-call" class="end-button" hidden>End conversation</button><button id="mute-call" class="mute-button" hidden>Mute microphone</button><button id="play-audio" class="mute-button" hidden>Play receptionist audio</button><small>Uses your microphone · AI-generated voice<br>Up to 3 minutes per conversation</small></div><div class="call-transcript"><h3>Conversation</h3><div id="voice-transcript" role="log" aria-live="polite"><p class="transcript-empty">Your conversation will appear here as you speak.</p></div></div><div class="try-this"><span>Try saying</span><p>“Hi, I need help with ${service}. Can you get me on the schedule?”</p></div><audio id="receptionist-audio" autoplay></audio></section>` : ''}
  <section class="website-shell" aria-label="Personalized website preview"><div class="browser-chrome"><span class="browser-dots" aria-hidden="true">● ● ●</span><span class="address-bar">${e(p.websiteUrl ? new URL(p.websiteUrl).hostname : p.businessName)} <span>Website preview</span></span></div><div class="website-page"><nav class="business-nav"><a class="business-brand" href="#"><span>${initial}</span>${name}</a><a href="#services">Our services</a>${chat ? '<button class="business-contact" data-open-chat>Let’s talk</button>' : ''}</nav><div class="website-hero"><div class="hero-content"><p class="service-area">${e(p.location || p.niche)}</p><h2>Good service starts with a conversation.</h2><p>${e(p.summary)}</p>${chat ? `<button class="website-cta" data-prompt="${e(`I'd like help with ${p.services[0] || 'a service consultation'}.`)}">Find the right service <span aria-hidden="true">↗</span></button>` : ''}<div class="business-context">${p.hours ? `<span>${e(p.hours)}</span>` : '<span>Ask us about your service needs</span>'}</div></div><div class="service-art" aria-hidden="true"><div class="art-circle"></div><div class="art-monogram">${initial}</div><span>${e(p.niche)}</span></div></div><div class="services-heading" id="services"><h3>How can we help?</h3><p>${p.servicesSource === 'operator' ? 'Services provided by the business owner' : 'Illustrative services for this demo'}</p></div><div class="services-grid">${cards}</div><div class="website-bottom"><strong>${name}</strong><span>Here to help with your next project.</span></div>
  ${chat ? `<div id="chat-panel" class="chat-panel" data-module="chatbot" hidden><div class="chat-header"><span class="assistant-avatar">${initial}</span><div><strong>${name}</strong><small>AI assistant</small></div><button id="reset-chat" aria-label="Start a new chat" title="Start a new chat">↻</button><button id="close-chat" aria-label="Close chat">×</button></div><div id="chat-messages" role="log" aria-live="polite"><div class="chat-message assistant">Hi! Welcome to ${name}. What can I help you with today?</div></div><div id="chat-suggestions"><button data-prompt="What services do you offer?">Explore services</button><button data-prompt="I'd like to try booking a demo appointment.">Book a demo time</button></div><form id="chat-form"><label for="chat-input" class="sr-only">Your message</label><input id="chat-input" maxlength="1500" placeholder="Ask us anything…" autocomplete="off" required ${live?.chat ? '' : 'disabled'}><button id="send-chat" aria-label="Send message" ${live?.chat ? '' : 'disabled'}>↑</button></form><p class="chat-footnote">AI assistant · Demo appointments only</p><p id="chat-error" role="alert" ${live?.chat ? 'hidden' : ''}>${live?.chat ? '' : 'Live chat is awaiting setup by the presenter.'}</p></div><button id="chat-launcher" class="chat-launcher" aria-expanded="false" aria-controls="chat-panel">${bubble}<span>Chat with ${name}</span></button>` : ''}</div></section></div>
  <section class="activity-strip" aria-label="Live demo activity"><div><span class="activity-dot"></span><h2>Watch it happen</h2><p>Activity from your conversation</p></div><div id="activity" role="status">Start a conversation to see the experience unfold.</div><div id="booking-card" hidden><span>Demo appointment</span><strong id="booking-service"></strong><p id="booking-slot"></p><small>No real appointment or message was created.</small></div></section>
  <div class="extras">${p.modules.includes('missed_call') ? `<details><summary>Missed-call recovery <span>Messaging simulation</span></summary><div class="phone-example"><div class="missed-call">Missed call</div><div class="sms-bubble">Thanks for reaching out to ${name}. What can we help you with?</div><p>Illustrative text-back. No SMS is sent.</p></div></details>` : ''}${p.modules.includes('nurture') ? `<details><summary>Lead follow-up <span>Messaging simulation</span></summary><ol class="nurture-timeline"><li><strong>Inquiry received</strong><p>A lead asks about ${service}.</p></li><li><strong>Respond and qualify</strong><p>Ask about their needs and preferred time.</p></li><li><strong>Follow up with consent</strong><p>Stop on reply, booking, handoff, or opt-out. No messages are sent in this demo.</p></li></ol></details>` : ''}${p.modules.includes('audit') ? `<details><summary>Homepage observations <span>${e(p.websiteEvidence.status)}</span></summary><p>${e(p.websiteEvidence.title)}</p>${p.websiteEvidence.observations.map((s) => `<p>${e(s)}</p>`).join('')}<small>${e(p.websiteEvidence.warning)}</small></details>` : ''}${
    p.modules.includes('roi')
      ? `<details><summary>Explore the potential return <span>Editable assumptions</span></summary><div class="roi-grid">${[
          ['Missed calls / month', 20],
          ['Recoverable share (%)', 50],
          ['Qualified / bookable share (%)', 50],
          ['Close rate (%)', 50],
          ['Average collected job value ($)', 1000],
          ['Contribution margin (%)', 40],
          ['Monthly fee ($)', 500],
        ]
          .map(
            ([label, value], i) =>
              `<label>${label}<input data-roi="${i}" type="number" min="0" max="${[1, 2, 3, 5].includes(i) ? 100 : i === 0 ? 100000 : 10000000}" step="any" value="${value}"></label>`,
          )
          .join(
            '',
          )}</div><button id="calculate" class="website-cta">Calculate scenario</button><p id="roi-result" role="status">Hypothetical assumptions, not a forecast.</p></details>`
      : ''
  }</div>
  <footer><strong>A personalized experience by Steel Scale.</strong><p>This is a demonstration for ${name}. Live AI conversations are sent to OpenAI; chat history and simulated bookings are stored separately for the demo. Use fictional details. No real calls to business phone numbers, SMS messages, or appointments are created.</p>${p.googleBusinessProfileUrl ? `<a href="${e(p.googleBusinessProfileUrl)}" rel="noreferrer noopener">Business profile reference</a> · Profile data was not retrieved.` : ''}</footer></main></body></html>`;
}
