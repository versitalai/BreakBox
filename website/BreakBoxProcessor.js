// BreakBox AudioWorkletProcessor
// Runs synthesis off the main thread. Receives commands via port.postMessage(),
// outputs audio via process() callback.
// Minimum viable processor — scaffold only. Real DSP comes from porting Synth internals.
class BreakBoxProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        this.sampleRate = 44100;
        this.playing = false;
        this.currentTick = 0;
        this.ticksPerBuffer = 0;
        this.samplesPerTick = 0;
        // Sample pool: key -> Float32Array (decoded, resampled to worklet sampleRate)
        this.samplePool = new Map();
        this.sampleMeta = new Map();
        // Voice pool
        this.voices = [];
        this.freeVoiceIndices = [];
        // Modulation values (song-scoped and instrument-scoped)
        this.modValues = new Map(); // setting -> value
        this.nextModValues = new Map(); // setting -> next value
        this.modInsValues = new Map(); // "ch:in" -> setting -> value
        this.nextModInsValues = new Map();
        // Scheduler queue (lookahead)
        this.commandQueue = [];
        // Master
        this.masterVolume = 1.0;
        this.limiterEnabled = true;
        this.port.onmessage = (e) => this.handleCommand(e.data);
    }
    handleCommand(data) {
        switch (data.type) {
            case "init":
                this.init(data.payload);
                break;
            case "play":
                this.playing = true;
                break;
            case "pause":
                this.playing = false;
                break;
            case "seek":
                this.currentTick = data.payload.tick;
                break;
            case "setVolume":
                this.masterVolume = data.payload.volume;
                break;
            case "setSong":
                this.updateSong(data.payload);
                break;
            case "updateMod":
                this.updateMod(data.payload);
                break;
            case "updateSamples":
                this.updateSamples(data.payload);
                break;
            case "noteOn":
                this.noteOn(data.payload);
                break;
            case "noteOff":
                this.noteOff(data.payload);
                break;
        }
    }
    init(payload) {
        this.sampleRate = payload.sampleRate;
        this.ticksPerBuffer = Math.ceil(this.sampleRate / 120); // roughly 120Hz tick rate
        this.samplesPerTick = this.sampleRate / 120;
        // Load samples
        for (const [key, buffer] of payload.samples) {
            this.samplePool.set(key, buffer);
        }
        for (const [key, meta] of payload.sampleMeta) {
            this.sampleMeta.set(key, meta);
        }
        // Initialize song state
        this.updateSong(payload.songData);
    }
    updateSong(songData) {
        // TODO: Parse song data and initialize voices
        this.currentTick = 0;
    }
    updateMod(payload) {
        if (payload.channel !== undefined && payload.instrument !== undefined) {
            const key = `${payload.channel}:${payload.instrument}`;
            let map = this.modInsValues.get(key);
            if (!map) {
                map = new Map();
                this.modInsValues.set(key, map);
            }
            map.set(payload.key, payload.value);
        }
        else {
            this.modValues.set(payload.key, payload.value);
        }
    }
    updateSamples(payload) {
        this.samplePool.set(payload.key, payload.buffer);
        this.sampleMeta.set(payload.key, payload.meta);
    }
    noteOn(payload) {
        // TODO: Add note to scheduler queue
        this.commandQueue.push({ type: "noteOn", payload });
    }
    noteOff(payload) {
        // TODO: Add note off to scheduler queue
        this.commandQueue.push({ type: "noteOff", payload });
    }
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channelCount = output.length;
        // Clear output
        for (let ch = 0; ch < channelCount; ch++) {
            output[ch].fill(0);
        }
        if (!this.playing)
            return true;
        // Generate audio for this buffer
        // TODO: Port actual DSP from Synth.synthesize()
        // For now, generate silence to verify worklet loads
        this.currentTick += output[0].length / this.samplesPerTick;
        return true;
    }
}
registerProcessor("breakbox-processor", BreakBoxProcessor);
//# sourceMappingURL=BreakBoxProcessor.js.map