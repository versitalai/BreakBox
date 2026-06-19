export interface AudioEngineApi {
    // Lifecycle
    init(): Promise<void>;
    setSong(song: unknown): void;
    play(): void;
    pause(): void;
    stop(): void;
    seek(tick: number): void;

    // Sample ownership transfer (used by UI importer / mapper)
    loadSample(key: string, buffer: ArrayBuffer): void;

    // Scheduling hook
    onTick?(tick: number): void;
}

export interface NoteVoice {
    readonly pitch: number;
    readonly start: number;
    readonly end: number;
    readonly velocity: number; // 0..1
    readonly probability: number; // 0..1
    readonly rollCount: number;
    readonly sampleKey: string | null;
    readonly transpose: number;
    readonly reverse: boolean;
}

export interface VoiceFx {
    bitcrush: number;
    filterCutoff: number;
    filterResonance: number;
    drive: number;
    pan: number;
}

export interface VoiceCommand {
    type: 'note_on' | 'note_off' | 'update_fx';
    tick: number;
    voice?: NoteVoice;
    fx?: Partial<VoiceFx>;
}

export interface SchedulerCommand {
    voiceCommand: VoiceCommand;
}
