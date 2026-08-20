// cross-ref: interacts with synth/{AudioEngineApi, synth}
import { Synth } from "../../synth/synth";
import { AudioEngineApi } from "../../synth/AudioEngineApi";

export class LegacySynthAdapter implements AudioEngineApi {
    public onTick?: (tick: number) => void;

    constructor(private inner: Synth) {}

    init(): Promise<void> { return Promise.resolve(); }
    setSong(_song: unknown): void {}
    play(): void { this.inner.play(); }
    pause(): void { this.inner.pause(); }
    stop(): void { this.inner.pause(); this.inner.goToBar(0); }
    seek(tick: number): void { this.inner.goToBar(tick); }
    loadSample(_key: string, _buffer: ArrayBuffer): void {
        // Phase 2 sample ownership transfer
    }
}
