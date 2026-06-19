// BreakBox Audio Engine - Main thread controller for AudioWorklet.
// Manages worklet lifecycle, command queue, and fallback to legacy Synth.

import { Song } from "../synth/synth";
import { LegacySynthAdapter } from "./LegacySynthAdapter";

export type WorkletCommand = 
    | { type: "init"; payload: InitPayload }
    | { type: "play" }
    | { type: "pause" }
    | { type: "seek"; payload: { tick: number } }
    | { type: "setVolume"; payload: { volume: number } }
    | { type: "setSong"; payload: any }
    | { type: "updateMod"; payload: { key: string; value: number; channel?: number; instrument?: number } }
    | { type: "updateSamples"; payload: { key: string; buffer: Float32Array; meta: any } }
    | { type: "noteOn"; payload: any }
    | { type: "noteOff"; payload: any };

export interface InitPayload {
    sampleRate: number;
    songData: any;
    samples: Map<string, Float32Array>;
    sampleMeta: Map<string, any>;
}

export interface AudioEngineApi {
    initialize(song: Song): Promise<void>;
    play(): void;
    pause(): void;
    seek(tick: number): void;
    setVolume(volume: number): void;
    updateSong(songData: any): void;
    updateMod(key: string, value: number, channel?: number, instrument?: number): void;
    updateSamples(key: string, buffer: Float32Array, meta: any): void;
    noteOn(payload: any): void;
    noteOff(payload: any): void;
    isWorkletActive(): boolean;
    destroy(): void;
}

// Re-export LegacySynthAdapter for convenience
export { LegacySynthAdapter };

enum WorkletState {
    Uninitialized = "uninitialized",
    Initializing = "initializing",
    Ready = "ready",
    Failed = "failed"
}

export class BreakBoxAudioEngine implements AudioEngineApi {
    private audioContext: AudioContext | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private state: WorkletState = WorkletState.Uninitialized;
    private commandQueue: WorkletCommand[] = [];
    private initializationPromise: Promise<void> | null = null;

    async initialize(song: Song): Promise<void> {
        if (this.state !== WorkletState.Uninitialized) return;
        
        this.state = WorkletState.Initializing;
        
        this.initializationPromise = this._initializeWorklet(song);
        try {
            await this.initializationPromise;
        } catch (e) {
            console.warn("BreakBoxAudioEngine: Worklet initialization failed, will use legacy synth", e);
            this.state = WorkletState.Failed;
            throw e;
        }
    }

    private async _initializeWorklet(song: Song): Promise<void> {
        this.audioContext = new AudioContext({ latencyHint: "interactive" });
        
        // Resume context if suspended (requires user gesture)
        if (this.audioContext.state === "suspended") {
            await this.audioContext.resume();
        }

        // Load the worklet module
        await this.audioContext.audioWorklet.addModule("/breakbox-processor.js");

        // Collect samples from Synth
        const samples = new Map<string, Float32Array>();
        const sampleMeta = new Map<string, any>();
        // Note: In real implementation, we'd extract samples from the Synth instance
        // For now, worklet will load samples on its own via init payload

        this.workletNode = new AudioWorkletNode(this.audioContext, "breakbox-processor", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });

        this.workletNode.connect(this.audioContext.destination);

        // Send init command
        const initPayload: InitPayload = {
            sampleRate: this.audioContext.sampleRate,
            songData: song.toJsonObject(),
            samples,
            sampleMeta,
        };

        this.sendCommand({ type: "init", payload: initPayload });
        
        this.state = WorkletState.Ready;
        this.flushCommandQueue();
    }

    private sendCommand(command: WorkletCommand): void {
        if (this.state === WorkletState.Ready && this.workletNode) {
            this.workletNode.port.postMessage(command);
        } else {
            this.commandQueue.push(command);
        }
    }

    private flushCommandQueue(): void {
        while (this.commandQueue.length > 0) {
            const cmd = this.commandQueue.shift()!;
            this.sendCommand(cmd);
        }
    }

    play(): void {
        this.sendCommand({ type: "play" });
    }

    pause(): void {
        this.sendCommand({ type: "pause" });
    }

    seek(tick: number): void {
        this.sendCommand({ type: "seek", payload: { tick } });
    }

    setVolume(volume: number): void {
        this.sendCommand({ type: "setVolume", payload: { volume } });
    }

    updateSong(songData: any): void {
        this.sendCommand({ type: "setSong", payload: songData });
    }

    updateMod(key: string, value: number, channel?: number, instrument?: number): void {
        this.sendCommand({ type: "updateMod", payload: { key, value, channel, instrument } });
    }

    updateSamples(key: string, buffer: Float32Array, meta: any): void {
        this.sendCommand({ type: "updateSamples", payload: { key, buffer, meta } });
    }

    noteOn(payload: any): void {
        this.sendCommand({ type: "noteOn", payload });
    }

    noteOff(payload: any): void {
        this.sendCommand({ type: "noteOff", payload });
    }

    isWorkletActive(): boolean {
        return this.state === WorkletState.Ready;
    }

    destroy(): void {
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
        this.state = WorkletState.Uninitialized;
        this.commandQueue = [];
    }
}