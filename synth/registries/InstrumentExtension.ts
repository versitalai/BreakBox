// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Used by dsp.ts (computeTone, playTone) and model.ts (Instrument.extensions)
//   to provide a pluggable per-note extension system.
//
// Extensions can intercept note routing (producing additional or replacement voices)
// and perform per-instrument setup during the compute phase.

import { Instrument } from '../model';
import { Voice } from './VoiceTypes';

/**
 * Context passed to an extension's routeNote callback.
 */
export interface RouteNoteContext {
    tone: any; // Tone — using any to avoid circular import with dsp.ts
    instrument: Instrument;
    instrumentState: any; // InstrumentState
    defaultSynth: Function;
}

/**
 * Context passed to an extension's onCompute callback.
 */
export interface ComputeContext {
    instrument: Instrument;
    instrumentState: any; // InstrumentState
    channelIndex: number;
    instrumentIndex: number;
}

/**
 * A pluggable extension that can modify per-note rendering behavior.
 *
 * Extensions are attached to individual instruments (Instrument.extensions[])
 * and participate in two lifecycle phases:
 *
 * 1. onCompute — called during instrumentState.compute(), before tone rendering.
 *    Use for setup: loading samples, allocating buffers, etc.
 *
 * 2. routeNote — called during computeTone(), after pitch/expression computation.
 *    Returns an array of Voices that replace the default single-synth dispatch.
 *    Return null to use the default behavior.
 *
 * Serialization is per-extension: each extension writes its own data using
 * a unique tag code prefix.
 */
export interface InstrumentExtension {
    /** Unique identifier for this extension type. */
    readonly id: string;

    /**
     * Execution priority (higher = runs first). Extensions with the same
     * priority run in registration order. Default: 0.
     * Use negative values for "always last" extensions.
     */
    readonly priority?: number;

    /** Called once per synth render cycle, during instrumentState.compute(). */
    onCompute?: (ctx: ComputeContext) => void;

    /**
     * Called during computeTone() to produce voices for a note.
     * Return null to use the default single-synth behavior.
     * Return an empty array to silence the note entirely.
     */
    routeNote?: (ctx: RouteNoteContext) => Voice[] | null;

    /**
     * Serialize this extension's data for an instrument.
     * Returns an array of numbers to be written into the song buffer.
     * Return empty array if this extension has no data for the given instrument.
     */
    serialize?: (instrument: Instrument) => number[];

    /**
     * Deserialize this extension's data from a song buffer.
     * Returns the new buffer index after reading.
     */
    deserialize?: (instrument: Instrument, data: number[], index: number) => number;
}

/**
 * Registry for instrument extension types.
 *
 * Extensions self-register on import. The barrel module imports all
 * built-in extension modules, ensuring they're available for serialization
 * and deserialization.
 */
export class InstrumentExtensionRegistry {
    private extensions: Map<string, InstrumentExtension> = new Map();

    register(extension: InstrumentExtension): void {
        this.extensions.set(extension.id, extension);
    }

    get(id: string): InstrumentExtension | undefined {
        return this.extensions.get(id);
    }

    has(id: string): boolean {
        return this.extensions.has(id);
    }

    getAll(): InstrumentExtension[] {
        return Array.from(this.extensions.values());
    }

    /** Get all registered extension IDs in priority order (highest first). */
    getOrderedIds(): string[] {
        return Array.from(this.extensions.entries())
            .sort((a, b) => (b[1].priority ?? 0) - (a[1].priority ?? 0))
            .map(e => e[0]);
    }
}

/** Global instrument extension registry. */
export const instrumentExtensionRegistry: InstrumentExtensionRegistry = new InstrumentExtensionRegistry();
