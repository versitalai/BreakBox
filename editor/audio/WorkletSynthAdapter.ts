// cross-ref: interacts with synth/{AudioEngineApi, BreakBoxAudioEngine, synth}
// WorkletSynthAdapter — AudioEngineApi implementation using AudioWorklet
// Prefers AudioWorklet; falls back to LegacySynthAdapter if unavailable.

import { AudioEngineApi, NoteVoice, VoiceFx } from "../../synth/AudioEngineApi";
import { Synth } from "../../synth/synth";
import { BreakBoxAudioEngine } from "../../synth/BreakBoxAudioEngine";
import { LegacySynthAdapter } from "./LegacySynthAdapter";

export class WorkletSynthAdapter implements AudioEngineApi {
    private engine: BreakBoxAudioEngine | null = null;
    private fallback: LegacySynthAdapter | null = null;
    private useWorklet: boolean = false;
    private legacySynth: Synth;

    constructor(legacySynth: Synth) {
        this.legacySynth = legacySynth;
        // Phase 1: the worklet DSP is still a scaffold (sine/sample playback).
        // Prefer the full legacy synth for real playback; the worklet path is
        // exercised when explicitly enabled (feature flag) so we don't regress
        // audio quality before the full DSP port lands.
        this.useWorklet = false;
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
        // Fallback: use the song-carrying legacy synth (NOT a fresh null-song
        // synth — that would play silence).
        this.fallback = new LegacySynthAdapter(this.legacySynth);
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