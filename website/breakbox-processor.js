class BreakBoxProcessor {
    constructor(options) {
        this.sampleRate = 44100;
        this.playing = false;
        this.currentTick = 0;
        this.ticksPerBuffer = 0;
        this.samplesPerTick = 0;
        this.samplePool = new Map();
        this.sampleMeta = new Map();
        this.voices = [];
        this.freeVoiceIndices = [];
        this.modValues = new Map();
        this.nextModValues = new Map();
        this.modInsValues = new Map();
        this.nextModInsValues = new Map();
        this.commandQueue = [];
        this.masterVolume = 1.0;
        this.limiterEnabled = true;
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
        this.ticksPerBuffer = Math.ceil(this.sampleRate / 120);
        this.samplesPerTick = this.sampleRate / 120;
        for (const [key, buffer] of payload.samples) {
            this.samplePool.set(key, buffer);
        }
        for (const [key, meta] of payload.sampleMeta) {
            this.sampleMeta.set(key, meta);
        }
        this.updateSong(payload.songData);
    }
    updateSong(songData) {
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
        this.commandQueue.push({ type: "noteOn", payload });
    }
    noteOff(payload) {
        this.commandQueue.push({ type: "noteOff", payload });
    }
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channelCount = output.length;
        for (let ch = 0; ch < channelCount; ch++) {
            output[ch].fill(0);
        }
        if (!this.playing)
            return true;
        this.currentTick += output[0].length / this.samplesPerTick;
        return true;
    }
}
registerProcessor("breakbox-processor", BreakBoxProcessor);
//# sourceMappingURL=BreakBoxProcessor.js.map