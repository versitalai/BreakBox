// BreakBox AudioWorkletProcessor
// Runs synthesis off the main thread. Receives commands via port.postMessage(),
// outputs audio via process() callback.
// Minimum viable processor — scaffold only. Real DSP comes from porting Synth internals.
class BreakBoxProcessor extends AudioWorkletProcessor {
    sampleRate = 44100;
    playing = false;
    currentTick = 0;
    ticksPerBuffer = 0;
    samplesPerTick = 0;
    // Sample pool: key -> Float32Array (decoded, resampled to worklet sampleRate)
    samplePool = new Map();
    sampleMeta = new Map();
    // Voice pool
    voices = [];
    freeVoiceIndices = [];
    // Modulation values (song-scoped and instrument-scoped)
    modValues = new Map(); // setting -> value
    nextModValues = new Map(); // setting -> next value
    modInsValues = new Map(); // "ch:in" -> setting -> value
    nextModInsValues = new Map();
    // Scheduler queue (lookahead)
    commandQueue = [];
    // Master
    masterVolume = 1.0;
    limiterEnabled = true;
    constructor(options) {
        super(options);
        this.port.onmessage = (e) => this.handleCommand(e.data);
    }
    handleCommand(msg) {
        const { type, payload } = msg;
        switch (type) {
            case 'init':
                this.initialize(payload);
                break;
            case 'play':
                this.playing = true;
                break;
            case 'pause':
                this.playing = false;
                break;
            case 'stop':
                this.playing = false;
                this.currentTick = 0;
                this.allNotesOff();
                break;
            case 'seek':
                this.currentTick = payload.tick;
                this.allNotesOff();
                break;
            case 'load_sample':
                this.loadSample(payload);
                break;
            case 'set_mod':
                this.setMod(payload);
                break;
            case 'unset_mod':
                this.unsetMod(payload);
                break;
            case 'note_on':
                this.scheduleNoteOn(payload);
                break;
            case 'note_off':
                this.scheduleNoteOff(payload);
                break;
            case 'update_fx':
                this.updateVoiceFx(payload);
                break;
            case 'set_master':
                this.masterVolume = payload.volume;
                this.limiterEnabled = payload.limiterEnabled;
                break;
        }
    }
    initialize(payload) {
        this.sampleRate = payload.sampleRate;
        // tempo is beats/min; parts per beat = 4 -> parts/sec = tempo/15.
        // Samples per part = sampleRate / (parts/sec).
        const partsPerSecond = payload.songData.tempo / 15;
        this.samplesPerTick = partsPerSecond > 0 ? this.sampleRate / partsPerSecond : this.sampleRate / 8;
        this.ticksPerBuffer = 128 / this.samplesPerTick; // 128 = render quantum
        // TODO: parse songData, initialize instruments, patterns, etc.
    }
    loadSample(payload) {
        // TODO: decode audioBuffer (needs AudioContext - not available in worklet!)
        // Workaround: main thread decodes, sends Float32Array via transferable
        // For now, assume payload.buffer is already Float32Array (transferred)
        const samples = new Float32Array(payload.buffer);
        this.samplePool.set(payload.key, samples);
        this.sampleMeta.set(payload.key, { rootKey: payload.rootKey, loop: payload.loop });
        this.port.postMessage({ type: 'sample_loaded', payload: { key: payload.key } });
    }
    setMod(payload) {
        const key = payload.channel != null && payload.instrument != null
            ? `${payload.channel}:${payload.instrument}`
            : 'song';
        const map = key === 'song' ? this.modValues : (this.modInsValues.get(key) || new Map());
        const nextMap = key === 'song' ? this.nextModValues : (this.nextModInsValues.get(key) || new Map());
        map.set(payload.setting, payload.value);
        nextMap.set(payload.setting, payload.nextValue);
        if (key !== 'song') {
            this.modInsValues.set(key, map);
            this.nextModInsValues.set(key, nextMap);
        }
    }
    unsetMod(payload) {
        const key = payload.channel != null && payload.instrument != null
            ? `${payload.channel}:${payload.instrument}`
            : 'song';
        if (key === 'song') {
            this.modValues.delete(payload.setting);
            this.nextModValues.delete(payload.setting);
        }
        else {
            this.modInsValues.get(key)?.delete(payload.setting);
            this.nextModInsValues.get(key)?.delete(payload.setting);
        }
    }
    scheduleNoteOn(payload) {
        // Push to scheduler queue for sample-accurate timing
        this.commandQueue.push({ tick: payload.tick, cmd: { type: 'note_on', payload } });
        this.commandQueue.sort((a, b) => a.tick - b.tick);
    }
    scheduleNoteOff(payload) {
        this.commandQueue.push({ tick: payload.tick, cmd: { type: 'note_off', payload } });
        this.commandQueue.sort((a, b) => a.tick - b.tick);
    }
    updateVoiceFx(payload) {
        // Find voice and update FX
        for (const voice of this.voices) {
            if (voice.pitch === payload.pitch && voice.channel === payload.channel && voice.instrument === payload.instrument) {
                voice.fx = { ...voice.fx, ...payload.fx };
                break;
            }
        }
    }
    allNotesOff() {
        for (const voice of this.voices) {
            voice.active = false;
        }
        this.freeVoiceIndices = this.voices.map((_, i) => i);
        this.commandQueue = [];
    }
    getVoice() {
        if (this.freeVoiceIndices.length > 0) {
            const idx = this.freeVoiceIndices.pop();
            return this.voices[idx];
        }
        if (this.voices.length < 128) { // max polyphony
            const v = this.createVoice();
            this.voices.push(v);
            return v;
        }
        // Voice stealing: find oldest released voice
        let oldest = 0;
        let oldestTime = Infinity;
        for (let i = 0; i < this.voices.length; i++) {
            if (!this.voices[i].active && this.voices[i].currentTick < oldestTime) {
                oldestTime = this.voices[i].currentTick;
                oldest = i;
            }
        }
        return this.voices[oldest];
    }
    createVoice() {
        return {
            pitch: 0, velocity: 0, channel: 0, instrument: 0,
            startTick: 0, currentTick: 0, probability: 1, rollCount: 1,
            sampleKey: null, transpose: 0, reverse: false, samplePitchLock: false,
            fx: { bitcrush: 0, filterCutoff: 1, filterResonance: 0, drive: 0, pan: 0 },
            active: false, phase: 0, phaseIncrement: 0,
            envelopeStates: [], filterState: null,
        };
    }
    processScheduledCommands(currentTick) {
        while (this.commandQueue.length > 0 && this.commandQueue[0].tick <= currentTick) {
            const { cmd } = this.commandQueue.shift();
            if (cmd.type === 'note_on')
                this.triggerNoteOn(cmd.payload);
            else if (cmd.type === 'note_off')
                this.triggerNoteOff(cmd.payload);
        }
    }
    triggerNoteOn(payload) {
        const voice = this.getVoice();
        if (!voice)
            return;
        voice.pitch = payload.pitch;
        voice.velocity = payload.velocity;
        voice.channel = payload.channel;
        voice.instrument = payload.instrument;
        voice.startTick = payload.tick;
        voice.currentTick = payload.tick;
        voice.probability = payload.probability ?? 1;
        voice.rollCount = payload.rollCount ?? 1;
        voice.sampleKey = payload.sampleKey ?? null;
        voice.transpose = payload.transpose ?? 0;
        voice.reverse = payload.reverse ?? false;
        voice.samplePitchLock = payload.samplePitchLock ?? false;
        voice.active = true;
        voice.phase = 0;
        // Calculate phase increment from pitch (unless the sample is pitch-locked,
        // in which case the sample plays at its natural speed).
        const freq = 440 * Math.pow(2, (payload.pitch + payload.transpose - 69) / 12);
        voice.phaseIncrement = freq / this.sampleRate;
        // Initialize envelopes, filters, etc. from instrument definition
        // TODO: pull instrument config from songData
    }
    triggerNoteOff(payload) {
        for (const voice of this.voices) {
            if (voice.active &&
                voice.pitch === payload.pitch &&
                voice.channel === payload.channel &&
                voice.instrument === payload.instrument) {
                // Enter release stage
                voice.active = false; // simplified; real impl would set release stage
                this.freeVoiceIndices.push(this.voices.indexOf(voice));
                break;
            }
        }
    }
    // --- DSP helpers (stubs — port from Synth) ---
    renderVoice(voice, outputL, outputR, frames) {
        if (!voice.active)
            return;
        // BreakBox Phase 3: probability gate. Rolled once per note_on (voice
        // creation) so a note is either fully present or fully silent.
        if (voice.probability < 1.0) {
            const seed = Math.floor(voice.startTick * 73856093) ^ (voice.pitch * 19349663) ^ (voice.channel * 83492791);
            const rolled = ((seed ^ (seed >>> 13)) >>> 0) % 1000 / 1000;
            if (rolled >= voice.probability) {
                voice.active = false;
                this.freeVoiceIndices.push(this.voices.indexOf(voice));
                return;
            }
        }
        const sample = voice.sampleKey ? this.samplePool.get(voice.sampleKey) : null;
        let sampleIndex = 0;
        for (let i = 0; i < frames; i++) {
            let val = 0;
            if (sample) {
                // Sample playback with pitch shifting
                // (when samplePitchLock is set, play at the sample's natural rate — no pitch/speed change)
                const rate = voice.samplePitchLock
                    ? 1.0
                    : voice.phaseIncrement * sample.length / 440; // rough
                if (voice.reverse) {
                    sampleIndex = sample.length - 1 - Math.floor(voice.phase * sample.length);
                }
                else {
                    sampleIndex = Math.floor(voice.phase * sample.length);
                }
                if (sampleIndex >= 0 && sampleIndex < sample.length) {
                    val = sample[sampleIndex];
                }
                voice.phase += rate;
                if (voice.phase >= 1)
                    voice.phase -= Math.floor(voice.phase);
            }
            else {
                // Fallback: simple sine
                val = Math.sin(voice.phase * 2 * Math.PI);
                voice.phase += voice.phaseIncrement;
                if (voice.phase >= 1)
                    voice.phase -= 1;
            }
            // Per-voice FX (bitcrush, filter, drive, pan)
            val = this.applyVoiceFx(val, voice.fx);
            // Pan
            const panL = Math.cos((voice.fx.pan + 1) * Math.PI / 4);
            const panR = Math.sin((voice.fx.pan + 1) * Math.PI / 4);
            outputL[i] += val * voice.velocity * panL * this.masterVolume;
            outputR[i] += val * voice.velocity * panR * this.masterVolume;
        }
    }
    applyVoiceFx(input, fx) {
        let out = input;
        // Bitcrush
        if (fx.bitcrush > 0) {
            const levels = Math.pow(2, 16 * (1 - fx.bitcrush));
            out = Math.round(out * levels) / levels;
        }
        // Drive (soft clip)
        if (fx.drive > 0) {
            out = Math.tanh(out * (1 + fx.drive * 10)) / (1 + fx.drive * 10);
        }
        // Filter (1-pole lowpass)
        if (fx.filterCutoff < 1) {
            // Simplified — real impl needs stateful biquad per voice
            out *= fx.filterCutoff;
        }
        return out;
    }
    // --- AudioWorkletProcessor main loop ---
    process(_inputs, outputs, _params) {
        const outputL = outputs[0][0];
        const outputR = outputs[0][1];
        const frames = outputL.length;
        if (!this.playing) {
            outputL.fill(0);
            outputR.fill(0);
            return true;
        }
        // Clear outputs
        outputL.fill(0);
        outputR.fill(0);
        // Process scheduled commands for this buffer
        this.processScheduledCommands(this.currentTick);
        // Render all active voices
        for (const voice of this.voices) {
            if (voice.active) {
                this.renderVoice(voice, outputL, outputR, frames);
                voice.currentTick += frames / this.samplesPerTick;
            }
        }
        // Soft limiter
        if (this.limiterEnabled) {
            for (let i = 0; i < frames; i++) {
                outputL[i] = Math.tanh(outputL[i]);
                outputR[i] = Math.tanh(outputR[i]);
            }
        }
        // Report playhead
        this.currentTick += frames / this.samplesPerTick;
        this.port.postMessage({
            type: 'playhead',
            payload: { tick: this.currentTick }
        });
        return true;
    }
}
registerProcessor('breakbox-processor', BreakBoxProcessor);
//# sourceMappingURL=BreakBoxProcessor.js.map