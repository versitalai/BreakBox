// WorkletSynthAdapter - Adapts BreakBoxAudioEngine to AudioEngineApi interface.
// Uses AudioWorklet for off-thread synthesis.

import { Song } from "../synth/synth";
import { AudioEngineApi, BreakBoxAudioEngine } from "./BreakBoxAudioEngine";

export class WorkletSynthAdapter implements AudioEngineApi {
    private engine: BreakBoxAudioEngine;
    private initialized = false;

    constructor() {
        this.engine = new BreakBoxAudioEngine();
    }

    async initialize(song: Song): Promise<void> {
        if (this.initialized) return;
        await this.engine.initialize(song);
        this.initialized = true;
    }

    play(): void {
        this.engine.play();
    }

    pause(): void {
        this.engine.pause();
    }

    seek(tick: number): void {
        this.engine.seek(tick);
    }

    setVolume(volume: number): void {
        this.engine.setVolume(volume);
    }

    updateSong(songData: any): void {
        this.engine.updateSong(songData);
    }

    updateMod(key: string, value: number, channel?: number, instrument?: number): void {
        this.engine.updateMod(key, value, channel, instrument);
    }

    updateSamples(key: string, buffer: Float32Array, meta: any): void {
        this.engine.updateSamples(key, buffer, meta);
    }

    noteOn(payload: any): void {
        this.engine.noteOn(payload);
    }

    noteOff(payload: any): void {
        this.engine.noteOff(payload);
    }

    isWorkletActive(): boolean {
        return this.engine.isWorkletActive();
    }

    destroy(): void {
        this.engine.destroy();
        this.initialized = false;
    }
}