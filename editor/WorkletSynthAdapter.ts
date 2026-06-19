// WorkletSynthAdapter — AudioEngineApi implementation using AudioWorklet
// Prefers AudioWorklet; falls back to LegacySynthAdapter if unavailable.

import { AudioEngineApi, NoteVoice, VoiceFx } from "../synth/AudioEngineApi";
import { Synth } from "../synth/synth";
import { BreakBoxAudioEngine } from "../synth/BreakBoxAudioEngine";
import { LegacySynthAdapter } from "./LegacySynthAdapter";

export class WorkletSynthAdapter implements AudioEngineApi {
    private engine: BreakBoxAudioEngine | null = null;
    private fallback: LegacySynthAdapter | null = null;
    private useWorklet: boolean = false;

    constructor() {
        this.useWorklet = this.supportsAudioWorklet();
    }

    private supportsAudioWorklet(): boolean {
        return typeof AudioContext !== 'undefined' &&
               typeof AudioWorkletNode !== 'undefined' &&
               'audioWorklet' in AudioContext.prototype;
    }

    async init(): Promise<void> {
        if (this.useWorklet) {
            try {
                this.engine = new BreakBoxAudioEngine();
                await this.engine.init();
                return;
            } catch (e) {
                console.warn('AudioWorklet initialization failed, falling back to legacy synth:', e);
                this.useWorklet = false;
            }
        }
        // Fallback
        const legacySynth = new Synth(null!); // song set later via setSong
        this.fallback = new LegacySynthAdapter(legacySynth);
        await this.fallback.init();
    }

    setSong(song: unknown): void {
        if (this.engine) {
            this.engine.setSong(song);
        } else if (this.fallback) {
            this.fallback.setSong(song);
        }
    }

    play(): void {
        this.engine?.play() ?? this.fallback?.play();
    }

    pause(): void {
        this.engine?.pause() ?? this.fallback?.pause();
    }

    stop(): void {
        this.engine?.stop() ?? this.fallback?.stop();
    }

    seek(tick: number): void {
        this.engine?.seek(tick) ?? this.fallback?.seek(tick);
    }

    loadSample(key: string, buffer: ArrayBuffer): void {
        this.engine?.loadSample(key, buffer) ?? this.fallback?.loadSample(key, buffer);
    }

    // Delegate onTick callback
    get onTick(): ((tick: number) => void) | undefined {
        if (this.engine) return this.engine.onTick;
        return this.fallback?.onTick;
    }
    set onTick(callback: ((tick: number) => void) | undefined) {
        if (this.engine) this.engine.onTick = callback;
        if (this.fallback) this.fallback.onTick = callback;
    }

    // New scheduling API (only available with worklet)
    scheduleNoteOn(voice: NoteVoice, tick: number): void {
        this.engine?.scheduleNoteOn(voice, tick);
    }

    scheduleNoteOff(pitch: number, channel: number, instrument: number, tick: number): void {
        this.engine?.scheduleNoteOff(pitch, channel, instrument, tick);
    }

    scheduleFxUpdate(pitch: number, channel: number, instrument: number, fx: Partial<VoiceFx>, tick: number): void {
        this.engine?.scheduleFxUpdate(pitch, channel, instrument, fx, tick);
    }

    setMasterVolume(volume: number): void {
        this.engine?.setMasterVolume(volume);
    }

    dispose(): void {
        this.engine?.dispose();
        this.engine = null;
        this.fallback = null;
    }
}