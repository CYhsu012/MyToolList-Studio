/* ==========================================================================
   PomodoroFlow - Full-Featured JavaScript Application Logic
   ========================================================================== */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // 1. App State & LocalStorage Configuration
  // --------------------------------------------------------------------------
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

  // Initial State
  let settings = loadFromStorage(STORAGE_KEYS.SETTINGS, defaultSettings);
  let tasks = loadFromStorage(STORAGE_KEYS.TASKS, [
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
  ]);
  let activeTaskId = loadFromStorage(STORAGE_KEYS.ACTIVE_TASK_ID, 'task-1');
  let stats = loadFromStorage(STORAGE_KEYS.STATS, {
    history: {}, // 'YYYY-MM-DD': { count: 0, minutes: 0 }
    streak: 0,
    lastActiveDate: null
  });

  // Timer State
  let timerMode = 'work'; // 'work' | 'shortBreak' | 'longBreak'
  let timerState = 'idle'; // 'idle' | 'running' | 'paused'
  let timerInterval = null;
  let secondsLeft = settings.workTime * 60;
  let totalSeconds = settings.workTime * 60;
  let completedCycles = 0;

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

    connectOutput(node) {
      if (!this.ctx || !node) return;

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
        // Connect ONLY to mediaStreamDest so HTML5 <audio> handles speaker output (Single Audio Path = No Distortion, 100% Background Audio)
        try {
          node.connect(this.mediaStreamDest);
        } catch (e) {
          try { node.connect(this.ctx.destination); } catch (err) {}
        }
      } else {
        // Desktop or browsers without HTML5 MediaStream audio
        try { node.connect(this.ctx.destination); } catch (e) {}
      }
    }

    // --- iOS Safari Lock Screen Background Audio Keeper ---
    enableIOSBackgroundAudioKeeper() {
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
    startBinauralBeats(baseFreq = 200, beatFreq = 10, volumePct = 25, enableMasking = true) {
      this.stopBinauralBeats(0); // Synchronous immediate stop of previous nodes
      this.initCtx();

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

      // Calculate Left & Right pure sine frequencies:
      // f_left = base_freq - (beat_freq / 2.0)
      // f_right = base_freq + (beat_freq / 2.0)
      const fLeft = baseFreq - (beatFreq / 2.0);
      const fRight = baseFreq + (beatFreq / 2.0);

      // Channel Separation: Use StereoPanner if available, or ChannelMergerNode
      const leftPanner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      const rightPanner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;

      this.binauralLeftOsc = this.ctx.createOscillator();
      this.binauralRightOsc = this.ctx.createOscillator();

      this.binauralLeftOsc.type = 'sine';
      this.binauralLeftOsc.frequency.setValueAtTime(fLeft, now);

      this.binauralRightOsc.type = 'sine';
      this.binauralRightOsc.frequency.setValueAtTime(fRight, now);

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

      // Anti-Fatigue Pink Noise Comfort Masking Layer (75% Golden Ratio)
      if (enableMasking) {
        const bufferSize = this.ctx.sampleRate * 2;
        const pinkBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = pinkBuffer.getChannelData(0);
        let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.1;
          b6 = white * 0.115926;
        }

        this.binauralMaskingNoise = this.ctx.createBufferSource();
        this.binauralMaskingNoise.buffer = pinkBuffer;
        this.binauralMaskingNoise.loop = true;

        const maskGainNode = this.ctx.createGain();
        maskGainNode.gain.setValueAtTime(maskNoiseRatio, now);

        const maskFilter = this.ctx.createBiquadFilter();
        maskFilter.type = 'lowpass';
        maskFilter.frequency.setValueAtTime(800, now); // Warm 800Hz lowpass blanket

        this.binauralMaskingNoise.connect(maskFilter);
        maskFilter.connect(maskGainNode);
        maskGainNode.connect(this.binauralMasterGain);
        this.binauralMaskingNoise.start(now);
      }

      this.binauralLeftOsc.start(now);
      this.binauralRightOsc.start(now);
    }

    updateBinauralFrequencies(baseFreq = 200, beatFreq = 10) {
      if (this.ctx && this.binauralLeftOsc && this.binauralRightOsc) {
        const now = this.ctx.currentTime;
        const fLeft = baseFreq - (beatFreq / 2.0);
        const fRight = baseFreq + (beatFreq / 2.0);
        this.binauralLeftOsc.frequency.setValueAtTime(fLeft, now);
        this.binauralRightOsc.frequency.setValueAtTime(fRight, now);
      }
    }

    setBinauralVolume(volumePct) {
      if (this.binauralMasterGain && this.ctx) {
        const targetVol = (volumePct / 100) * 0.4;
        this.binauralMasterGain.gain.setValueAtTime(targetVol, this.ctx.currentTime);
      }
    }

    stopBinauralBeats(fadeSeconds = 0.5) {
      if (this.stopBinauralTimeout) {
        clearTimeout(this.stopBinauralTimeout);
        this.stopBinauralTimeout = null;
      }

      const leftOsc = this.binauralLeftOsc;
      const rightOsc = this.binauralRightOsc;
      const maskingNoise = this.binauralMaskingNoise;
      const masterGain = this.binauralMasterGain;

      this.binauralMasterGain = null;
      this.binauralLeftOsc = null;
      this.binauralRightOsc = null;
      this.binauralMaskingNoise = null;

      if (!masterGain || !this.ctx) return;

      if (fadeSeconds <= 0) {
        if (leftOsc) try { leftOsc.stop(); } catch(e){}
        if (rightOsc) try { rightOsc.stop(); } catch(e){}
        if (maskingNoise) try { maskingNoise.stop(); } catch(e){}
        try { masterGain.disconnect(); } catch(e){}
      } else {
        const now = this.ctx.currentTime;
        try {
          masterGain.gain.linearRampToValueAtTime(0.0001, now + fadeSeconds);
        } catch (e) {}
        this.stopBinauralTimeout = setTimeout(() => {
          if (leftOsc) try { leftOsc.stop(); } catch(e){}
          if (rightOsc) try { rightOsc.stop(); } catch(e){}
          if (maskingNoise) try { maskingNoise.stop(); } catch(e){}
          try { masterGain.disconnect(); } catch(e){}
        }, fadeSeconds * 1000 + 50);
      }
    }
  }

  const audioEngine = new AudioEngine();

  // --------------------------------------------------------------------------
  // 3. UI Elements Selection
  // --------------------------------------------------------------------------
  const DOM = {
    body: document.body,
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

    // Ambient UI
    ambientBtns: document.querySelectorAll('.ambient-btn'),
    ambientVolume: document.getElementById('ambientVolume'),
    currentAmbientLabel: document.getElementById('currentAmbientLabel'),

    // Binaural Beats Studio UI
    binauralToggle: document.getElementById('binauralToggle'),
    binauralCards: document.querySelectorAll('.binaural-card'),
    binauralMathText: document.getElementById('binauralMathText'),
    binauralPerceivedText: document.getElementById('binauralPerceivedText'),
    comfortMaskingToggle: document.getElementById('comfortMaskingToggle'),
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
  // 4. Timer Logic & Functions
  // --------------------------------------------------------------------------
  function initTimer() {
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
    totalSeconds = getDurationForMode(newMode);
    secondsLeft = totalSeconds;

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

  function startTimer() {
    if (timerState === 'running') return;
    audioEngine.initCtx();
    timerState = 'running';

    DOM.startPauseText.textContent = '暫停';
    DOM.zenStartPauseBtn.textContent = '暫停';
    DOM.playPauseIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`;

    timerInterval = setInterval(() => {
      if (secondsLeft > 0) {
        secondsLeft--;
        updateTimerDisplay();
      } else {
        onTimerComplete();
      }
    }, 1000);
  }

  function pauseTimer() {
    timerState = 'paused';
    clearInterval(timerInterval);
    timerInterval = null;

    DOM.startPauseText.textContent = '開始專注';
    DOM.zenStartPauseBtn.textContent = '開始專注';
    DOM.playPauseIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"></polygon>`;
  }

  function resetTimer() {
    pauseTimer();
    secondsLeft = totalSeconds;
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

    // Auto Mode Switch Logic
    if (timerMode === 'work') {
      if (completedCycles % 4 === 0) {
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
    const mins = Math.floor(secondsLeft / 60);
    const secs = secondsLeft % 60;
    const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    DOM.timeText.textContent = formatted;
    DOM.zenTimeText.textContent = formatted;

    // Document Title Update
    const modeLabel = timerMode === 'work' ? '🎯 專注' : (timerMode === 'shortBreak' ? '☕ 短休' : '🌴 長休');
    document.title = `(${formatted}) ${modeLabel} - PomodoroFlow`;

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

      itemEl.innerHTML = `
        <div class="task-left">
          <input type="checkbox" class="task-checkbox" ${task.isDone ? 'checked' : ''} data-id="${task.id}">
          <div class="task-info">
            <div class="task-title">${escapeHTML(task.title)}</div>
            <div class="task-meta">
              <span class="category-tag">${categoryNames[task.category] || '標籤'}</span>
              <span class="priority-dot priority-${task.priority}"></span>
            </div>
          </div>
        </div>
        <div class="task-right">
          <div class="pomo-count">🍅 ${task.completed} / ${task.estimated}</div>
          <div class="task-actions">
            <button class="action-btn edit-task-btn" data-id="${task.id}" title="編輯">✏️</button>
            <button class="action-btn delete-task-btn" data-id="${task.id}" title="刪除">🗑️</button>
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

    DOM.statTodayTime.innerHTML = `${todayData.minutes} <span>分鐘</span>`;
    DOM.statTodayCount.innerHTML = `${todayData.count} <span>個</span>`;

    let totalCount = 0;
    Object.values(stats.history).forEach(d => {
      totalCount += (d.count || 0);
    });
    DOM.statTotalCount.innerHTML = `${totalCount} <span>個</span>`;

    DOM.analyticsModal.classList.remove('hidden');

    // Render Canvas Charts
    setTimeout(() => {
      renderTrendChart();
      renderCategoryChart();
    }, 100);
  }

  function renderTrendChart() {
    const canvas = document.getElementById('trendChartCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

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
    const barWidth = 36;
    const chartHeight = height - padding * 2;

    // Draw Bars
    minutesData.forEach((mins, idx) => {
      const x = padding + idx * ((width - padding * 2) / 7) + 12;
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
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

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

    const centerX = 140;
    const centerY = height / 2;
    const radius = 70;
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
    ctx.arc(centerX, centerY, 40, 0, 2 * Math.PI);
    ctx.fill();

    // Draw Legend on right side
    let legendY = 45;
    Object.keys(catCounts).forEach(cat => {
      const count = catCounts[cat];
      const pct = Math.round((count / total) * 100);

      // Color Box
      ctx.fillStyle = colors[cat];
      ctx.fillRect(260, legendY, 14, 14);

      // Text
      ctx.fillStyle = '#f8fafc';
      ctx.font = '13px Inter';
      ctx.textAlign = 'left';
      ctx.fillText(`${catLabels[cat]}: ${count} 個 (${pct}%)`, 285, legendY + 12);

      legendY += 32;
    });
  }

  // --------------------------------------------------------------------------
  // 7. Settings & Backup Logic
  // --------------------------------------------------------------------------
  function openSettingsModal() {
    DOM.settingWorkTime.value = settings.workTime;
    DOM.settingShortBreak.value = settings.shortBreakTime;
    DOM.settingLongBreak.value = settings.longBreakTime;
    DOM.settingDailyGoal.value = settings.dailyGoal;
    DOM.settingAutoStartBreaks.checked = settings.autoStartBreaks;
    DOM.settingAutoStartWork.checked = settings.autoStartWork;
    DOM.settingSoundSelect.value = settings.alertSound;

    DOM.settingsModal.classList.remove('hidden');
  }

  function saveSettings() {
    settings.workTime = parseInt(DOM.settingWorkTime.value, 10) || 25;
    settings.shortBreakTime = parseInt(DOM.settingShortBreak.value, 10) || 5;
    settings.longBreakTime = parseInt(DOM.settingLongBreak.value, 10) || 15;
    settings.dailyGoal = parseInt(DOM.settingDailyGoal.value, 10) || 8;
    settings.autoStartBreaks = DOM.settingAutoStartBreaks.checked;
    settings.autoStartWork = DOM.settingAutoStartWork.checked;
    settings.alertSound = DOM.settingSoundSelect.value;

    saveToStorage(STORAGE_KEYS.SETTINGS, settings);
    closeModal(DOM.settingsModal);

    // Reset current timer with new settings
    switchMode(timerMode);
    renderDailyGoal();
  }

  function updateThemeUI() {
    DOM.body.setAttribute('data-theme', settings.theme);
    DOM.themeSelect.value = settings.theme;
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

  function importBackupData(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const imported = JSON.parse(e.target.result);
        if (imported.settings && imported.tasks && imported.stats) {
          settings = imported.settings;
          tasks = imported.tasks;
          stats = imported.stats;
          activeTaskId = imported.activeTaskId || (tasks.length > 0 ? tasks[0].id : null);

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
    // Mode Switch Tabs
    DOM.modeTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        switchMode(tab.dataset.mode);
      });
    });

    // Controls
    DOM.startPauseBtn.addEventListener('click', toggleTimer);
    DOM.zenStartPauseBtn.addEventListener('click', toggleTimer);
    DOM.resetTimerBtn.addEventListener('click', resetTimer);
    DOM.skipTimerBtn.addEventListener('click', skipTimer);

    // Universal AudioContext unlocker on first user interaction
    document.addEventListener('click', () => {
      audioEngine.initCtx();
    }, { once: true });

    // Ambient Noise Buttons
    DOM.ambientBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        audioEngine.initCtx();
        const sound = btn.dataset.sound;
        DOM.ambientBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        audioEngine.setAmbientSound(sound);
        DOM.currentAmbientLabel.textContent = sound === 'none' ? '已關閉' : btn.textContent;
      });
    });

    DOM.ambientVolume.addEventListener('input', (e) => {
      audioEngine.setVolume(e.target.value);
    });

    // Dedicated Binaural Beats Studio Logic (Strict Physical & Acoustic Algorithm)
    const wavePresets = {
      alpha: { deltaF: 10, name: 'Alpha (α)', label: '平靜專注、身心平靜、學習狀態' },
      beta: { deltaF: 20, name: 'Beta (β)', label: '高效思考、邏輯分析、高度警覺' },
      gamma: { deltaF: 40, name: 'Gamma (γ)', label: '極限超頻、記憶整合、資訊速處理' },
      theta: { deltaF: 6, name: 'Theta (θ)', label: '靈感發想、深度冥想、直覺創想' },
      delta: { deltaF: 2, name: 'Delta (δ)', label: '身體修復、深層放鬆、緩解失眠' }
    };

    let binauralState = {
      enabled: false,
      waveMode: 'alpha',
      baseFreq: 200, // Carrier Frequency (200 Hz optimal)
      volume: 25,
      comfortMasking: true
    };

    function updateBinauralEngineUI() {
      const preset = wavePresets[binauralState.waveMode] || wavePresets.alpha;
      const deltaF = preset.deltaF;
      const baseFreq = binauralState.baseFreq;

      // Synchronize Card active highlights
      DOM.binauralCards.forEach(c => {
        c.classList.toggle('active', c.dataset.wave === binauralState.waveMode);
      });

      // Mathematical exact pure sine wave frequencies:
      // f_left = base_freq - (deltaF / 2.0)
      // f_right = base_freq + (deltaF / 2.0)
      const fLeft = baseFreq - (deltaF / 2.0);
      const fRight = baseFreq + (deltaF / 2.0);

      // Perceived pitch = (f_left + f_right) / 2 = baseFreq
      const perceivedPitch = baseFreq;

      if (DOM.binauralVolVal) DOM.binauralVolVal.textContent = binauralState.volume;
      if (DOM.binauralMathText) DOM.binauralMathText.textContent = `基頻 ${baseFreq}Hz | 左耳 ${fLeft.toFixed(1)}Hz / 右耳 ${fRight.toFixed(1)}Hz (頻差 Δf = ${deltaF}Hz)`;
      if (DOM.binauralPerceivedText) DOM.binauralPerceivedText.textContent = `感知音高 ${perceivedPitch}Hz（聽感呈現 ${deltaF}Hz 規律脈動 Tremolo 與頭腦中央相位移動感）`;

      if (binauralState.enabled) {
        audioEngine.startBinauralBeats(baseFreq, deltaF, binauralState.volume, binauralState.comfortMasking);
      } else {
        audioEngine.stopBinauralBeats(0.5);
      }
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
        updateBinauralEngineUI();
      });
    });

    DOM.comfortMaskingToggle?.addEventListener('change', (e) => {
      binauralState.comfortMasking = e.target.checked;
      if (binauralState.enabled) {
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

      sleepTimerInterval = setInterval(() => {
        if (sleepTimerSecondsLeft > 0) {
          sleepTimerSecondsLeft--;
          updateSleepCountdownDisplay();
        } else {
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

      // Stop Binaural Beats with gentle 2s fade out
      audioEngine.stopBinauralBeats(2.0);
      binauralState.enabled = false;
      DOM.binauralToggle.checked = false;

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
    DOM.addTaskBtn.addEventListener('click', openAddTaskModal);
    DOM.taskForm.addEventListener('submit', saveTaskFromForm);
    DOM.closeTaskModalBtn.addEventListener('click', () => closeModal(DOM.taskModal));
    DOM.cancelTaskModalBtn.addEventListener('click', () => closeModal(DOM.taskModal));

    // Analytics Modal
    DOM.analyticsBtn.addEventListener('click', openAnalyticsModal);
    DOM.closeAnalyticsModalBtn.addEventListener('click', () => closeModal(DOM.analyticsModal));

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
    DOM.settingsBtn.addEventListener('click', openSettingsModal);
    DOM.closeSettingsModalBtn.addEventListener('click', () => closeModal(DOM.settingsModal));
    DOM.saveSettingsBtn.addEventListener('click', saveSettings);
    DOM.testSoundBtn.addEventListener('click', () => {
      audioEngine.playAlertSound(DOM.settingSoundSelect.value);
    });

    DOM.requestNotificationBtn.addEventListener('click', () => {
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
    DOM.themeSelect.addEventListener('change', (e) => {
      settings.theme = e.target.value;
      saveToStorage(STORAGE_KEYS.SETTINGS, settings);
      updateThemeUI();
    });

    // Export / Import
    DOM.exportDataBtn.addEventListener('click', exportBackupData);
    DOM.importDataInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        importBackupData(e.target.files[0]);
      }
    });

    // Zen Mode Toggle
    DOM.zenBtn.addEventListener('click', () => {
      DOM.zenOverlay.classList.remove('hidden');
    });

    DOM.exitZenBtn.addEventListener('click', () => {
      DOM.zenOverlay.classList.add('hidden');
    });

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        DOM.zenOverlay.classList.add('hidden');
        closeModal(DOM.taskModal);
        closeModal(DOM.analyticsModal);
        closeModal(DOM.settingsModal);
      }
      if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'TEXTAREA') {
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

  function formatDateString(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  // --------------------------------------------------------------------------
  // 9. App Initialization
  // --------------------------------------------------------------------------
  setupEventListeners();
  initTimer();

})();
