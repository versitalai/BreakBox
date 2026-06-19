// AudioWorklet types for TypeScript
// https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor

interface AudioWorkletProcessorOptions {
    numberOfInputs?: number;
    numberOfOutputs?: number;
    outputChannelCount?: number[];
    processorOptions?: Record<string, any>;
}

interface AudioWorkletProcessorConstructor {
    new (options: AudioWorkletProcessorOptions): AudioWorkletProcessor;
}

interface AudioWorkletProcessor {
    readonly port: MessagePort;
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare const AudioWorkletProcessor: AudioWorkletProcessorConstructor;

interface AudioWorkletGlobalScope extends WorkletGlobalScope {
    registerProcessor(name: string, processorCtor: AudioWorkletProcessorConstructor): void;
    currentFrame: number;
    currentTime: number;
    sampleRate: number;
}

interface WorkletGlobalScope extends EventTarget {
    // minimal
}

declare const registerProcessor: (name: string, processorCtor: AudioWorkletProcessorConstructor) => void;