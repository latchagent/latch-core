/**
 * @module notification-sound
 * @description Synthesizes a quick two-tone "ba-beep" (~150ms) via the Web Audio API.
 * Reuses a single AudioContext instance to avoid creating new contexts on every call.
 */

let ctx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/**
 * Play a short two-tone notification beep (~150ms total).
 * First tone: 520 Hz for 70ms, second tone: 780 Hz for 80ms.
 */
export function playNotificationSound(): void {
  try {
    const ac = getContext();
    if (ac.state === 'suspended') ac.resume();
    const now = ac.currentTime;

    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.15);
    gain.connect(ac.destination);

    // First tone: 520 Hz, 0–70ms
    const osc1 = ac.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = 520;
    osc1.connect(gain);
    osc1.start(now);
    osc1.stop(now + 0.07);

    // Second tone: 780 Hz, 70–150ms
    const osc2 = ac.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 780;
    osc2.connect(gain);
    osc2.start(now + 0.07);
    osc2.stop(now + 0.15);
  } catch {
    // Silently ignore — audio may be unavailable
  }
}
