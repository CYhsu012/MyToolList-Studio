/* ==========================================================================
   PomodoroFlow - Full-Featured JavaScript Application Logic
   ========================================================================== */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // 1. App State & LocalStorage Configuration
  // --------------------------------------------------------------------------
  // Single source of truth for the version string. Every place that shows it
  // carries data-app-version and is stamped at boot, so the tool-list badge
  // can no longer drift out of sync with the app header.
  const APP_VERSION = 'v0.9.1-beta';

  const STORAGE_KEYS = {
    SETTINGS: 'pomoflow_settings',
    TASKS: 'pomoflow_tasks',
    ACTIVE_TASK_ID: 'pomoflow_active_task_id',
    STATS: 'pomoflow_stats'
  };

  // Default Settings
  const defaultSettings = {
    workTime: 25,
    shortBreakTime: 5,
    longBreakTime: 15,
    dailyGoal: 8,
    autoStartBreaks: false,
    autoStartWork: false,
    alertSound: 'zen',
    theme: 'dark-glass'
  };

  // Initial State. Everything from localStorage goes through the same
  // sanitisers as an imported backup — stored data is equally untrusted.
  let settings = sanitizeSettings(loadFromStorage(STORAGE_KEYS.SETTINGS, defaultSettings));
  let tasks = sanitizeTasks(loadFromStorage(STORAGE_KEYS.TASKS, [
    {
      id: 'task-1',
      title: '了解並使用 PomodoroFlow 番茄鐘',
      category: 'work',
      priority: 'high',
      estimated: 2,
      completed: 1,
      isDone: false,
      createdAt: Date.now()
    }
  ]));
  let activeTaskId = loadFromStorage(STORAGE_KEYS.ACTIVE_TASK_ID, 'task-1');
  let stats = sanitizeStats(loadFromStorage(STORAGE_KEYS.STATS, {
    history: {}, // 'YYYY-MM-DD': { count: 0, minutes: 0 }
    streak: 0,
    lastActiveDate: null
  }));

  // Timer State
  let timerMode = 'work'; // 'work' | 'shortBreak' | 'longBreak'
  let timerState = 'idle'; // 'idle' | 'running' | 'paused'
  let timerInterval = null;
  let secondsLeft = settings.workTime * 60;
  let totalSeconds = settings.workTime * 60;
  let completedCycles = 0;
  // Wall-clock deadline. Interval ticks only sample this — they never count
  // down themselves, so throttled/backgrounded tabs cannot lose time.
  let timerEndsAt = null;

  // Active Task Filter
  let currentFilter = 'all';

  // --------------------------------------------------------------------------
  // 2. Web Audio API Synthesizer (Zero Audio File Dependencies)
  // --------------------------------------------------------------------------
  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.ambientGainNode = null;
      this.ambientSourceNodes = [];
      this.currentAmbient = 'none';
      this.ambientVolume = 0.4;
      // Each fade-out owns its own stop timeout, so a later stop can never orphan
      // an earlier call's oscillators by cancelling their scheduled stop.
      this.pendingBinauralStops = new Set();
      // Bandpassing the mask onto the carrier throws away most of its energy,
      // so mode B needs make-up gain to actually reach the tone. Tuned by
      // measuring tone-vs-mask inside the auditory critical band.
      // 2.0 measured: tone-vs-mask goes 19dB (mode A) -> 13dB. An earlier 4.2
      // hit ~6dB, which genuinely masked the sine — the beat percept vanished
      // and it read as plain noise. Softening must stay well short of masking.
      this.BLEND_MASK_BOOST = 2.0;
      this.binauralMaskModeGain = 0.75; // full-level gain for the active mode
      this.binauralMaskBaseGain = 0.75; // that gain after the user's level scale
      this.binauralMaskEnabled = true;
      this.maskLevelScale = 0.5;        // user-facing mask volume, 0..1
    }

    initCtx() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      this.enableIOSBackgroundAudioKeeper();
    }

    // iOS is the only platform that needs the MediaStream detour to keep audio
    // alive on the lock screen. Everywhere else it is pure cost.
    isIOS() {
      if (typeof this._isIOS === 'boolean') return this._isIOS;
      const ua = navigator.userAgent || '';
      const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
      this._isIOS = /iPad|iPhone|iPod/.test(ua) || iPadOS;
      return this._isIOS;
    }

    connectOutput(node) {
      if (!this.ctx || !node) return;

      // Routing everything through MediaStream -> <audio> puts the graph on the
      // AudioContext clock and playback on the output-device clock. The two
      // drift, the pipeline resamples to compensate, and pure sine tones expose
      // that as a slow periodic pitch warble. Only pay that price on iOS.
      if (!this.isIOS()) {
        try { node.connect(this.ctx.destination); } catch (e) {}
        return;
      }

      const silentAudio = document.getElementById('silentAudioLoop');

      // Create MediaStreamDestination to pipe Web Audio into HTML5 <audio> tag for iOS Safari Background Audio
      if (!this.mediaStreamDest && (this.ctx.createMediaStreamDestination || this.ctx.webkitCreateMediaStreamDestination)) {
        try {
          const createDest = this.ctx.createMediaStreamDestination || this.ctx.webkitCreateMediaStreamDestination;
          this.mediaStreamDest = createDest.call(this.ctx);
          if (silentAudio && this.mediaStreamDest.stream) {
            silentAudio.srcObject = this.mediaStreamDest.stream;
            silentAudio.play().catch(() => {});
          }
        } catch (e) {
          console.log('MediaStream destination fallback:', e);
        }
      }

      if (this.mediaStreamDest && silentAudio) {
        try {
          node.connect(this.mediaStreamDest);
        } catch (e) {
          try { node.connect(this.ctx.destination); } catch (err) {}
        }
      } else {
        try { node.connect(this.ctx.destination); } catch (e) {}
      }
    }

    // --- iOS Safari Lock Screen Background Audio Keeper ---
    enableIOSBackgroundAudioKeeper() {
      if (!this.isIOS()) return;
      const silentAudio = document.getElementById('silentAudioLoop');
      if (silentAudio) {
        const playPromise = silentAudio.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            if ('mediaSession' in navigator) {
              try {
                navigator.mediaSession.playbackState = 'playing';
                navigator.mediaSession.metadata = new MediaMetadata({
                  title: 'PomodoroFlow 🍅 雙耳拍頻與專注',
                  artist: 'Binaural Beats Studio',
                  album: 'iOS 鎖屏背景持續發聲中'
                });

                navigator.mediaSession.setActionHandler('play', () => {
                  if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
                  if (silentAudio) silentAudio.play().catch(() => {});
                  navigator.mediaSession.playbackState = 'playing';
                });
                navigator.mediaSession.setActionHandler('pause', () => {
                  if (silentAudio) silentAudio.pause();
                  navigator.mediaSession.playbackState = 'paused';
                });
              } catch (e) {}
            }
          }).catch(err => {
            console.log('Silent audio playback error:', err);
          });
        }
      }
    }

    disableIOSBackgroundAudioKeeper() {
      const silentAudio = document.getElementById('silentAudioLoop');
      if (silentAudio && this.currentAmbient === 'none' && !this.binauralMasterGain) {
        silentAudio.pause();
        if ('mediaSession' in navigator) {
          try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {}
        }
      }
    }

    // --- Alert Sound Synthesizers ---
    playAlertSound(soundType = settings.alertSound) {
      this.initCtx();
      const now = this.ctx.currentTime;

      if (soundType === 'zen') {
        // Zen Gong / Bell
        const osc1 = this.ctx.createOscillator();
        const osc2 = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(150, now);
        osc1.frequency.exponentialRampToValueAtTime(140, now + 3);

        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(300, now);

        gain.gain.setValueAtTime(0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 3.5);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(this.ctx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 3.5);
        osc2.stop(now + 3.5);
      } else if (soundType === 'marimba') {
        // Soft Wood Marimba
        [440, 554.37, 659.25].forEach((freq, index) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          const t = now + index * 0.15;

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, t);

          gain.gain.setValueAtTime(0.5, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);

          osc.connect(gain);
          gain.connect(this.ctx.destination);

          osc.start(t);
          osc.stop(t + 0.6);
        });
      } else if (soundType === 'digital') {
        // Digital Beep
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'square';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.setValueAtTime(1200, now + 0.1);

        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now);
        osc.stop(now + 0.3);
      } else if (soundType === 'chime') {
        // Gentle Chime Chord
        [523.25, 659.25, 783.99, 1046.5].forEach((freq) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now);

          gain.gain.setValueAtTime(0.25, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 2.5);

          osc.connect(gain);
          gain.connect(this.ctx.destination);

          osc.start(now);
          osc.stop(now + 2.5);
        });
      }
    }

    // --- Procedural Ambient Noise Generators ---
    setAmbientSound(type) {
      this.stopAmbientSound();
      if (type === 'none') {
        this.currentAmbient = 'none';
        return;
      }

      this.initCtx();
      this.currentAmbient = type;

      this.ambientGainNode = this.ctx.createGain();
      this.ambientGainNode.gain.setValueAtTime(this.ambientVolume, this.ctx.currentTime);
      this.connectOutput(this.ambientGainNode);

      const bufferSize = this.ctx.sampleRate * 3;
      const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);

      if (type === 'rain') {
        // Rain Sound (White noise + Lowpass filter + Random drops)
        for (let i = 0; i < bufferSize; i++) {
          output[i] = Math.random() * 2 - 1;
        }
        const whiteNoise = this.ctx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;
        whiteNoise.loop = true;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1000, this.ctx.currentTime);

        whiteNoise.connect(filter);
        filter.connect(this.ambientGainNode);
        whiteNoise.start();
        this.ambientSourceNodes.push(whiteNoise);
      } else if (type === 'focus') {
        // Pink Focus Noise (1/f Noise)
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          output[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
          output[i] *= 0.11;
          b6 = white * 0.115926;
        }
        const pinkNoise = this.ctx.createBufferSource();
        pinkNoise.buffer = noiseBuffer;
        pinkNoise.loop = true;

        pinkNoise.connect(this.ambientGainNode);
        pinkNoise.start();
        this.ambientSourceNodes.push(pinkNoise);
      } else if (type === 'waves') {
        // Ocean Waves (Brown noise + LFO filter sweep)
        let lastOut = 0.0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          output[i] = (lastOut + (0.02 * white)) / 1.02;
          lastOut = output[i];
          output[i] *= 3.5;
        }
        const brownNoise = this.ctx.createBufferSource();
        brownNoise.buffer = noiseBuffer;
        brownNoise.loop = true;

        const lfo = this.ctx.createOscillator();
        lfo.frequency.setValueAtTime(0.12, this.ctx.currentTime); // Wave period ~8s
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(400, this.ctx.currentTime);

        lfo.connect(filter.frequency);
        brownNoise.connect(filter);
        filter.connect(this.ambientGainNode);

        lfo.start();
        brownNoise.start();
        this.ambientSourceNodes.push(brownNoise, lfo);
      } else if (type === 'forestRain') {
        // Deep Brown Noise + Forest Rain Trickle (YouTube p5BwXeU0Z1c Acoustic Reproduction)
        let lastOut = 0.0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          output[i] = (lastOut + (0.02 * white)) / 1.02;
          lastOut = output[i];
          output[i] *= 3.2;
        }
        const brownNoise = this.ctx.createBufferSource();
        brownNoise.buffer = noiseBuffer;
        brownNoise.loop = true;

        const brownFilter = this.ctx.createBiquadFilter();
        brownFilter.type = 'lowpass';
        brownFilter.frequency.setValueAtTime(320, this.ctx.currentTime);

        brownNoise.connect(brownFilter);
        brownFilter.connect(this.ambientGainNode);

        // Raindrop Trickle Pink Layer
        const rainBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const rainData = rainBuffer.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          rainData[i] = (b0 + b1 + b2 + white * 0.5362) * 0.08;
        }
        const rainSource = this.ctx.createBufferSource();
        rainSource.buffer = rainBuffer;
        rainSource.loop = true;

        const rainFilter = this.ctx.createBiquadFilter();
        rainFilter.type = 'highpass';
        rainFilter.frequency.setValueAtTime(900, this.ctx.currentTime);

        rainSource.connect(rainFilter);
        rainFilter.connect(this.ambientGainNode);

        brownNoise.start();
        rainSource.start();
        this.ambientSourceNodes.push(brownNoise, rainSource);
      }
    }

    stopAmbientSound() {
      this.ambientSourceNodes.forEach((node) => {
        try { node.stop(); } catch (e) {}
      });
      this.ambientSourceNodes = [];
      this.currentAmbient = 'none';
      this.disableIOSBackgroundAudioKeeper();
    }

    setVolume(volumePct) {
      this.ambientVolume = volumePct / 100;
      if (this.ambientGainNode && this.ctx) {
        this.ambientGainNode.gain.setValueAtTime(this.ambientVolume, this.ctx.currentTime);
      }
    }

    // --- Dedicated Binaural Beats Engine (Strict Physical & Acoustic Algorithm) ---
    startBinauralBeats(baseFreq = 200, beatFreq = 10, volumePct = 25, enableMasking = true, maskingType = 'pink', maskMode = 'ambient') {
      this.stopBinauralBeats(0); // Synchronous immediate stop of previous nodes
      this.initCtx();

      // Enforce strict physical & brainstem phase-locking optimal carrier window: 100 Hz - 400 Hz
      const safeBaseFreq = Math.max(100, Math.min(400, baseFreq || 200));

      const now = this.ctx.currentTime;
      const targetVol = (volumePct / 100) * 0.5; // Prevent clipping (0 dBFS limit)

      // Acoustic Golden Ratio for Long Listening without Ear Fatigue:
      // Pure Sine Beat Tone = 25% (20%~30%), Masking Background Noise = 75% (70%~80%)
      const beatToneRatio = enableMasking ? 0.25 : 0.8;
      const maskNoiseRatio = 0.75;

      // Master Gain for Binaural Beats with Fade-In Envelope (1.2s)
      this.binauralMasterGain = this.ctx.createGain();
      this.binauralMasterGain.gain.setValueAtTime(0.0001, now);
      this.binauralMasterGain.gain.linearRampToValueAtTime(targetVol, now + 1.2);
      this.connectOutput(this.binauralMasterGain);

      // Sub-gain Node for Pure Sine Beat Tone (25% Golden Ratio)
      const beatToneGainNode = this.ctx.createGain();
      beatToneGainNode.gain.setValueAtTime(beatToneRatio, now);
      beatToneGainNode.connect(this.binauralMasterGain);
      this.binauralBeatGainNode = beatToneGainNode;

      // Calculate Left & Right pure sine frequencies:
      const fLeft = safeBaseFreq - (beatFreq / 2.0);
      const fRight = safeBaseFreq + (beatFreq / 2.0);

      // Channel Separation: Use StereoPanner if available, or ChannelMergerNode
      const leftPanner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      const rightPanner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;

      this.binauralLeftOsc = this.ctx.createOscillator();
      this.binauralRightOsc = this.ctx.createOscillator();

      this.binauralLeftOsc.type = 'sine';
      this.binauralLeftOsc.frequency.setValueAtTime(fLeft, now);

      this.binauralRightOsc.type = 'sine';
      this.binauralRightOsc.frequency.setValueAtTime(fRight, now);

      // Store explicit tracked frequencies to eliminate Web Audio default 440Hz getter plunge artifact!
      this.currentFLeft = fLeft;
      this.currentFRight = fRight;

      if (leftPanner && rightPanner) {
        leftPanner.pan.setValueAtTime(-1, now);
        rightPanner.pan.setValueAtTime(1, now);

        this.binauralLeftOsc.connect(leftPanner);
        this.binauralRightOsc.connect(rightPanner);

        leftPanner.connect(beatToneGainNode);
        rightPanner.connect(beatToneGainNode);
      } else {
        const merger = this.ctx.createChannelMerger(2);
        this.binauralLeftOsc.connect(merger, 0, 0);
        this.binauralRightOsc.connect(merger, 0, 1);
        merger.connect(beatToneGainNode);
      }

      // Comfort Masking Layer. Always built, then gated by its own gain node so
      // the comfort-masking checkbox can fade it live instead of restarting.
      {
        const noiseType = maskingType === 'brown' ? 'brown' : 'pink';
        this.binauralMaskingNoise = this.ctx.createBufferSource();
        // Mode B decorrelates per ear so the bed cannot smear the interaural cue.
        this.binauralMaskingNoise.buffer = this.createNoiseBuffer(noiseType, 8, maskMode === 'blend' ? 2 : 1);
        this.binauralMaskingNoise.loop = true;

        const maskGainNode = this.ctx.createGain();
        this.binauralMaskGainNode = maskGainNode;

        // Always drop the sub-bass. Measurement showed 20-80Hz was the loudest
        // band in the mask while contributing nothing to masking a 120-400Hz
        // carrier — it just ate headroom and rattled headphone drivers.
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(60, now);

        const shaper = this.ctx.createBiquadFilter();
        let modeGain;

        if (maskMode === 'blend') {
          // Mode B — park the noise energy on the carrier so it actually blends
          // with the sine instead of rumbling harmlessly two octaves below it.
          shaper.type = 'bandpass';
          shaper.frequency.setValueAtTime(safeBaseFreq, now);
          // Wide (Q 0.7) so the bed stays noise-like rather than pitched.
          shaper.Q.setValueAtTime(0.7, now);
          modeGain = maskNoiseRatio * this.BLEND_MASK_BOOST;
        } else {
          // Mode A — original warm low-passed bed; the beat tone stays dominant.
          shaper.type = 'lowpass';
          shaper.frequency.setValueAtTime(maskingType === 'brown' ? 450 : 800, now);
          modeGain = maskNoiseRatio;
        }

        this.binauralMaskModeGain = modeGain;
        this.binauralMaskEnabled = enableMasking;
        const applied = Math.max(0.0001, modeGain * this.maskLevelScale);
        this.binauralMaskBaseGain = applied;
        maskGainNode.gain.setValueAtTime(enableMasking ? applied : 0.0001, now);

        this.binauralMaskingNoise.connect(hp);
        hp.connect(shaper);
        shaper.connect(maskGainNode);
        maskGainNode.connect(this.binauralMasterGain);
        this.binauralMaskingNoise.start(now);
      }

      this.binauralLeftOsc.start(now);
      this.binauralRightOsc.start(now);
    }

    updateBinauralFrequencies(baseFreq = 200, beatFreq = 10, rampDuration = 0.8) {
      if (this.ctx && this.binauralLeftOsc && this.binauralRightOsc) {
        const now = this.ctx.currentTime;
        const safeBaseFreq = Math.max(100, Math.min(400, baseFreq || 200));
        const fLeft = safeBaseFreq - (beatFreq / 2.0);
        const fRight = safeBaseFreq + (beatFreq / 2.0);

        // Use tracked frequency or fallback to target frequency if just started
        const startLeft = (typeof this.currentFLeft === 'number') ? this.currentFLeft : fLeft;
        const startRight = (typeof this.currentFRight === 'number') ? this.currentFRight : fRight;

        try {
          // Cancel previous scheduled frequency ramps to prevent pitch jumps & click artifacts
          this.binauralLeftOsc.frequency.cancelScheduledValues(now);
          this.binauralRightOsc.frequency.cancelScheduledValues(now);

          // Lock explicit starting frequency before initiating smooth linear ramp
          this.binauralLeftOsc.frequency.setValueAtTime(startLeft, now);
          this.binauralRightOsc.frequency.setValueAtTime(startRight, now);

          this.binauralLeftOsc.frequency.linearRampToValueAtTime(fLeft, now + rampDuration);
          this.binauralRightOsc.frequency.linearRampToValueAtTime(fRight, now + rampDuration);
        } catch (e) {
          this.binauralLeftOsc.frequency.setValueAtTime(fLeft, now);
          this.binauralRightOsc.frequency.setValueAtTime(fRight, now);
        }

        this.currentFLeft = fLeft;
        this.currentFRight = fRight;
      }
    }

    fadeBinauralMasterGain(fadeSeconds = 180) {
      if (this.ctx && this.binauralMasterGain) {
        const now = this.ctx.currentTime;
        try {
          this.binauralMasterGain.gain.cancelScheduledValues(now);
          this.binauralMasterGain.gain.setValueAtTime(Math.max(0.0001, this.binauralMasterGain.gain.value), now);
          this.binauralMasterGain.gain.exponentialRampToValueAtTime(0.0001, now + fadeSeconds);
        } catch (e) {
          try {
            this.binauralMasterGain.gain.linearRampToValueAtTime(0.0001, now + fadeSeconds);
          } catch (err) {}
        }
      }
    }

    // Seamless looping noise. The old 2s buffer looped with a raw splice, so the
    // random walk's end value stepped back to its start — a low thump every 2s
    // (measured up to 19x a normal sample step). Longer buffer + crossfaded tail
    // + normalisation also fixes the ~1.4dB level lottery between sessions.
    // channels=2 generates an independent noise stream per ear. Correlated
    // (mono) noise images dead-centre — exactly where the binaural percept
    // sits — so a decorrelated bed surrounds the beat instead of competing.
    createNoiseBuffer(type = 'pink', seconds = 8, channels = 1) {
      const sr = this.ctx.sampleRate;
      const xfade = Math.floor(sr * 0.25);
      const total = Math.floor(sr * seconds) + xfade;
      const len = total - xfade;
      const buffer = this.ctx.createBuffer(channels, len, sr);

      for (let ch = 0; ch < channels; ch++) {
        const raw = new Float32Array(total);

        if (type === 'brown') {
          let last = 0;
          for (let i = 0; i < total; i++) {
            const white = Math.random() * 2 - 1;
            raw[i] = (last + 0.02 * white) / 1.02;
            last = raw[i];
          }
        } else {
          let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
          for (let i = 0; i < total; i++) {
            const white = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168980;
            raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.1;
            b6 = white * 0.115926;
          }
        }

        const out = new Float32Array(len);
        out.set(raw.subarray(0, len));
        // Equal-power crossfade the overrun back over the head: seam-free loop
        for (let i = 0; i < xfade; i++) {
          const t = i / xfade;
          out[i] = out[i] * Math.sin(t * Math.PI / 2) + raw[len + i] * Math.cos(t * Math.PI / 2);
        }

        // Remove DC, then normalise so every session starts at the same level
        let mean = 0;
        for (let i = 0; i < len; i++) mean += out[i];
        mean /= len;
        let peak = 0;
        for (let i = 0; i < len; i++) {
          out[i] -= mean;
          const v = Math.abs(out[i]);
          if (v > peak) peak = v;
        }
        const norm = peak > 0 ? 0.7 / peak : 1;
        for (let i = 0; i < len; i++) out[i] *= norm;

        buffer.getChannelData(ch).set(out);
      }
      return buffer;
    }

    // Fade the comfort masking layer in/out without restarting the oscillators,
    // rebalancing the beat tone against the 25:75 acoustic golden ratio.
    // Mask volume is a personal preference, so it rides a live gain ramp rather
    // than a hardcoded constant — no rebuild, adjustable while listening.
    setBinauralMaskLevel(pct, rampSeconds = 0.2) {
      this.maskLevelScale = Math.max(0, Math.min(1, (pct || 0) / 100));
      const target = Math.max(0.0001, this.binauralMaskModeGain * this.maskLevelScale);
      this.binauralMaskBaseGain = target;

      if (!this.ctx || !this.binauralMaskGainNode || !this.binauralMaskEnabled) return false;

      const node = this.binauralMaskGainNode;
      const now = this.ctx.currentTime;
      try {
        node.gain.cancelScheduledValues(now);
        node.gain.setValueAtTime(Math.max(0.0001, node.gain.value), now);
        node.gain.linearRampToValueAtTime(target, now + rampSeconds);
      } catch (e) {
        try { node.gain.setValueAtTime(target, now); } catch (err) {}
      }
      return true;
    }

    setBinauralMasking(enabled, rampSeconds = 0.35) {
      if (!this.ctx || !this.binauralBeatGainNode || !this.binauralMaskGainNode) return false;
      this.binauralMaskEnabled = enabled;

      const now = this.ctx.currentTime;
      const targets = [
        [this.binauralBeatGainNode, enabled ? 0.25 : 0.8],
        // Restore whatever level this mask mode was built at, not a fixed 0.75.
        [this.binauralMaskGainNode, enabled ? this.binauralMaskBaseGain : 0.0001]
      ];

      targets.forEach(([node, target]) => {
        const safeTarget = Math.max(0.0001, target);
        try {
          node.gain.cancelScheduledValues(now);
          node.gain.setValueAtTime(Math.max(0.0001, node.gain.value), now);
          node.gain.linearRampToValueAtTime(safeTarget, now + rampSeconds);
        } catch (e) {
          try { node.gain.setValueAtTime(safeTarget, now); } catch (err) {}
        }
      });

      return true;
    }

    setBinauralVolume(volumePct) {
      if (this.binauralMasterGain && this.ctx) {
        const targetVol = (volumePct / 100) * 0.4;
        this.binauralMasterGain.gain.setValueAtTime(targetVol, this.ctx.currentTime);
      }
    }

    stopBinauralBeats(fadeSeconds = 0.5) {
      const leftOsc = this.binauralLeftOsc;
      const rightOsc = this.binauralRightOsc;
      const maskingNoise = this.binauralMaskingNoise;
      const masterGain = this.binauralMasterGain;

      this.binauralMasterGain = null;
      this.binauralLeftOsc = null;
      this.binauralRightOsc = null;
      this.binauralMaskingNoise = null;
      this.binauralBeatGainNode = null;
      this.binauralMaskGainNode = null;
      this.currentFLeft = null;
      this.currentFRight = null;

      if (!masterGain || !this.ctx) return;

      // Tear down exactly the nodes captured above, never whatever is current.
      const hardStop = () => {
        if (leftOsc) try { leftOsc.stop(); } catch(e){}
        if (rightOsc) try { rightOsc.stop(); } catch(e){}
        if (maskingNoise) try { maskingNoise.stop(); } catch(e){}
        try { masterGain.disconnect(); } catch(e){}
      };

      if (fadeSeconds <= 0) {
        hardStop();
        return;
      }

      const now = this.ctx.currentTime;
      try {
        // Anchor at the live value first, otherwise a still-pending fade-in ramp
        // outlives this ramp and pulls the gain back up to full volume.
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setValueAtTime(Math.max(0.0001, masterGain.gain.value), now);
        masterGain.gain.linearRampToValueAtTime(0.0001, now + fadeSeconds);
      } catch (e) {}

      const timeoutId = setTimeout(() => {
        hardStop();
        this.pendingBinauralStops.delete(timeoutId);
      }, fadeSeconds * 1000 + 50);
      this.pendingBinauralStops.add(timeoutId);
    }
  }

  const audioEngine = new AudioEngine();

  // --------------------------------------------------------------------------
  // 3. UI Elements Selection
  // --------------------------------------------------------------------------
  const DOM = {
    body: document.body,
    // Main Tool List & Navigation UI
    toolListView: document.getElementById('toolListView'),
    pomodoroAppView: document.getElementById('pomodoroAppView'),
    openPomodoroToolCard: document.getElementById('openPomodoroToolCard'),
    backToToolListBtn: document.getElementById('backToToolListBtn'),
    miniFloatingWidget: document.getElementById('miniFloatingWidget'),
    miniWidgetOpenBtn: document.getElementById('miniWidgetOpenBtn'),
    miniWidgetIcon: document.getElementById('miniWidgetIcon'),
    miniWidgetStatusText: document.getElementById('miniWidgetStatusText'),
    miniWidgetSubText: document.getElementById('miniWidgetSubText'),
    miniWidgetPlayPauseBtn: document.getElementById('miniWidgetPlayPauseBtn'),
    miniWidgetAudioBtn: document.getElementById('miniWidgetAudioBtn'),
    miniRingProgress: document.getElementById('miniRingProgress'),
    deepSleepStudioBlock: document.getElementById('deepSleepStudioBlock'),
    dsStatusBadge: document.getElementById('dsStatusBadge'),
    dsDurationChips: document.querySelectorAll('.ds-duration-chip'),
    dsMaskChips: document.querySelectorAll('.ds-mask-chip'),
    dsVolumeSlider: document.getElementById('dsVolumeSlider'),
    dsVolumeVal: document.getElementById('dsVolumeVal'),
    dsMaskLevelSlider: document.getElementById('dsMaskLevelSlider'),
    dsMaskLevelVal: document.getElementById('dsMaskLevelVal'),
    dsStartPauseBtn: document.getElementById('dsStartPauseBtn'),
    dsResetBtn: document.getElementById('dsResetBtn'),
    dsRunInfoPanel: document.getElementById('dsRunInfoPanel'),
    dsElapsedTimeText: document.getElementById('dsElapsedTimeText'),
    dsRemainingTimeText: document.getElementById('dsRemainingTimeText'),
    dsLiveHzText: document.getElementById('dsLiveHzText'),
    dsPhaseProgressLine: document.getElementById('dsPhaseProgressLine'),
    timeText: document.getElementById('timeText'),
    activeTaskLabel: document.getElementById('activeTaskLabel'),
    cycleIndicator: document.getElementById('cycleIndicator'),
    timerProgressRing: document.getElementById('timerProgressRing'),
    startPauseBtn: document.getElementById('startPauseBtn'),
    startPauseText: document.getElementById('startPauseText'),
    playPauseIcon: document.getElementById('playPauseIcon'),
    resetTimerBtn: document.getElementById('resetTimerBtn'),
    skipTimerBtn: document.getElementById('skipTimerBtn'),
    modeTabs: document.querySelectorAll('.mode-tab'),
    
    // Version Modal UI
    versionBadgeBtn: document.getElementById('versionBadgeBtn'),
    versionModal: document.getElementById('versionModal'),
    closeVersionModalBtn: document.getElementById('closeVersionModalBtn'),
    closeVersionModalFooterBtn: document.getElementById('closeVersionModalFooterBtn'),

    // Workspace Tabs UI (任務清單 / 音效工作室)
    workspaceTabs: document.querySelectorAll('.workspace-tab'),
    workspacePanels: document.querySelectorAll('[data-workspace-panel]'),
    workspaceAudioDot: document.getElementById('workspaceAudioDot'),

    // Audio Studio Sub-Tabs UI
    audioSubtabBtns: document.querySelectorAll('.audio-subtab-btn'),
    audioSubpanels: document.querySelectorAll('[data-audiotab-panel]'),
    binauralAdvancedToggle: document.getElementById('binauralAdvancedToggle'),
    binauralAdvancedPanel: document.getElementById('binauralAdvancedPanel'),

    // Ambient UI
    ambientBtns: document.querySelectorAll('.ambient-btn'),
    ambientVolume: document.getElementById('ambientVolume'),
    currentAmbientLabel: document.getElementById('currentAmbientLabel'),
    ytUrlInput: document.getElementById('ytUrlInput'),
    loadYtBtn: document.getElementById('loadYtBtn'),
    stopYtBtn: document.getElementById('stopYtBtn'),
    toggleYtPlayerBtn: document.getElementById('toggleYtPlayerBtn'),
    ytPlayerContainer: document.getElementById('ytPlayerContainer'),
    ytIframeWrapper: document.getElementById('ytIframeWrapper'),
    ytStatusBadge: document.getElementById('ytStatusBadge'),

    // Binaural Beats Studio UI
    binauralToggle: document.getElementById('binauralToggle'),
    binauralCards: document.querySelectorAll('.binaural-card'),
    carrierFreqSelect: document.getElementById('carrierFreqSelect'),
    binauralMathText: document.getElementById('binauralMathText'),
    binauralPerceivedText: document.getElementById('binauralPerceivedText'),
    binauralRatioText: document.getElementById('binauralRatioText'),
    comfortMaskingToggle: document.getElementById('comfortMaskingToggle'),
    maskModeSelect: document.getElementById('maskModeSelect'),
    maskLevelSlider: document.getElementById('maskLevelSlider'),
    maskLevelVal: document.getElementById('maskLevelVal'),
    binauralVolSlider: document.getElementById('binauralVolSlider'),
    binauralVolVal: document.getElementById('binauralVolVal'),

    // Sound Sleep Timer UI
    sleepTimerMin: document.getElementById('sleepTimerMin'),
    sleepTimerSec: document.getElementById('sleepTimerSec'),
    sleepPresetChips: document.querySelectorAll('.preset-chip'),
    startSleepTimerBtn: document.getElementById('startSleepTimerBtn'),
    cancelSleepTimerBtn: document.getElementById('cancelSleepTimerBtn'),
    sleepTimerStatusBadge: document.getElementById('sleepTimerStatusBadge'),
    sleepTimerCountdownText: document.getElementById('sleepTimerCountdownText'),

    // Tasks UI
    taskList: document.getElementById('taskList'),
    addTaskBtn: document.getElementById('addTaskBtn'),
    filterChips: document.querySelectorAll('.filter-chip'),
    dailyGoalText: document.getElementById('dailyGoalText'),
    dailyGoalProgressBar: document.getElementById('dailyGoalProgressBar'),
    streakCount: document.getElementById('streakCount'),

    // Modals
    taskModal: document.getElementById('taskModal'),
    taskForm: document.getElementById('taskForm'),
    taskModalTitle: document.getElementById('taskModalTitle'),
    taskIdInput: document.getElementById('taskIdInput'),
    taskTitleInput: document.getElementById('taskTitleInput'),
    taskEstInput: document.getElementById('taskEstInput'),
    taskCategorySelect: document.getElementById('taskCategorySelect'),
    taskPrioritySelect: document.getElementById('taskPrioritySelect'),
    closeTaskModalBtn: document.getElementById('closeTaskModalBtn'),
    cancelTaskModalBtn: document.getElementById('cancelTaskModalBtn'),

    analyticsModal: document.getElementById('analyticsModal'),
    analyticsBtn: document.getElementById('analyticsBtn'),
    closeAnalyticsModalBtn: document.getElementById('closeAnalyticsModalBtn'),
    statTodayTime: document.getElementById('statTodayTime'),
    statTodayCount: document.getElementById('statTodayCount'),
    statTotalCount: document.getElementById('statTotalCount'),

    settingsModal: document.getElementById('settingsModal'),
    settingsBtn: document.getElementById('settingsBtn'),
    closeSettingsModalBtn: document.getElementById('closeSettingsModalBtn'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    settingWorkTime: document.getElementById('settingWorkTime'),
    settingShortBreak: document.getElementById('settingShortBreak'),
    settingLongBreak: document.getElementById('settingLongBreak'),
    settingDailyGoal: document.getElementById('settingDailyGoal'),
    settingAutoStartBreaks: document.getElementById('settingAutoStartBreaks'),
    settingAutoStartWork: document.getElementById('settingAutoStartWork'),
    settingSoundSelect: document.getElementById('settingSoundSelect'),
    testSoundBtn: document.getElementById('testSoundBtn'),
    requestNotificationBtn: document.getElementById('requestNotificationBtn'),
    exportDataBtn: document.getElementById('exportDataBtn'),
    importDataInput: document.getElementById('importDataInput'),
    themeSelect: document.getElementById('themeSelect'),

    // Zen Mode
    zenBtn: document.getElementById('zenBtn'),
    zenOverlay: document.getElementById('zenOverlay'),
    exitZenBtn: document.getElementById('exitZenBtn'),
    zenTaskTitle: document.getElementById('zenTaskTitle'),
    zenTimeText: document.getElementById('zenTimeText'),
    zenStartPauseBtn: document.getElementById('zenStartPauseBtn')
  };

  // --------------------------------------------------------------------------
  // 4. Navigation & Mini Widget Logic
  // --------------------------------------------------------------------------
  let activeView = 'toolList'; // 'toolList' | 'pomodoroApp'

  function switchView(viewName) {
    activeView = viewName;
    if (viewName === 'toolList') {
      if (DOM.toolListView) DOM.toolListView.classList.remove('hidden');
      if (DOM.pomodoroAppView) DOM.pomodoroAppView.classList.add('hidden');
      checkAndUpdateMiniWidget();
    } else {
      if (DOM.toolListView) DOM.toolListView.classList.add('hidden');
      if (DOM.pomodoroAppView) DOM.pomodoroAppView.classList.remove('hidden');
      if (DOM.miniFloatingWidget) DOM.miniFloatingWidget.classList.add('hidden');
    }
  }

  // Dedicated Binaural Beats & Deep Sleep Studio State (Strict Acoustic & Brainstem Phase-Locking Rules)
  const wavePresets = {
    alpha: { deltaF: 10, baseFreq: 200, name: 'Alpha (α)', label: '平靜專注、心流學習（200Hz 黃金專注載波）' },
    beta: { deltaF: 20, baseFreq: 400, name: 'Beta (β)', label: '高效思考、邏輯分析（400Hz 明亮提神載波）' },
    gamma: { deltaF: 40, baseFreq: 400, name: 'Gamma (γ)', label: '極限超頻、記憶整合（400Hz 警覺載波）' },
    theta: { deltaF: 6, baseFreq: 150, name: 'Theta (θ)', label: '靈感發想、深度冥想（150Hz 放鬆中低音載波）' },
    delta: { deltaF: 2, baseFreq: 120, name: 'Delta (δ)', label: '身體修復、深層放鬆（120Hz 低沉安撫載波）' },
    deepSleep: { deltaF: 8, baseFreq: 120, name: 'NREM 慢波深眠', label: '動態降頻演算法 (8Hz ➔ 5Hz ➔ 2Hz) + 120Hz 低沉安撫載波' }
  };

  let binauralState = {
    enabled: false,
    waveMode: 'alpha',
    baseFreq: 200, // Carrier Frequency (200 Hz optimal)
    volume: 25,
    comfortMasking: true,
    maskMode: 'ambient', // 'ambient' (A) | 'blend' (B)
    maskLevel: 50        // background mask volume, independent of beat volume
  };

  let deepSleepState = {
    running: false,
    paused: false,
    durationMins: 30,
    // Sleep wants its own levels — borrowing the focus-studio volume from
    // another tab was both too loud and unreachable from here.
    volume: 25,
    maskLevel: 50,
    elapsedSec: 0,
    startedAt: null,
    fadeStarted: false,
    intervalId: null,
    maskingType: 'brown' // 'brown' | 'forestRain' | 'youtube'
  };

  function checkAndUpdateMiniWidget() {
    const isTimerActive = timerState === 'running' || timerState === 'paused';
    const isBinauralActive = (binauralState && binauralState.enabled) || (deepSleepState && deepSleepState.running);
    const isAmbientActive = audioEngine && audioEngine.currentAmbient !== 'none';

    // Surface a pulse on the workspace tab so audio stays discoverable while
    // the task list is showing. Runs in every view, unlike the mini widget.
    if (DOM.workspaceAudioDot) {
      DOM.workspaceAudioDot.classList.toggle('hidden', !(isBinauralActive || isAmbientActive));
    }

    if (activeView !== 'toolList') return;

    if (isTimerActive || isBinauralActive || isAmbientActive) {
      if (DOM.miniFloatingWidget) DOM.miniFloatingWidget.classList.remove('hidden');
      updateMiniWidgetUI();
    } else {
      if (DOM.miniFloatingWidget) DOM.miniFloatingWidget.classList.add('hidden');
    }
  }

  // Which session does the dock's play/pause act on? Whatever is actually
  // running — the old widget always called toggleTimer(), so pressing it while
  // NREM sleep was playing silently started the pomodoro instead.
  function getMiniPrimaryTarget() {
    if (deepSleepState && (deepSleepState.running || deepSleepState.paused)) return 'deepSleep';
    if (timerState === 'running' || timerState === 'paused') return 'timer';
    return null;
  }

  function isAnyAudioPlaying() {
    return (binauralState && binauralState.enabled)
      || (deepSleepState && deepSleepState.running)
      || (audioEngine && audioEngine.currentAmbient !== 'none');
  }

  // One dock, three slots: ring = progress of the primary session,
  // status = what it is + time left, sub = what you are hearing.
  function updateMiniWidgetUI() {
    const target = getMiniPrimaryTarget();
    const dsRunning = deepSleepState && (deepSleepState.running || deepSleepState.paused);

    // --- Ring progress ---
    let progressPct = 0;
    if (target === 'deepSleep') {
      const totalSec = deepSleepState.durationMins * 60;
      progressPct = totalSec > 0 ? Math.min(100, Math.max(0, Math.round((deepSleepState.elapsedSec / totalSec) * 100))) : 0;
    } else if (target === 'timer') {
      progressPct = totalSeconds > 0 ? Math.min(100, Math.max(0, Math.round(((totalSeconds - secondsLeft) / totalSeconds) * 100))) : 0;
    }
    if (DOM.miniRingProgress) {
      DOM.miniRingProgress.setAttribute('stroke-dasharray', `${progressPct}, 100`);
    }

    // --- Primary line: the session that owns the dock ---
    let icon = '🔊';
    let status = '音效播放中';
    if (target === 'deepSleep') {
      icon = '🌙';
      const remText = DOM.dsRemainingTimeText ? DOM.dsRemainingTimeText.textContent : '';
      status = deepSleepState.paused ? `🌙 助眠已暫停 ${remText}` : `🌙 助眠剩餘 ${remText}`;
    } else if (target === 'timer') {
      const modeLabel = timerMode === 'work' ? '🎯 專注' : (timerMode === 'shortBreak' ? '☕ 短休' : '🌴 長休');
      icon = timerMode === 'work' ? '🍅' : '☕';
      status = `${modeLabel} ${formatTime(secondsLeft)}${timerState === 'paused' ? '（已暫停）' : ''}`;
    } else if (binauralState && binauralState.enabled) {
      icon = '🧠';
      status = `🧠 ${wavePresets[binauralState.waveMode]?.name || 'Alpha'} 拍頻發聲中`;
    } else if (audioEngine && audioEngine.currentAmbient !== 'none') {
      icon = '🔊';
      status = `🔊 ${DOM.currentAmbientLabel ? DOM.currentAmbientLabel.textContent : '環境音'}`;
    }
    if (DOM.miniWidgetIcon) DOM.miniWidgetIcon.textContent = icon;
    if (DOM.miniWidgetStatusText) DOM.miniWidgetStatusText.textContent = status;

    // --- Secondary line: always the audio summary, never a repeat of above ---
    let sub = '🔇 音效未開啟';
    if (dsRunning) {
      const liveHz = DOM.dsLiveHzText ? DOM.dsLiveHzText.textContent : '8.0 Hz';
      sub = `🌙 降頻至 ${liveHz}`;
    } else if (binauralState && binauralState.enabled) {
      sub = `🧠 ${wavePresets[binauralState.waveMode]?.name || 'Alpha'}（音量 ${binauralState.volume}%）`;
    } else if (audioEngine && audioEngine.currentAmbient !== 'none') {
      sub = `🔊 ${DOM.currentAmbientLabel ? DOM.currentAmbientLabel.textContent : '環境音'}`;
    }
    // When the dock is led by audio the primary line already says it — use the
    // sub line for the timer instead so the two lines never duplicate.
    if (!target && sub === status) sub = '背景持續執行中';
    if (DOM.miniWidgetSubText) DOM.miniWidgetSubText.textContent = sub;

    // --- Controls: only show what can actually be acted on ---
    if (DOM.miniWidgetPlayPauseBtn) {
      const btn = DOM.miniWidgetPlayPauseBtn;
      btn.classList.toggle('hidden', !target);
      if (target) {
        const paused = target === 'deepSleep' ? deepSleepState.paused : timerState === 'paused';
        const noun = target === 'deepSleep' ? '助眠引導' : '計時';
        btn.textContent = paused ? '▶️' : '⏸️';
        btn.title = `${paused ? '繼續' : '暫停'}${noun}`;
        btn.setAttribute('aria-label', btn.title);
      }
    }

    if (DOM.miniWidgetAudioBtn) {
      DOM.miniWidgetAudioBtn.classList.toggle('hidden', !isAnyAudioPlaying());
    }
  }

  // --------------------------------------------------------------------------
  // 5. Timer Logic & Functions
  // --------------------------------------------------------------------------
  function initTimer() {
    document.querySelectorAll('[data-app-version]').forEach(el => {
      el.textContent = APP_VERSION;
    });
    reconcileStreak();
    syncTimerButtons();
    updateTimerDisplay();
    updateThemeUI();
    renderTasks();
    renderDailyGoal();
    updateStreakUI();
  }

  function getDurationForMode(mode) {
    if (mode === 'work') return settings.workTime * 60;
    if (mode === 'shortBreak') return settings.shortBreakTime * 60;
    if (mode === 'longBreak') return settings.longBreakTime * 60;
    return 25 * 60;
  }

  function switchMode(newMode) {
    timerMode = newMode;
    pauseTimer();
    timerState = 'idle';
    totalSeconds = getDurationForMode(newMode);
    secondsLeft = totalSeconds;
    syncTimerButtons();

    DOM.modeTabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.mode === newMode);
    });

    // Ring colors based on mode
    if (newMode === 'work') {
      DOM.timerProgressRing.style.stroke = 'var(--work-color)';
    } else if (newMode === 'shortBreak') {
      DOM.timerProgressRing.style.stroke = 'var(--break-color)';
    } else {
      DOM.timerProgressRing.style.stroke = 'var(--long-break-color)';
    }

    updateTimerDisplay();
  }

  function toggleTimer() {
    if (timerState === 'running') {
      pauseTimer();
    } else {
      startTimer();
    }
  }

  // Keep every start/pause affordance (main bar, zen overlay, mini widget) in
  // agreement with the actual timer state.
  function syncTimerButtons() {
    const running = timerState === 'running';
    const label = running ? '暫停' : (timerState === 'paused' ? '繼續專注' : '開始專注');

    if (DOM.startPauseText) DOM.startPauseText.textContent = label;
    if (DOM.zenStartPauseBtn) DOM.zenStartPauseBtn.textContent = label;
    if (DOM.playPauseIcon) {
      DOM.playPauseIcon.innerHTML = running
        ? `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`
        : `<polygon points="5 3 19 12 5 21 5 3"></polygon>`;
    }
  }

  function startTimer() {
    if (timerState === 'running') return;
    if (secondsLeft <= 0) return;

    audioEngine.initCtx();
    timerState = 'running';
    timerEndsAt = Date.now() + secondsLeft * 1000;

    syncTimerButtons();

    clearInterval(timerInterval);
    // Sample 4x/second so the visible second flips promptly after a resync.
    timerInterval = setInterval(syncTimerFromClock, 250);
  }

  // Single source of truth: remaining time is always derived from the deadline.
  function syncTimerFromClock() {
    if (timerState !== 'running' || timerEndsAt === null) return;

    const remaining = Math.max(0, Math.ceil((timerEndsAt - Date.now()) / 1000));
    if (remaining !== secondsLeft) {
      secondsLeft = remaining;
      updateTimerDisplay();
    }
    if (remaining <= 0) onTimerComplete();
  }

  function pauseTimer() {
    if (timerState === 'running') {
      secondsLeft = Math.max(0, Math.ceil((timerEndsAt - Date.now()) / 1000));
      timerState = 'paused';
    }

    clearInterval(timerInterval);
    timerInterval = null;
    timerEndsAt = null;

    syncTimerButtons();
  }

  function resetTimer() {
    pauseTimer();
    // A reset timer is idle, not paused — otherwise the background mini widget
    // keeps advertising a session that isn't actually under way.
    timerState = 'idle';
    secondsLeft = totalSeconds;
    syncTimerButtons();
    updateTimerDisplay();
  }

  function skipTimer() {
    pauseTimer();
    onTimerComplete(true);
  }

  function onTimerComplete(isSkipped = false) {
    pauseTimer();

    if (!isSkipped) {
      audioEngine.playAlertSound();
      showDesktopNotification();

      if (timerMode === 'work') {
        completedCycles++;
        recordCompletedPomodoro();
      }
    }

    // Auto Mode Switch Logic.
    // completedCycles > 0 guard: skipping the very first pomodoro leaves the
    // counter at 0, and 0 % 4 === 0 used to jump straight to a long break.
    if (timerMode === 'work') {
      if (completedCycles > 0 && completedCycles % 4 === 0) {
        switchMode('longBreak');
      } else {
        switchMode('shortBreak');
      }
      if (settings.autoStartBreaks && !isSkipped) startTimer();
    } else {
      switchMode('work');
      if (settings.autoStartWork && !isSkipped) startTimer();
    }

    updateCycleIndicator();
  }

  function updateTimerDisplay() {
    const formatted = formatTime(secondsLeft);

    DOM.timeText.textContent = formatted;
    DOM.zenTimeText.textContent = formatted;

    // Document Title Update
    const modeLabel = timerMode === 'work' ? '🎯 專注' : (timerMode === 'shortBreak' ? '☕ 短休' : '🌴 長休');
    document.title = `(${formatted}) ${modeLabel} - PomodoroFlow`;
    checkAndUpdateMiniWidget();

    // SVG Ring Stroke Dashoffset calculation
    const circumference = 2 * Math.PI * 135; // 848.23
    const progressFraction = 1 - (secondsLeft / totalSeconds);
    const strokeDashoffset = circumference * progressFraction;
    DOM.timerProgressRing.style.strokeDashoffset = strokeDashoffset;
  }

  function updateCycleIndicator() {
    const currentCycle = (completedCycles % 4) + 1;
    DOM.cycleIndicator.textContent = `第 ${currentCycle} / 4 個番茄循環`;
  }

  // --------------------------------------------------------------------------
  // 5. Tasks Management Logic
  // --------------------------------------------------------------------------
  function renderTasks() {
    DOM.taskList.innerHTML = '';
    const activeTask = tasks.find(t => t.id === activeTaskId);

    if (activeTask) {
      DOM.activeTaskLabel.textContent = `當前目標：${activeTask.title}`;
      DOM.zenTaskTitle.textContent = activeTask.title;
    } else {
      DOM.activeTaskLabel.textContent = '選擇或新增任務以開始專注';
      DOM.zenTaskTitle.textContent = '專注中';
    }

    const filteredTasks = tasks.filter(t => {
      if (currentFilter === 'all') return true;
      return t.category === currentFilter;
    });

    if (filteredTasks.length === 0) {
      DOM.taskList.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 32px 0;">
          目前沒有任何專注任務，點擊上方「+ 新增任務」開始規劃！
        </div>
      `;
      return;
    }

    filteredTasks.forEach(task => {
      const itemEl = document.createElement('div');
      itemEl.className = `task-item ${task.id === activeTaskId ? 'active-task' : ''} ${task.isDone ? 'completed' : ''}`;
      
      const categoryNames = {
        work: '💻 工作',
        study: '📚 學習',
        design: '🎨 設計',
        health: '🏃 健康'
      };

      // Every interpolated value is escaped. id/priority reach attribute and
      // class contexts, so an unescaped quote there is an XSS hole.
      const safeId = escapeHTML(task.id);
      const priorityClass = ['high', 'medium', 'low'].includes(task.priority) ? task.priority : 'medium';

      itemEl.innerHTML = `
        <div class="task-left">
          <input type="checkbox" class="task-checkbox" ${task.isDone ? 'checked' : ''} data-id="${safeId}">
          <div class="task-info">
            <div class="task-title">${escapeHTML(task.title)}</div>
            <div class="task-meta">
              <span class="category-tag">${categoryNames[task.category] || '標籤'}</span>
              <span class="priority-dot priority-${priorityClass}"></span>
            </div>
          </div>
        </div>
        <div class="task-right">
          <div class="pomo-count">🍅 ${escapeHTML(task.completed)} / ${escapeHTML(task.estimated)}</div>
          <div class="task-actions">
            <button class="action-btn edit-task-btn" data-id="${safeId}" title="編輯">✏️</button>
            <button class="action-btn delete-task-btn" data-id="${safeId}" title="刪除">🗑️</button>
          </div>
        </div>
      `;

      // Select Task on click
      itemEl.addEventListener('click', (e) => {
        if (e.target.classList.contains('task-checkbox') || e.target.closest('.action-btn')) return;
        activeTaskId = task.id;
        saveToStorage(STORAGE_KEYS.ACTIVE_TASK_ID, activeTaskId);
        renderTasks();
      });

      DOM.taskList.appendChild(itemEl);
    });

    // Checkbox & Action Listeners
    DOM.taskList.querySelectorAll('.task-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const id = e.target.dataset.id;
        const task = tasks.find(t => t.id === id);
        if (task) {
          task.isDone = e.target.checked;
          saveTasks();
          renderTasks();
        }
      });
    });

    DOM.taskList.querySelectorAll('.edit-task-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditTaskModal(btn.dataset.id);
      });
    });

    DOM.taskList.querySelectorAll('.delete-task-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTask(btn.dataset.id);
      });
    });
  }

  function openAddTaskModal() {
    DOM.taskModalTitle.textContent = '新增專注任務';
    DOM.taskIdInput.value = '';
    DOM.taskTitleInput.value = '';
    DOM.taskEstInput.value = 2;
    DOM.taskCategorySelect.value = 'work';
    DOM.taskPrioritySelect.value = 'medium';
    DOM.taskModal.classList.remove('hidden');
    DOM.taskTitleInput.focus();
  }

  function openEditTaskModal(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    DOM.taskModalTitle.textContent = '編輯專注任務';
    DOM.taskIdInput.value = task.id;
    DOM.taskTitleInput.value = task.title;
    DOM.taskEstInput.value = task.estimated;
    DOM.taskCategorySelect.value = task.category;
    DOM.taskPrioritySelect.value = task.priority;
    DOM.taskModal.classList.remove('hidden');
  }

  function saveTaskFromForm(e) {
    e.preventDefault();
    const id = DOM.taskIdInput.value;
    const title = DOM.taskTitleInput.value.trim();
    const estimated = parseInt(DOM.taskEstInput.value, 10) || 1;
    const category = DOM.taskCategorySelect.value;
    const priority = DOM.taskPrioritySelect.value;

    if (!title) return;

    if (id) {
      // Edit existing task
      const task = tasks.find(t => t.id === id);
      if (task) {
        task.title = title;
        task.estimated = estimated;
        task.category = category;
        task.priority = priority;
      }
    } else {
      // Create new task
      const newTask = {
        id: 'task-' + Date.now(),
        title,
        category,
        priority,
        estimated,
        completed: 0,
        isDone: false,
        createdAt: Date.now()
      };
      tasks.push(newTask);
      activeTaskId = newTask.id;
      saveToStorage(STORAGE_KEYS.ACTIVE_TASK_ID, activeTaskId);
    }

    saveTasks();
    closeModal(DOM.taskModal);
    renderTasks();
  }

  function deleteTask(id) {
    if (confirm('確定要刪除這個任務嗎？')) {
      tasks = tasks.filter(t => t.id !== id);
      if (activeTaskId === id) {
        activeTaskId = tasks.length > 0 ? tasks[0].id : null;
        saveToStorage(STORAGE_KEYS.ACTIVE_TASK_ID, activeTaskId);
      }
      saveTasks();
      renderTasks();
    }
  }

  function saveTasks() {
    saveToStorage(STORAGE_KEYS.TASKS, tasks);
  }

  function recordCompletedPomodoro() {
    const todayStr = getTodayDateString();

    if (!stats.history[todayStr]) {
      stats.history[todayStr] = { count: 0, minutes: 0 };
    }
    stats.history[todayStr].count += 1;
    stats.history[todayStr].minutes += settings.workTime;

    // Check Streak
    updateStreakData(todayStr);

    saveToStorage(STORAGE_KEYS.STATS, stats);

    // Update active task count
    if (activeTaskId) {
      const activeTask = tasks.find(t => t.id === activeTaskId);
      if (activeTask) {
        activeTask.completed += 1;
        saveTasks();
        renderTasks();
      }
    }

    renderDailyGoal();
    updateStreakUI();
  }

  function updateStreakData(todayStr) {
    if (!stats.lastActiveDate) {
      stats.streak = 1;
    } else if (stats.lastActiveDate !== todayStr) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = formatDateString(yesterday);

      if (stats.lastActiveDate === yesterdayStr) {
        stats.streak += 1;
      } else {
        stats.streak = 1;
      }
    }
    stats.lastActiveDate = todayStr;
  }

  // A streak is only alive if the last activity was today or yesterday.
  // Without this the badge kept showing a number earned months ago.
  function reconcileStreak() {
    if (!stats.lastActiveDate) {
      stats.streak = 0;
      return;
    }
    const today = getTodayDateString();
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = formatDateString(y);

    if (stats.lastActiveDate !== today && stats.lastActiveDate !== yesterday) {
      stats.streak = 0;
      saveToStorage(STORAGE_KEYS.STATS, stats);
    }
  }

  function updateStreakUI() {
    DOM.streakCount.textContent = stats.streak || 0;
  }

  function renderDailyGoal() {
    const todayStr = getTodayDateString();
    const count = stats.history[todayStr] ? stats.history[todayStr].count : 0;
    const goal = settings.dailyGoal || 8;
    const pct = Math.min(Math.round((count / goal) * 100), 100);

    DOM.dailyGoalText.textContent = `${count} / ${goal} 🍅 (${pct}%)`;
    DOM.dailyGoalProgressBar.style.width = `${pct}%`;
  }

  // --------------------------------------------------------------------------
  // 6. Analytics & Charts Engine (Canvas Drawing)
  // --------------------------------------------------------------------------
  function openAnalyticsModal() {
    const todayStr = getTodayDateString();
    const todayData = stats.history[todayStr] || { count: 0, minutes: 0 };

    if (DOM.statTodayTime) DOM.statTodayTime.innerHTML = `${todayData.minutes} <span>分鐘</span>`;
    if (DOM.statTodayCount) DOM.statTodayCount.innerHTML = `${todayData.count} <span>個</span>`;

    let totalCount = 0;
    Object.values(stats.history).forEach(d => {
      totalCount += (d.count || 0);
    });
    if (DOM.statTotalCount) DOM.statTotalCount.innerHTML = `${totalCount} <span>個</span>`;

    if (DOM.analyticsModal) DOM.analyticsModal.classList.remove('hidden');

    // Render Canvas Charts
    setTimeout(() => {
      renderTrendChart();
      renderCategoryChart();
    }, 100);
  }

  // Size the backing store to the container × devicePixelRatio, then work in
  // CSS pixels. A fixed 500px canvas was clipped inside phone-width modals.
  function prepareCanvas(canvas, cssHeight = 200) {
    const dpr = window.devicePixelRatio || 1;
    const host = canvas.parentElement;
    const avail = host ? host.clientWidth - 32 : 300;
    const cssWidth = Math.max(240, Math.floor(avail));

    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  function renderTrendChart() {
    const canvas = document.getElementById('trendChartCanvas');
    if (!canvas) return;
    const { ctx, width, height } = prepareCanvas(canvas);

    ctx.clearRect(0, 0, width, height);

    // Get last 7 days data
    const labels = [];
    const minutesData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = formatDateString(d);
      const dayName = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      labels.push(dayName);
      minutesData.push(stats.history[dateStr] ? stats.history[dateStr].minutes : 0);
    }

    const maxMin = Math.max(...minutesData, 60);
    const padding = 30;
    const chartHeight = height - padding * 2;
    // Bars scale with the canvas so seven of them always fit on a phone.
    const slot = (width - padding * 2) / 7;
    const barWidth = Math.max(12, Math.min(36, slot - 8));

    // Draw Bars
    minutesData.forEach((mins, idx) => {
      const x = padding + idx * slot + (slot - barWidth) / 2;
      const barH = (mins / maxMin) * chartHeight;
      const y = height - padding - barH;

      // Gradient Bar
      const grad = ctx.createLinearGradient(0, y, 0, height - padding);
      grad.addColorStop(0, '#6366f1');
      grad.addColorStop(1, '#f43f5e');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barH, [6, 6, 0, 0]);
      ctx.fill();

      // Value label on top
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px Inter';
      ctx.textAlign = 'center';
      if (mins > 0) {
        ctx.fillText(`${mins}m`, x + barWidth / 2, y - 6);
      }

      // X Axis Label
      ctx.fillText(labels[idx], x + barWidth / 2, height - 8);
    });
  }

  function renderCategoryChart() {
    const canvas = document.getElementById('categoryChartCanvas');
    if (!canvas) return;
    const { ctx, width, height } = prepareCanvas(canvas);

    ctx.clearRect(0, 0, width, height);

    // Aggregate completed pomodoros by category
    const catCounts = { work: 0, study: 0, design: 0, health: 0 };
    tasks.forEach(t => {
      if (catCounts[t.category] !== undefined) {
        catCounts[t.category] += t.completed;
      }
    });

    const total = Object.values(catCounts).reduce((a, b) => a + b, 0);
    const colors = {
      work: '#f43f5e',
      study: '#6366f1',
      design: '#06b6d4',
      health: '#10b981'
    };
    const catLabels = {
      work: '💻 工作',
      study: '📚 學習',
      design: '🎨 設計',
      health: '🏃 健康'
    };

    if (total === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px Inter';
      ctx.textAlign = 'center';
      ctx.fillText('尚無專注類別資料', width / 2, height / 2);
      return;
    }

    // Proportional geometry — the donut and legend were pinned to pixel
    // positions that fell outside the canvas at phone widths.
    const donutBox = Math.min(width * 0.42, 160);
    const centerX = donutBox / 2 + 10;
    const centerY = height / 2;
    const radius = Math.max(36, Math.min(donutBox / 2 - 6, height / 2 - 14));
    let startAngle = 0;

    Object.keys(catCounts).forEach(cat => {
      const count = catCounts[cat];
      if (count === 0) return;
      const sliceAngle = (count / total) * 2 * Math.PI;

      ctx.fillStyle = colors[cat];
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.arc(centerX, centerY, radius, startAngle, startAngle + sliceAngle);
      ctx.closePath();
      ctx.fill();

      startAngle += sliceAngle;
    });

    // Donut hole
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 0.57, 0, 2 * Math.PI);
    ctx.fill();

    // Draw Legend to the right of the donut, vertically centred
    const entries = Object.keys(catCounts);
    const rowH = Math.min(32, height / (entries.length + 1));
    const legendX = centerX + radius + 16;
    const fontSize = width < 320 ? 11 : 13;
    let legendY = centerY - (entries.length * rowH) / 2;

    entries.forEach(cat => {
      const count = catCounts[cat];
      const pct = Math.round((count / total) * 100);

      ctx.fillStyle = colors[cat];
      ctx.fillRect(legendX, legendY, 12, 12);

      ctx.fillStyle = '#f8fafc';
      ctx.font = `${fontSize}px Inter`;
      ctx.textAlign = 'left';
      ctx.fillText(`${catLabels[cat]}: ${count} (${pct}%)`, legendX + 18, legendY + 11);

      legendY += rowH;
    });
  }

  // --------------------------------------------------------------------------
  // 7. Settings & Backup Logic
  // --------------------------------------------------------------------------
  function openSettingsModal() {
    if (DOM.settingWorkTime) DOM.settingWorkTime.value = settings.workTime;
    if (DOM.settingShortBreak) DOM.settingShortBreak.value = settings.shortBreakTime;
    if (DOM.settingLongBreak) DOM.settingLongBreak.value = settings.longBreakTime;
    if (DOM.settingDailyGoal) DOM.settingDailyGoal.value = settings.dailyGoal;
    if (DOM.settingAutoStartBreaks) DOM.settingAutoStartBreaks.checked = settings.autoStartBreaks;
    if (DOM.settingAutoStartWork) DOM.settingAutoStartWork.checked = settings.autoStartWork;
    if (DOM.settingSoundSelect) DOM.settingSoundSelect.value = settings.alertSound;

    if (DOM.settingsModal) DOM.settingsModal.classList.remove('hidden');
  }

  function saveSettings() {
    if (DOM.settingWorkTime) settings.workTime = parseInt(DOM.settingWorkTime.value, 10) || 25;
    if (DOM.settingShortBreak) settings.shortBreakTime = parseInt(DOM.settingShortBreak.value, 10) || 5;
    if (DOM.settingLongBreak) settings.longBreakTime = parseInt(DOM.settingLongBreak.value, 10) || 15;
    if (DOM.settingDailyGoal) settings.dailyGoal = parseInt(DOM.settingDailyGoal.value, 10) || 8;
    if (DOM.settingAutoStartBreaks) settings.autoStartBreaks = DOM.settingAutoStartBreaks.checked;
    if (DOM.settingAutoStartWork) settings.autoStartWork = DOM.settingAutoStartWork.checked;
    if (DOM.settingSoundSelect) settings.alertSound = DOM.settingSoundSelect.value;

    saveToStorage(STORAGE_KEYS.SETTINGS, settings);
    if (DOM.settingsModal) closeModal(DOM.settingsModal);

    // Only re-arm the clock when nothing is under way. Rewriting secondsLeft
    // mid-session used to silently discard the user's progress; new durations
    // now take effect from the next mode switch instead.
    if (timerState === 'idle') {
      totalSeconds = getDurationForMode(timerMode);
      secondsLeft = totalSeconds;
    }
    updateTimerDisplay();
    renderDailyGoal();
  }

  function updateThemeUI() {
    document.body.setAttribute('data-theme', settings.theme || 'dark-glass');
    if (DOM.themeSelect) DOM.themeSelect.value = settings.theme || 'dark-glass';
  }

  function exportBackupData() {
    const exportObject = {
      settings,
      tasks,
      stats,
      activeTaskId,
      exportedAt: new Date().toISOString()
    };
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportObject, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `pomodoro-flow-backup-${getTodayDateString()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  // --- Backup sanitisers (also used to repair corrupted localStorage) ---
  // Declared as functions and using inline literals so they are safe to call
  // from the top-of-IIFE state initialisation, before any const is evaluated.
  function clampInt(val, min, max, fallback) {
    const n = parseInt(val, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function sanitizeSettings(raw) {
    const s = (raw && typeof raw === 'object') ? raw : {};
    return {
      workTime: clampInt(s.workTime, 1, 120, defaultSettings.workTime),
      shortBreakTime: clampInt(s.shortBreakTime, 1, 60, defaultSettings.shortBreakTime),
      longBreakTime: clampInt(s.longBreakTime, 1, 60, defaultSettings.longBreakTime),
      dailyGoal: clampInt(s.dailyGoal, 1, 50, defaultSettings.dailyGoal),
      autoStartBreaks: s.autoStartBreaks === true,
      autoStartWork: s.autoStartWork === true,
      alertSound: ['zen', 'marimba', 'digital', 'chime'].includes(s.alertSound) ? s.alertSound : defaultSettings.alertSound,
      theme: ['dark-glass', 'emerald-forest', 'sunset-glow', 'cyberpunk-neon'].includes(s.theme) ? s.theme : defaultSettings.theme
    };
  }

  function sanitizeTasks(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(t => t && typeof t === 'object').map((t, i) => ({
      id: String(t.id == null ? `task-${Date.now()}-${i}` : t.id),
      title: String(t.title == null ? '未命名任務' : t.title).slice(0, 200),
      category: ['work', 'study', 'design', 'health'].includes(t.category) ? t.category : 'work',
      priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
      estimated: clampInt(t.estimated, 1, 20, 1),
      completed: clampInt(t.completed, 0, 9999, 0),
      isDone: t.isDone === true,
      createdAt: Number.isFinite(+t.createdAt) ? +t.createdAt : Date.now()
    }));
  }

  function sanitizeStats(raw) {
    const s = (raw && typeof raw === 'object') ? raw : {};
    const history = {};
    if (s.history && typeof s.history === 'object') {
      Object.keys(s.history).forEach(k => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
        const d = s.history[k] || {};
        history[k] = { count: clampInt(d.count, 0, 99999, 0), minutes: clampInt(d.minutes, 0, 999999, 0) };
      });
    }
    return {
      history,
      streak: clampInt(s.streak, 0, 99999, 0),
      lastActiveDate: /^\d{4}-\d{2}-\d{2}$/.test(s.lastActiveDate) ? s.lastActiveDate : null
    };
  }

  function importBackupData(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const imported = JSON.parse(e.target.result);
        if (imported.settings && imported.tasks && imported.stats) {
          // Never trust a backup file wholesale — coerce every field to the
          // shape the app expects instead of adopting the JSON as-is.
          settings = sanitizeSettings(imported.settings);
          tasks = sanitizeTasks(imported.tasks);
          stats = sanitizeStats(imported.stats);
          activeTaskId = tasks.some(t => t.id === imported.activeTaskId)
            ? imported.activeTaskId
            : (tasks.length > 0 ? tasks[0].id : null);

          saveToStorage(STORAGE_KEYS.SETTINGS, settings);
          saveToStorage(STORAGE_KEYS.TASKS, tasks);
          saveToStorage(STORAGE_KEYS.STATS, stats);
          saveToStorage(STORAGE_KEYS.ACTIVE_TASK_ID, activeTaskId);

          alert('🎉 資料成功匯入並更新！');
          location.reload();
        } else {
          alert('❌ 備份檔案格式無效，請確認為正確的 JSON 檔案！');
        }
      } catch (err) {
        alert('❌ 解析備份檔案失敗！');
      }
    };
    reader.readAsText(file);
  }

  function showDesktopNotification() {
    if ('Notification' in window && Notification.permission === 'granted') {
      const title = timerMode === 'work' ? '🎉 專注時間完成！' : '⚡ 休息時間結束！';
      const body = timerMode === 'work' ? '太棒了，完成了一個番茄鐘！準備好享受休息了嗎？' : '休息夠囉，點擊繼續開始下一波高效專注！';
      new Notification(title, { body, icon: '🍅' });
    }
  }

  // --------------------------------------------------------------------------
  // 8. Event Listeners Setup
  // --------------------------------------------------------------------------
  function setupEventListeners() {
    // Main Navigation & Mini Widget Events
    DOM.openPomodoroToolCard?.addEventListener('click', () => switchView('pomodoroApp'));
    DOM.backToToolListBtn?.addEventListener('click', () => switchView('toolList'));
    // The dock's navigation target is its own button, so the action buttons are
    // no longer overlapping click regions that need stopPropagation guards.
    DOM.miniWidgetOpenBtn?.addEventListener('click', () => switchView('pomodoroApp'));

    DOM.miniWidgetPlayPauseBtn?.addEventListener('click', () => {
      const target = getMiniPrimaryTarget();
      if (target === 'deepSleep') {
        // startDeepSleepStudioEngine() toggles pause/resume internally.
        DOM.dsStartPauseBtn?.click();
      } else if (target === 'timer') {
        toggleTimer();
      }
      checkAndUpdateMiniWidget();
    });

    DOM.miniWidgetAudioBtn?.addEventListener('click', () => {
      // One button, one promise: silence everything currently making sound.
      audioEngine.stopAmbientSound();
      DOM.ambientBtns?.forEach(b => b.classList.toggle('active', b.dataset.sound === 'none'));
      if (DOM.currentAmbientLabel) DOM.currentAmbientLabel.textContent = '已關閉';

      audioEngine.stopBinauralBeats(1.0);
      binauralState.enabled = false;
      if (DOM.binauralToggle) DOM.binauralToggle.checked = false;

      if (deepSleepState.running || deepSleepState.paused) DOM.dsResetBtn?.click();

      checkAndUpdateMiniWidget();
    });

    // Mode Switch Tabs
    DOM.modeTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        switchMode(tab.dataset.mode);
      });
    });

    // Controls
    DOM.startPauseBtn?.addEventListener('click', toggleTimer);
    DOM.zenStartPauseBtn?.addEventListener('click', toggleTimer);
    DOM.resetTimerBtn?.addEventListener('click', resetTimer);
    DOM.skipTimerBtn?.addEventListener('click', skipTimer);

    // Universal AudioContext unlocker on first user interaction
    document.addEventListener('click', () => {
      audioEngine.initCtx();
    }, { once: true });

    // Returning to a throttled tab: re-read the deadline immediately instead of
    // waiting for the next sample, so the display never shows a stale time.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncTimerFromClock();
    });

    // Workspace Tab Switching (任務清單 / 音效工作室)
    DOM.workspaceTabs?.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.workspace;
        DOM.workspaceTabs.forEach(b => b.classList.toggle('active', b === btn));
        DOM.workspacePanels.forEach(panel => {
          panel.classList.toggle('hidden', panel.dataset.workspacePanel !== target);
        });
      });
    });

    // Audio Studio Sub-Tab Switching
    DOM.audioSubtabBtns?.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.audiotab;
        DOM.audioSubtabBtns.forEach(b => b.classList.toggle('active', b === btn));
        DOM.audioSubpanels.forEach(panel => {
          panel.classList.toggle('hidden', panel.dataset.audiotabPanel !== target);
        });
      });
    });

    // Binaural Advanced Settings Disclosure
    DOM.binauralAdvancedToggle?.addEventListener('click', () => {
      const isOpen = DOM.binauralAdvancedPanel.classList.toggle('hidden') === false;
      DOM.binauralAdvancedToggle.setAttribute('aria-expanded', String(isOpen));
    });

    // Ambient Noise Buttons
    DOM.ambientBtns?.forEach(btn => {
      btn.addEventListener('click', () => {
        audioEngine.initCtx();
        const sound = btn.dataset.sound;
        DOM.ambientBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        audioEngine.setAmbientSound(sound);
        DOM.currentAmbientLabel.textContent = sound === 'none' ? '已關閉' : btn.textContent;
        checkAndUpdateMiniWidget();
      });
    });

    DOM.ambientVolume?.addEventListener('input', (e) => {
      audioEngine.setVolume(e.target.value);
    });

    // YouTube Custom Audio Track Embed Logic
    function extractYouTubeId(url) {
      if (!url) return 'p5BwXeU0Z1c';
      const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
      const match = url.match(regExp);
      return (match && match[2] && match[2].length === 11) ? match[2] : 'p5BwXeU0Z1c';
    }

    function stopYouTubeTrack() {
      if (DOM.ytIframeWrapper) {
        DOM.ytIframeWrapper.innerHTML = '';
      }
      if (DOM.ytPlayerContainer) {
        DOM.ytPlayerContainer.classList.add('hidden');
      }
      if (DOM.toggleYtPlayerBtn) {
        DOM.toggleYtPlayerBtn.classList.add('hidden');
      }
      if (DOM.stopYtBtn) {
        DOM.stopYtBtn.classList.add('hidden');
      }
      if (DOM.ytStatusBadge) {
        DOM.ytStatusBadge.textContent = '預設：DEEP BROWN NOISE & FOREST RAIN';
      }
    }

    DOM.loadYtBtn?.addEventListener('click', () => {
      const url = DOM.ytUrlInput?.value.trim() || 'https://youtu.be/p5BwXeU0Z1c';
      const videoId = extractYouTubeId(url);
      if (videoId) {
        if (DOM.ytIframeWrapper) {
          DOM.ytIframeWrapper.innerHTML = `
            <iframe src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&enablejsapi=1&rel=0&playsinline=1"
                    title="YouTube Audio Track"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    playsinline
                    allowfullscreen>
            </iframe>
          `;
        }
        if (DOM.ytPlayerContainer) DOM.ytPlayerContainer.classList.remove('hidden');
        if (DOM.toggleYtPlayerBtn) DOM.toggleYtPlayerBtn.classList.remove('hidden');
        if (DOM.stopYtBtn) DOM.stopYtBtn.classList.remove('hidden');
        if (DOM.ytStatusBadge) DOM.ytStatusBadge.textContent = `▶️ 音軌播放中 (ID: ${videoId})`;
      } else {
        alert('請輸入有效的 YouTube 網址！');
      }
    });

    DOM.stopYtBtn?.addEventListener('click', () => {
      stopYouTubeTrack();
    });

    DOM.toggleYtPlayerBtn?.addEventListener('click', () => {
      if (DOM.ytPlayerContainer) {
        DOM.ytPlayerContainer.classList.toggle('hidden');
      }
    });

    // The YouTube track IS the masking layer. Synthesizing noise on top of it
    // double-masks and is heard as stray white noise over the video audio.
    function deepSleepUsesSynthMask() {
      return deepSleepState.maskingType !== 'none' && deepSleepState.maskingType !== 'youtube';
    }

    // Dedicated Binaural Beats Studio Logic (Strict Physical & Acoustic Algorithm)
    function startDeepSleepStudioEngine() {
      audioEngine.initCtx();

      if (deepSleepState.running && !deepSleepState.paused) {
        // Currently running -> Pause it
        pauseDeepSleepStudioEngine();
        return;
      }

      if (deepSleepState.paused) {
        // Resume from pause
        deepSleepState.paused = false;
        if (DOM.dsStatusBadge) {
          DOM.dsStatusBadge.textContent = '助眠引導中';
          DOM.dsStatusBadge.className = 'ds-status-badge running';
        }
        if (DOM.dsStartPauseBtn) DOM.dsStartPauseBtn.textContent = '⏸️ 暫停助眠引導';
        checkAndUpdateMiniWidget();
        return;
      }

      // Fresh Start
      deepSleepState.running = true;
      deepSleepState.paused = false;
      deepSleepState.elapsedSec = 0;

      const totalSec = Math.round(deepSleepState.durationMins * 60);

      // 120Hz Low Carrier + Initial 8.0Hz Alpha + Selected Masking Noise (Brown Noise, Forest Rain, YouTube, or None)
      audioEngine.setBinauralMaskLevel(deepSleepState.maskLevel);
      audioEngine.startBinauralBeats(120, 8.0, deepSleepState.volume, deepSleepUsesSynthMask(), deepSleepState.maskingType || 'brown', binauralState.maskMode);
      if (deepSleepState.maskingType === 'youtube') {
        DOM.loadYtBtn?.click();
      }

      if (DOM.dsRunInfoPanel) DOM.dsRunInfoPanel.classList.remove('hidden');
      if (DOM.dsStatusBadge) {
        DOM.dsStatusBadge.textContent = '助眠引導中';
        DOM.dsStatusBadge.className = 'ds-status-badge running';
      }
      if (DOM.dsStartPauseBtn) DOM.dsStartPauseBtn.textContent = '⏸️ 暫停助眠引導';

      updateDeepSleepMetricsUI(totalSec);

      if (deepSleepState.intervalId) clearInterval(deepSleepState.intervalId);

      const fadeSec = Math.min(180, Math.max(2, Math.round(totalSec * 0.2)));

      // Wall-clock anchored, like the pomodoro timer. This session is meant to
      // run with the phone screen off, where tick counting drifts the worst.
      deepSleepState.startedAt = Date.now();
      deepSleepState.fadeStarted = false;

      deepSleepState.intervalId = setInterval(() => {
        if (deepSleepState.paused) {
          // Hold the deadline still while paused.
          deepSleepState.startedAt = Date.now() - deepSleepState.elapsedSec * 1000;
          return;
        }

        deepSleepState.elapsedSec = Math.floor((Date.now() - deepSleepState.startedAt) / 1000);
        const remaining = totalSec - deepSleepState.elapsedSec;

        updateDeepSleepMetricsUI(totalSec);

        // Fire once on crossing the threshold — an equality test misses it
        // entirely whenever a throttled tab skips over that exact second.
        if (!deepSleepState.fadeStarted && remaining <= fadeSec && remaining > 0) {
          deepSleepState.fadeStarted = true;
          audioEngine.fadeBinauralMasterGain(remaining);
        }

        if (remaining <= 0) {
          stopDeepSleepStudioEngine(true);
        }
      }, 1000);

      checkAndUpdateMiniWidget();
    }

    function pauseDeepSleepStudioEngine() {
      deepSleepState.paused = true;
      if (DOM.dsStatusBadge) {
        DOM.dsStatusBadge.textContent = '已暫停';
        DOM.dsStatusBadge.className = 'ds-status-badge';
      }
      if (DOM.dsStartPauseBtn) DOM.dsStartPauseBtn.textContent = '▶️ 繼續助眠引導';
      stopYouTubeTrack();
      checkAndUpdateMiniWidget();
    }

    function stopDeepSleepStudioEngine(isCompleted = false) {
      // Only tear down audio the sleep engine actually owns. updateBinauralEngineUI()
      // calls this on every preset change, and unconditionally stopping here used to
      // kill the user's YouTube track and double-stop the binaural graph.
      const wasActive = deepSleepState.running || deepSleepState.paused;

      if (deepSleepState.intervalId) {
        clearInterval(deepSleepState.intervalId);
        deepSleepState.intervalId = null;
      }
      deepSleepState.running = false;
      deepSleepState.paused = false;

      if (DOM.dsStatusBadge) {
        DOM.dsStatusBadge.textContent = isCompleted ? '🎉 引導完成' : '未開始';
        DOM.dsStatusBadge.className = 'ds-status-badge';
      }
      if (DOM.dsStartPauseBtn) DOM.dsStartPauseBtn.textContent = '▶️ 開始深層助眠引導';

      if (!isCompleted && DOM.dsRunInfoPanel) {
        DOM.dsRunInfoPanel.classList.add('hidden');
      }

      if (wasActive) {
        audioEngine.stopBinauralBeats(0.5);
        stopYouTubeTrack();
      }
      checkAndUpdateMiniWidget();
    }

    function updateDeepSleepMetricsUI(totalSec) {
      const elapsed = deepSleepState.elapsedSec;
      const remaining = Math.max(0, totalSec - elapsed);

      const elapsedMins = Math.floor(elapsed / 60);
      const elapsedSecs = elapsed % 60;
      const remMins = Math.floor(remaining / 60);
      const remSecs = remaining % 60;

      if (DOM.dsElapsedTimeText) {
        DOM.dsElapsedTimeText.textContent = `${String(elapsedMins).padStart(2, '0')}:${String(elapsedSecs).padStart(2, '0')}`;
      }
      if (DOM.dsRemainingTimeText) {
        DOM.dsRemainingTimeText.textContent = `${String(remMins).padStart(2, '0')}:${String(remSecs).padStart(2, '0')}`;
      }

      // Ultra-smooth Cosine Descent Curve: 8.0 Hz -> 2.0 Hz over 85% of total session time
      const activeDuration = Math.max(1, totalSec * 0.85);
      const progress = Math.min(1.0, elapsed / activeDuration);
      
      // Cosine Interpolation guarantees 100% continuous zero-derivative curve (no sharp slope jumps!)
      const currentHz = 2.0 + (8.0 - 2.0) * 0.5 * (1 + Math.cos(Math.PI * progress));
      
      let activeStepId = 'dsStepAlpha';
      const progressPct = Math.round((elapsed / totalSec) * 100);

      if (currentHz > 6.0) {
        activeStepId = 'dsStepAlpha'; // 8.0Hz - 6.0Hz
      } else if (currentHz > 3.0) {
        activeStepId = 'dsStepTheta'; // 6.0Hz - 3.0Hz
      } else if (progress < 1.0) {
        activeStepId = 'dsStepDelta'; // 3.0Hz - 2.0Hz
      } else {
        activeStepId = 'dsStepSustain'; // Sustain 2.0Hz Deep Sleep
      }

      // Smoothly Ramp Web Audio Frequencies (120Hz Base Carrier + Ultra-Smooth Cosine Beat Frequency)
      audioEngine.updateBinauralFrequencies(120, currentHz, 0.95);

      if (DOM.dsLiveHzText) DOM.dsLiveHzText.textContent = `${currentHz.toFixed(1)} Hz`;
      if (DOM.dsPhaseProgressLine) DOM.dsPhaseProgressLine.style.width = `${Math.min(100, progressPct)}%`;

      ['dsStepAlpha', 'dsStepTheta', 'dsStepDelta', 'dsStepSustain'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', id === activeStepId);
      });
    }

    // The old "25% : 75%" label described gain coefficients, not what you hear.
    // Measured in the critical band around the carrier, mode A leaves the tone
    // ~16dB above the mask; mode B closes that to a few dB.
    function updateBinauralRatioText() {
      if (!DOM.binauralRatioText) return;
      if (!binauralState.comfortMasking) {
        DOM.binauralRatioText.textContent = '純拍頻 100%（遮罩已關閉，長時間聆聽較易耳疲勞）';
        return;
      }
      DOM.binauralRatioText.textContent = binauralState.maskMode === 'blend'
        ? 'B 左右耳去相關包圍：柔化正弦波稜角、聲場更寬（音調仍高出遮罩約 13dB）'
        : 'A 氛圍墊底：拍頻最清晰、遮罩僅作背景（音調高出遮罩約 19dB）';
    }

    function updateBinauralEngineUI() {
      const preset = wavePresets[binauralState.waveMode] || wavePresets.alpha;
      const deltaF = preset.deltaF;

      // Enforce strict physical & brainstem phase-locking optimal carrier window: 100 Hz - 400 Hz
      binauralState.baseFreq = Math.max(100, Math.min(400, binauralState.baseFreq || preset.baseFreq || 200));
      const baseFreq = binauralState.baseFreq;

      // Synchronize Card active highlights
      DOM.binauralCards?.forEach(c => {
        if (c && c.dataset) {
          c.classList.toggle('active', c.dataset.wave === binauralState.waveMode);
        }
      });

      // Synchronize Carrier Selector UI
      if (DOM.carrierFreqSelect) {
        DOM.carrierFreqSelect.value = String(baseFreq);
      }

      // Stop Deep Sleep Studio Engine if user explicitly switches to standard presets
      stopDeepSleepStudioEngine(false);

      const fLeft = baseFreq - (deltaF / 2.0);
      const fRight = baseFreq + (deltaF / 2.0);
      const perceivedPitch = baseFreq;

      if (DOM.binauralVolVal) DOM.binauralVolVal.textContent = binauralState.volume;
      if (DOM.binauralMathText) DOM.binauralMathText.textContent = `載波 ${baseFreq}Hz | 左耳 ${fLeft.toFixed(1)}Hz / 右耳 ${fRight.toFixed(1)}Hz (頻差 Δf = ${deltaF}Hz)`;
      if (DOM.binauralPerceivedText) DOM.binauralPerceivedText.textContent = `感知音高 ${perceivedPitch}Hz（聽感呈現 ${deltaF}Hz 規律脈動 Tremolo 與頭腦中央相位鎖定感）`;
      updateBinauralRatioText();

      if (binauralState.enabled) {
        // Restore this studio's own mask level — deep sleep keeps a separate one.
        audioEngine.setBinauralMaskLevel(binauralState.maskLevel);
        audioEngine.startBinauralBeats(baseFreq, deltaF, binauralState.volume, binauralState.comfortMasking, 'pink', binauralState.maskMode);
      } else {
        audioEngine.stopBinauralBeats(0.5);
      }

      checkAndUpdateMiniWidget();
    }

    DOM.binauralToggle?.addEventListener('change', (e) => {
      audioEngine.initCtx();
      binauralState.enabled = e.target.checked;
      updateBinauralEngineUI();
    });

    DOM.binauralCards?.forEach(card => {
      card.addEventListener('click', () => {
        audioEngine.initCtx();
        DOM.binauralCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        binauralState.waveMode = card.dataset.wave;
        const preset = wavePresets[binauralState.waveMode];
        if (preset && preset.baseFreq) {
          binauralState.baseFreq = preset.baseFreq;
        }
        updateBinauralEngineUI();
      });
    });

    DOM.carrierFreqSelect?.addEventListener('change', (e) => {
      audioEngine.initCtx();
      let selectedHz = parseInt(e.target.value, 10);
      binauralState.baseFreq = Math.max(100, Math.min(400, selectedHz || 200));
      updateBinauralEngineUI();
    });

    // Deep Sleep Studio Block Events
    DOM.dsDurationChips?.forEach(chip => {
      chip.addEventListener('click', () => {
        DOM.dsDurationChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const selectedMins = parseFloat(chip.dataset.mins) || 30;
        deepSleepState.durationMins = selectedMins;

        // Interrupt & reset any currently running audio/timer
        stopDeepSleepStudioEngine(false);

        // Update remaining time preview text immediately
        const totalSec = Math.round(selectedMins * 60);
        const remMins = Math.floor(totalSec / 60);
        const remSecs = totalSec % 60;
        if (DOM.dsElapsedTimeText) DOM.dsElapsedTimeText.textContent = '00:00';
        if (DOM.dsRemainingTimeText) DOM.dsRemainingTimeText.textContent = `${String(remMins).padStart(2, '0')}:${String(remSecs).padStart(2, '0')}`;
        if (DOM.dsLiveHzText) DOM.dsLiveHzText.textContent = '8.0 Hz';
      });
    });

    DOM.dsMaskChips?.forEach(chip => {
      chip.addEventListener('click', () => {
        DOM.dsMaskChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        deepSleepState.maskingType = chip.dataset.mask || 'brown';
        if (deepSleepState.maskingType === 'youtube') {
          DOM.loadYtBtn?.click();
        } else {
          stopYouTubeTrack();
        }
        if (deepSleepState.running) {
          audioEngine.setBinauralMaskLevel(deepSleepState.maskLevel);
          audioEngine.startBinauralBeats(120, 8.0, deepSleepState.volume, deepSleepUsesSynthMask(), deepSleepState.maskingType, binauralState.maskMode);
        }
      });
    });

    // Deep sleep volume controls — live, no restart, only act while it's running
    DOM.dsVolumeSlider?.addEventListener('input', (e) => {
      deepSleepState.volume = parseInt(e.target.value, 10) || 0;
      if (DOM.dsVolumeVal) DOM.dsVolumeVal.textContent = deepSleepState.volume;
      if (deepSleepState.running) audioEngine.setBinauralVolume(deepSleepState.volume);
    });

    DOM.dsMaskLevelSlider?.addEventListener('input', (e) => {
      deepSleepState.maskLevel = parseInt(e.target.value, 10) || 0;
      if (DOM.dsMaskLevelVal) DOM.dsMaskLevelVal.textContent = deepSleepState.maskLevel;
      if (deepSleepState.running) audioEngine.setBinauralMaskLevel(deepSleepState.maskLevel);
    });

    if (DOM.dsVolumeSlider) DOM.dsVolumeSlider.value = deepSleepState.volume;
    if (DOM.dsVolumeVal) DOM.dsVolumeVal.textContent = deepSleepState.volume;
    if (DOM.dsMaskLevelSlider) DOM.dsMaskLevelSlider.value = deepSleepState.maskLevel;
    if (DOM.dsMaskLevelVal) DOM.dsMaskLevelVal.textContent = deepSleepState.maskLevel;

    DOM.dsStartPauseBtn?.addEventListener('click', () => {
      startDeepSleepStudioEngine();
    });

    DOM.dsResetBtn?.addEventListener('click', () => {
      stopDeepSleepStudioEngine(false);
      const totalSec = Math.round(deepSleepState.durationMins * 60);
      const remMins = Math.floor(totalSec / 60);
      const remSecs = totalSec % 60;
      if (DOM.dsElapsedTimeText) DOM.dsElapsedTimeText.textContent = '00:00';
      if (DOM.dsRemainingTimeText) DOM.dsRemainingTimeText.textContent = `${String(remMins).padStart(2, '0')}:${String(remSecs).padStart(2, '0')}`;
      if (DOM.dsLiveHzText) DOM.dsLiveHzText.textContent = '8.0 Hz';
    });

    DOM.comfortMaskingToggle?.addEventListener('change', (e) => {
      binauralState.comfortMasking = e.target.checked;
      // Deep sleep owns its own masking choice (including "YouTube = no synth
      // noise"), so this toggle must not reach into a running session.
      if (deepSleepState.running || !binauralState.enabled) return;

      // Adjust the live graph if one exists; only rebuild when it doesn't.
      if (!audioEngine.setBinauralMasking(binauralState.comfortMasking)) {
        updateBinauralEngineUI();
      }
      updateBinauralRatioText();
    });

    DOM.maskLevelSlider?.addEventListener('input', (e) => {
      binauralState.maskLevel = parseInt(e.target.value, 10) || 0;
      if (DOM.maskLevelVal) DOM.maskLevelVal.textContent = binauralState.maskLevel;
      audioEngine.setBinauralMaskLevel(binauralState.maskLevel);
    });

    DOM.maskModeSelect?.addEventListener('change', (e) => {
      binauralState.maskMode = e.target.value === 'blend' ? 'blend' : 'ambient';
      updateBinauralRatioText();
      // The filter topology differs per mode, so this one genuinely needs a
      // rebuild — unlike the masking on/off toggle, which is a live gain ramp.
      if (deepSleepState.running) {
        audioEngine.setBinauralMaskLevel(deepSleepState.maskLevel);
        audioEngine.startBinauralBeats(120, 8.0, deepSleepState.volume,
          deepSleepUsesSynthMask(), deepSleepState.maskingType, binauralState.maskMode);
      } else if (binauralState.enabled) {
        updateBinauralEngineUI();
      }
    });

    DOM.binauralVolSlider?.addEventListener('input', (e) => {
      binauralState.volume = parseInt(e.target.value, 10);
      if (DOM.binauralVolVal) DOM.binauralVolVal.textContent = binauralState.volume;
      if (binauralState.enabled) {
        audioEngine.setBinauralVolume(binauralState.volume);
      }
    });

    // Sync Initial Binaural Beats UI display (Alpha 10Hz Default)
    if (DOM.maskModeSelect) DOM.maskModeSelect.value = binauralState.maskMode;
    if (DOM.maskLevelSlider) DOM.maskLevelSlider.value = binauralState.maskLevel;
    if (DOM.maskLevelVal) DOM.maskLevelVal.textContent = binauralState.maskLevel;
    audioEngine.setBinauralMaskLevel(binauralState.maskLevel);
    updateBinauralEngineUI();

    // Dedicated Sound Sleep Auto-Off Timer Logic (Precision to Seconds)
    let sleepTimerInterval = null;
    let sleepTimerSecondsLeft = 0;

    function startSoundSleepTimer(totalSec) {
      if (totalSec <= 0) {
        alert('請輸入有效的倒數時間！');
        return;
      }

      stopSoundSleepTimer(false);

      sleepTimerSecondsLeft = totalSec;
      DOM.sleepTimerStatusBadge.textContent = '倒數計時中';
      DOM.sleepTimerStatusBadge.classList.add('active');
      DOM.startSleepTimerBtn.classList.add('hidden');
      DOM.cancelSleepTimerBtn.classList.remove('hidden');
      DOM.sleepTimerCountdownText.classList.remove('hidden');

      updateSleepCountdownDisplay();

      // Wall-clock anchored: this is the one timer users deliberately leave
      // running with the screen off, so tick counting is unusable here.
      const sleepEndsAt = Date.now() + totalSec * 1000;
      let fadeStarted = false;

      sleepTimerInterval = setInterval(() => {
        sleepTimerSecondsLeft = Math.max(0, Math.ceil((sleepEndsAt - Date.now()) / 1000));
        updateSleepCountdownDisplay();

        // Threshold crossing, not equality — a throttled tab skips exact values.
        if (!fadeStarted && sleepTimerSecondsLeft <= 180 && sleepTimerSecondsLeft > 0) {
          fadeStarted = true;
          audioEngine.fadeBinauralMasterGain(sleepTimerSecondsLeft);
        }

        if (sleepTimerSecondsLeft <= 0) {
          onSoundSleepTimerExpired();
        }
      }, 1000);
    }

    function updateSleepCountdownDisplay() {
      const mins = Math.floor(sleepTimerSecondsLeft / 60);
      const secs = sleepTimerSecondsLeft % 60;
      const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      DOM.sleepTimerCountdownText.textContent = `倒數剩餘：${formatted}`;
    }

    function onSoundSleepTimerExpired() {
      stopSoundSleepTimer(false);

      // Stop ambient background sounds
      audioEngine.stopAmbientSound();
      DOM.ambientBtns.forEach(b => b.classList.remove('active'));
      const defaultNoneBtn = document.querySelector('.ambient-btn[data-sound="none"]');
      if (defaultNoneBtn) defaultNoneBtn.classList.add('active');
      DOM.currentAmbientLabel.textContent = '已定時自動關閉';

      // Claim the binaural graph first so the gentle 2s fade wins over the
      // 0.5s teardown inside stopDeepSleepStudioEngine().
      audioEngine.stopBinauralBeats(2.0);
      binauralState.enabled = false;
      DOM.binauralToggle.checked = false;

      // "Auto-off" must mean every source: the NREM engine and the YouTube
      // track are sound too, and used to keep playing all night.
      if (deepSleepState.running || deepSleepState.paused) {
        stopDeepSleepStudioEngine(false);
      }
      stopYouTubeTrack();

      DOM.sleepTimerStatusBadge.textContent = '已完成音效自動關閉';
      DOM.sleepTimerStatusBadge.classList.remove('active');
    }

    function stopSoundSleepTimer(resetBadge = true) {
      if (sleepTimerInterval) {
        clearInterval(sleepTimerInterval);
        sleepTimerInterval = null;
      }
      DOM.startSleepTimerBtn.classList.remove('hidden');
      DOM.cancelSleepTimerBtn.classList.add('hidden');
      DOM.sleepTimerCountdownText.classList.add('hidden');

      if (resetBadge) {
        DOM.sleepTimerStatusBadge.textContent = '未設定';
        DOM.sleepTimerStatusBadge.classList.remove('active');
      }
    }

    // Sleep Timer Preset Buttons
    DOM.sleepPresetChips?.forEach(chip => {
      chip.addEventListener('click', () => {
        const m = parseInt(chip.dataset.min, 10) || 0;
        const s = parseInt(chip.dataset.sec, 10) || 0;
        if (DOM.sleepTimerMin) DOM.sleepTimerMin.value = m;
        if (DOM.sleepTimerSec) DOM.sleepTimerSec.value = s;
      });
    });

    DOM.startSleepTimerBtn?.addEventListener('click', () => {
      const m = parseInt(DOM.sleepTimerMin?.value || 0, 10);
      const s = parseInt(DOM.sleepTimerSec?.value || 0, 10);
      const totalSec = m * 60 + s;
      startSoundSleepTimer(totalSec);
    });

    DOM.cancelSleepTimerBtn?.addEventListener('click', () => {
      stopSoundSleepTimer(true);
    });

    // Filter Chips
    DOM.filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        DOM.filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentFilter = chip.dataset.filter;
        renderTasks();
      });
    });

    // Task Modals
    DOM.addTaskBtn?.addEventListener('click', openAddTaskModal);
    DOM.taskForm?.addEventListener('submit', saveTaskFromForm);
    DOM.closeTaskModalBtn?.addEventListener('click', () => closeModal(DOM.taskModal));
    DOM.cancelTaskModalBtn?.addEventListener('click', () => closeModal(DOM.taskModal));

    // Analytics Modal
    DOM.analyticsBtn?.addEventListener('click', openAnalyticsModal);
    DOM.closeAnalyticsModalBtn?.addEventListener('click', () => closeModal(DOM.analyticsModal));

    // Version Information Modal
    DOM.versionBadgeBtn?.addEventListener('click', () => {
      DOM.versionModal?.classList.remove('hidden');
    });
    DOM.closeVersionModalBtn?.addEventListener('click', () => {
      DOM.versionModal?.classList.add('hidden');
    });
    DOM.closeVersionModalFooterBtn?.addEventListener('click', () => {
      DOM.versionModal?.classList.add('hidden');
    });

    // Settings Modal
    DOM.settingsBtn?.addEventListener('click', openSettingsModal);
    DOM.closeSettingsModalBtn?.addEventListener('click', () => closeModal(DOM.settingsModal));
    DOM.saveSettingsBtn?.addEventListener('click', saveSettings);
    DOM.testSoundBtn?.addEventListener('click', () => {
      audioEngine.playAlertSound(DOM.settingSoundSelect?.value);
    });

    DOM.requestNotificationBtn?.addEventListener('click', () => {
      if ('Notification' in window) {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            alert('🔔 桌面系統通知已成功啟用！');
          } else {
            alert('⚠️ 無法啟用通知，請在瀏覽器設定中允許通知權限。');
          }
        });
      }
    });

    // Theme Switch
    DOM.themeSelect?.addEventListener('change', (e) => {
      settings.theme = e.target.value;
      saveToStorage(STORAGE_KEYS.SETTINGS, settings);
      updateThemeUI();
    });

    // Export / Import
    DOM.exportDataBtn?.addEventListener('click', exportBackupData);
    DOM.importDataInput?.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        importBackupData(e.target.files[0]);
      }
    });

    // Zen Mode Toggle
    DOM.zenBtn?.addEventListener('click', () => {
      DOM.zenOverlay?.classList.remove('hidden');
      // The overlay ships with a hardcoded label; sync it to the real state.
      syncTimerButtons();
    });

    DOM.exitZenBtn?.addEventListener('click', () => {
      DOM.zenOverlay?.classList.add('hidden');
    });

    // Keyboard Shortcuts
    const overlays = () => [DOM.taskModal, DOM.analyticsModal, DOM.settingsModal, DOM.versionModal];
    const anyModalOpen = () => overlays().some(m => m && !m.classList.contains('hidden'));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Close only the topmost layer, so Esc in a modal doesn't also drop
        // the user out of zen mode behind it.
        if (anyModalOpen()) {
          overlays().forEach(m => { if (m) closeModal(m); });
        } else if (DOM.zenOverlay && !DOM.zenOverlay.classList.contains('hidden')) {
          DOM.zenOverlay.classList.add('hidden');
        }
        return;
      }

      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      // Space used to start the timer behind an open dialog.
      if (e.code === 'Space' && !typing && !anyModalOpen()) {
        e.preventDefault();
        toggleTimer();
      }
    });
  }

  // Helper Functions
  function closeModal(modalEl) {
    modalEl.classList.add('hidden');
  }

  function loadFromStorage(key, defaultVal) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultVal;
    } catch (e) {
      return defaultVal;
    }
  }

  function saveToStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error('Failed to save to localStorage:', e);
    }
  }

  function getTodayDateString() {
    return formatDateString(new Date());
  }

  // Was called by the mini widget but never defined — every dock refresh threw
  // a ReferenceError, which is why it rendered once and then froze.
  function formatTime(totalSec) {
    const s = Math.max(0, Math.round(totalSec || 0));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function formatDateString(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // Coerce first: imported backups can carry numbers/null/objects in these
  // fields, and calling .replace on a non-string used to blow up the render.
  function escapeHTML(str) {
    return String(str == null ? '' : str).replace(/[&<>'"]/g,
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  // --------------------------------------------------------------------------
  // 9. App Initialization
  // --------------------------------------------------------------------------
  setupEventListeners();
  initTimer();

})();
