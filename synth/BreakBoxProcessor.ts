// BreakBox AudioWorkletProcessor
// Runs synthesis off the main thread. Receives commands via port.postMessage(),
// outputs audio via process() callback.
// Minimum viable processor — scaffold only. Real DSP comes from porting Synth internals.

// Type declarations for AudioWorklet (not in standard TypeScript lib)
interface AudioWorkletProcessorBase {
    readonly port: MessagePort;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
interface AudioWorkletNodeOptions extends AudioNodeOptions {
    processorOptions?: any;
    numberOfInputs?: number;
    numberOfOutputs?: number;
    outputChannelCount?: number[];
}
declare var AudioWorkletProcessor: {
    prototype: AudioWorkletProcessorBase;
    new(options: AudioWorkletNodeOptions): AudioWorkletProcessorBase;
};
declare function registerProcessor(name: string, processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessorBase): void;

interface WorkletCommand {
    type: "init" | "play" | "pause" | "seek" | "setVolume" | "setSong" | "updateMod" | "updateSamples" | "noteOn" | "noteOff";
    payload: any;
}

interface InitPayload {
    sampleRate: number;
    songData: any;
    samples: Map<string, Float32Array>;
    sampleMeta: Map<string, any>;
}

class BreakBoxProcessor implements AudioWorkletProcessorBase {
    readonly port!: MessagePort;
    sampleRate = 44100;
    playing = false;
    currentTick = 0;
    ticksPerBuffer = 0;
    samplesPerTick = 0;
    // Sample pool: key -> Float32Array (decoded, resampled to worklet sampleRate)
    samplePool = new Map<string, Float32Array>();
    sampleMeta = new Map<string, any>();
    // Voice pool
    voices: any[] = [];
    freeVoiceIndices: number[] = [];
    // Modulation values (song-scoped and instrument-scoped)
    modValues = new Map<string, number>(); // setting -> value
    nextModValues = new Map<string, number>(); // setting -> next value
    modInsValues = new Map<string, Map<string, number>>(); // "ch:in" -> setting -> value
    nextModInsValues = new Map<string, Map<string, number>>();
    // Scheduler queue (lookahead)
    commandQueue: WorkletCommand[] = [];
    // Master
    masterVolume = 1.0;
    limiterEnabled = true;

    constructor(options: AudioWorkletNodeOptions) {
        // @ts-ignore - AudioWorkletProcessor constructor handled by browser
    }

    handleCommand(data: WorkletCommand): void {
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

    init(payload: InitPayload): void {
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

    updateSong(songData: any): void {
        // TODO: Parse song data and initialize voices
        this.currentTick = 0;
    }

    updateMod(payload: { key: string; value: number; channel?: number; instrument?: number }): void {
        if (payload.channel !== undefined && payload.instrument !== undefined) {
            const key = `${payload.channel}:${payload.instrument}`;
            let map = this.modInsValues.get(key);
            if (!map) {
                map = new Map();
                this.modInsValues.set(key, map);
            }
            map.set(payload.key, payload.value);
        } else {
            this.modValues.set(payload.key, payload.value);
        }
    }

    updateSamples(payload: { key: string; buffer: Float32Array; meta: any }): void {
        this.samplePool.set(payload.key, payload.buffer);
        this.sampleMeta.set(payload.key, payload.meta);
    }

    noteOn(payload: any): void {
        // TODO: Add note to scheduler queue
        this.commandQueue.push({ type: "noteOn", payload });
    }

    noteOff(payload: any): void {
        // TODO: Add note off to scheduler queue
        this.commandQueue.push({ type: "noteOff", payload });
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
        const output = outputs[0];
        const channelCount = output.length;

        // Clear output
        for (let ch = 0; ch < channelCount; ch++) {
            output[ch].fill(0);
        }

        if (!this.playing) return true;

        // Generate audio for this buffer
        // TODO: Port actual DSP from Synth.synthesize()
        // For now, generate silence to verify worklet loads

        this.currentTick += output[0].length / this.samplesPerTick;
        return true;
    }
}

registerProcessor("breakbox-processor", BreakBoxProcessor);