// LegacySynthAdapter - Fallback for browsers without AudioWorklet support.
// Wraps the existing Synth class to match AudioEngineApi interface.

import { Song } from "../synth/synth";
import { Synth } from "../synth/synth";
import { AudioEngineApi } from "./BreakBoxAudioEngine";

export class LegacySynthAdapter implements AudioEngineApi {
    private synth: Synth | null = null;

    async initialize(song: Song): Promise<void> {
        this.synth = new Synth(song);
        // Synth is synchronous, so this resolves immediately
    }

    play(): void {
        this.synth?.play();
    }

    pause(): void {
        this.synth?.pause();
    }

    seek(tick: number): void {
        if (this.synth && this.synth.song) {
            // Convert tick to bar (tick is in parts, bar is in whole bars)
            const partsPerBar = this.synth.song.beatsPerBar * 16 || 256; // Config.partsPerBeat = 16
            const bar = tick / partsPerBar;
            this.synth.goToBar(bar);
        }
    }

    setVolume(volume: number): void {
        if (this.synth) {
            this.synth.volume = volume;
        }
    }

    updateSong(songData: any): void {
        // Legacy synth doesn't support hot-swapping song data easily
        // Would need to recreate the synth
        console.warn("LegacySynthAdapter: updateSong not fully supported");
    }

    updateMod(key: string, value: number, channel?: number, instrument?: number): void {
        if (!this.synth) return;
        if (channel !== undefined && instrument !== undefined) {
            // Instrument-scoped modulation
            // Synth handles this internally via song reference
        } else {
            // Song-scoped modulation
        }
    }

    updateSamples(key: string, buffer: Float32Array, meta: any): void {
        // Synth loads samples on its own
        console.warn("LegacySynthAdapter: updateSamples not supported");
    }

    noteOn(payload: any): void {
        // Legacy synth doesn't have external note triggering
        console.warn("LegacySynthAdapter: noteOn not supported");
    }

    noteOff(payload: any): void {
        console.warn("LegacySynthAdapter: noteOff not supported");
    }

    isWorkletActive(): boolean {
        return false;
    }

    destroy(): void {
        this.synth = null;
    }

    // Expose internal synth for UI reads (playhead, recording state, etc.)
    getInternalSynth(): Synth | null {
        return this.synth;
    }
}