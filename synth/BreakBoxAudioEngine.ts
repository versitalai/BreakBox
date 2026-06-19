// BreakBoxAudioEngine — main-thread AudioEngineApi implementation using AudioWorklet
// Loads BreakBoxProcessor, manages command queue, handles sample transfer.

import { AudioEngineApi, NoteVoice, VoiceFx, VoiceCommand } from "./AudioEngineApi";
import { Song } from "./synth";

export class BreakBoxAudioEngine implements AudioEngineApi {
    private audioContext: AudioContext | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private song: Song | null = null;
    private initialized: boolean = false;
    private sampleRate: number = 44100;
    private lookaheadMs: number = 30; // 25-50ms lookahead
    private schedulerTimer: number | null = null;
    private scheduledCommands: Array<{ tick: number; cmd: VoiceCommand }> = [];

    // AudioEngineApi implementation
    async init(): Promise<void> {
        if (this.initialized) return;

        this.audioContext = new AudioContext({ latencyHint: 'interactive' });
        this.sampleRate = this.audioContext.sampleRate;

        // Load the AudioWorklet module
        await this.audioContext.audioWorklet.addModule('/breakbox-processor.js');

        // Create the worklet node
        this.workletNode = new AudioWorkletNode(this.audioContext, 'breakbox-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { sampleRate: this.sampleRate }
        });

        // Handle messages from worklet
        this.workletNode.port.onmessage = (e: MessageEvent) => this.handleWorkletMessage(e.data);

        // Connect to destination
        this.workletNode.connect(this.audioContext.destination);

        // Initialize the processor with empty song data (will be set via setSong)
        this.sendCommand('init', { sampleRate: this.sampleRate, songData: {} });

        this.initialized = true;
    }

    setSong(song: unknown): void {
        this.song = song as Song;
        // Send full song data to worklet for initialization
        this.sendCommand('init', {
            sampleRate: this.sampleRate,
            songData: this.serializeSongForWorklet(this.song)
        });
    }

    play(): void {
        this.sendCommand('play', {});
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        this.startScheduler();
    }

    pause(): void {
        this.sendCommand('pause', {});
        this.stopScheduler();
    }

    stop(): void {
        this.sendCommand('stop', {});
        this.stopScheduler();
    }

    seek(tick: number): void {
        this.sendCommand('seek', { tick });
    }

    loadSample(key: string, buffer: ArrayBuffer): void {
        // Transfer ownership to worklet (zero-copy)
        this.sendCommand('load_sample', {
            key,
            buffer,
            sampleRate: this.sampleRate,
            rootKey: 60, // TODO: extract from sample metadata
            loop: undefined
        }, [buffer]);
    }

    onTick?: (tick: number) => void;

    // Internal methods
    private sendCommand(type: string, payload: any, transferables: Transferable[] = []): void {
        if (!this.workletNode) {
            console.warn('Worklet not initialized, queueing command:', type);
            return;
        }
        this.workletNode.port.postMessage({ type, payload }, transferables);
    }

    private handleWorkletMessage(msg: any): void {
        const { type, payload } = msg;
        switch (type) {
            case 'playhead':
                if (this.onTick) this.onTick(payload.tick);
                break;
            case 'sample_loaded':
                console.log('Sample loaded in worklet:', payload.key);
                break;
            case 'mod_values':
                // Handle mod value updates if needed
                break;
            case 'error':
                console.error('Worklet error:', payload);
                break;
        }
    }

    private serializeSongForWorklet(song: Song): any {
        // Extract only what the worklet needs for scheduling
        // This is a minimal subset — expand as worklet DSP grows
        return {
            tempo: song.tempo,
            beatsPerBar: song.beatsPerBar,
            barCount: song.barCount,
            loopStart: song.loopStart,
            loopLength: song.loopLength,
            channels: song.channels.map(ch => ({
                muted: ch.muted,
                instruments: ch.instruments.map(inst => this.serializeInstrument(inst))
            }))
        };
    }

    private serializeInstrument(inst: any): any {
        // Minimal instrument data for worklet
        return {
            type: inst.type,
            volume: inst.volume,
            pan: inst.pan,
            // Add more as needed for DSP
        };
    }

    // Scheduler: runs on main thread, pushes commands ~lookaheadMs ahead
    private startScheduler(): void {
        if (this.schedulerTimer) return;
        const schedule = () => {
            if (!this.workletNode || !this.song) return;
            const currentTick = this.estimateCurrentTick();
            const lookaheadTicks = (this.lookaheadMs / 1000) * this.getTicksPerSecond();

            // Process scheduled commands within lookahead window
            while (this.scheduledCommands.length > 0 &&
                   this.scheduledCommands[0].tick <= currentTick + lookaheadTicks) {
                const { cmd } = this.scheduledCommands.shift()!;
                this.sendCommandToWorklet(cmd);
            }

            this.schedulerTimer = window.setTimeout(schedule, 5); // ~200Hz scheduler tick
        };
        schedule();
    }

    private stopScheduler(): void {
        if (this.schedulerTimer) {
            clearTimeout(this.schedulerTimer);
            this.schedulerTimer = null;
        }
    }

    private estimateCurrentTick(): number {
        // Rough estimate based on audioContext time
        if (!this.audioContext) return 0;
        const elapsed = this.audioContext.currentTime * this.getTicksPerSecond();
        return elapsed;
    }

    private getTicksPerSecond(): number {
        if (!this.song) return 480; // default: 120 BPM * 4 parts/beat
        return (this.song.tempo / 60) * 4; // parts per second
    }

    private sendCommandToWorklet(cmd: VoiceCommand): void {
        const payload: any = { tick: cmd.tick };
        switch (cmd.type) {
            case 'note_on':
                payload.type = 'note_on';
                payload.voice = cmd.voice;
                break;
            case 'note_off':
                payload.type = 'note_off';
                payload.voice = cmd.voice; // only pitch/channel/instrument needed
                break;
            case 'update_fx':
                payload.type = 'update_fx';
                payload.fx = cmd.fx;
                break;
        }
        this.sendCommand(cmd.type, payload);
    }

    // Public scheduling API (called by editor when modifying notes)
    scheduleNoteOn(voice: NoteVoice, tick: number): void {
        const cmd: VoiceCommand = { type: 'note_on', tick, voice };
        this.scheduledCommands.push({ tick, cmd });
        this.scheduledCommands.sort((a, b) => a.tick - b.tick);
    }

    scheduleNoteOff(pitch: number, channel: number, instrument: number, tick: number): void {
        const voice: NoteVoice = { pitch, start: 0, end: 0, velocity: 0, probability: 1, rollCount: 1, sampleKey: null, transpose: 0, reverse: false };
        const cmd: VoiceCommand = { type: 'note_off', tick, voice };
        this.scheduledCommands.push({ tick, cmd });
        this.scheduledCommands.sort((a, b) => a.tick - b.tick);
    }

    scheduleFxUpdate(pitch: number, channel: number, instrument: number, fx: Partial<VoiceFx>, tick: number): void {
        const cmd: VoiceCommand = { type: 'update_fx', tick, voice: { pitch, start: 0, end: 0, velocity: 0, probability: 1, rollCount: 1, sampleKey: null, transpose: 0, reverse: false }, fx };
        this.scheduledCommands.push({ tick, cmd });
        this.scheduledCommands.sort((a, b) => a.tick - b.tick);
    }

    setMasterVolume(volume: number): void {
        this.sendCommand('set_master', { volume, limiterEnabled: true });
    }

    // Cleanup
    dispose(): void {
        this.stopScheduler();
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.initialized = false;
    }
}